import {
	BadRequestException,
	ConflictException,
	NotFoundException
} from '@nestjs/common';
import { PrismaClient } from '@prisma/support-client';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Request } from 'express';
import type { SupportActor } from '../auth/support-request';
import type { SupportPrismaService } from '../prisma/support-prisma.service';
import { SupportConversationsService } from './support-conversations.service';
import { SupportNotificationsService } from './support-notifications.service';
import { SupportWebIdentityClient } from './support-web-identity.client';
import { SupportOutcomeWorkerService } from './support-outcome-worker.service';
import { SupportMessagingAdminService } from '../messaging/support-messaging-admin.service';
import { hashSupport } from './support-web.util';
import { SupportAttachmentsService } from './support-attachments.service';
import { SupportAttachmentStorageService } from './support-attachment-storage.service';
import type { SupportRuntimeService } from '../runtime/support-runtime.service';
import type { SupportRabbitMqService } from '../messaging/support-rabbitmq.service';

const enabled = process.env.SUPPORT_TEST_ALLOW_MUTATION === 'true';
const integration = enabled ? describe : describe.skip;
integration('Support web PostgreSQL transaction integration', () => {
	let prisma: PrismaClient;
	let service: SupportConversationsService;
	let notifications: SupportNotificationsService;
	const suffix = randomUUID();
	const actor: SupportActor = {
		active: true,
		subject: `support-test-${suffix}`,
		sessionId: randomUUID(),
		roles: ['USER']
	};
	const other: SupportActor = {
		...actor,
		subject: `support-other-${suffix}`
	};
	const operator: SupportActor = {
		...actor,
		subject: `support-operator-${suffix}`,
		roles: ['ADMIN']
	};
	const request = {
		headers: { authorization: 'Bearer integration-session' },
		socket: { remoteAddress: '127.0.0.1' },
		get: () => undefined
	} as unknown as Request;
	const identity = {
		author: jest.fn(
			async (_authorization: string, workspaceId?: string) => ({
				schemaVersion: 1,
				subject: actor.subject,
				role: 'USER',
				name: 'Test author',
				workspace: workspaceId
					? { id: workspaceId, membershipId: randomUUID() }
					: null
			})
		),
		company: jest.fn(async () => 'Test company'),
		recipient: jest.fn(async (subject: string) => ({
			schemaVersion: 1,
			subject,
			active: true,
			verifiedEmail: 'client@example.invalid'
		}))
	};
	const createDto = () => ({
		commandId: randomUUID(),
		expectedActorSubject: actor.subject,
		draftId: randomUUID(),
		subject: 'Integration question',
		text: 'First message',
		section: 'inbox',
		appVersion: 'integration',
		attachmentIds: [] as string[]
	});
	beforeAll(async () => {
		for (const key of [
			'SUPPORT_TEST_DATABASE_URL',
			'SUPPORT_TEST_MIGRATION_DATABASE_URL'
		]) {
			const url = new URL(process.env[key] || '');
			if (
				!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
				!/^\/(?:support_web_test|support_test|support_ci|winwidget_support_test_ci)$/.test(
					url.pathname
				)
			)
				throw new Error(
					'Support integration requires an isolated loopback test database'
				);
		}
		if (process.env.SUPPORT_TEST_SKIP_MIGRATIONS !== 'true') {
			const child = spawnSync(
				process.execPath,
				[
					require.resolve('prisma/build/index.js'),
					'migrate',
					'deploy',
					'--schema',
					'prisma/schema.prisma'
				],
				{
					cwd: process.cwd(),
					env: {
						...process.env,
						SUPPORT_DATABASE_URL:
							process.env.SUPPORT_TEST_MIGRATION_DATABASE_URL
					},
					encoding: 'utf8',
					timeout: 60000
				}
			);
			if (child.status !== 0)
				throw new Error('Support test migrations failed');
		}
		prisma = new PrismaClient({
			datasources: { db: { url: process.env.SUPPORT_TEST_DATABASE_URL } }
		});
		const version = await prisma.$queryRawUnsafe<
			Array<{ version: string }>
		>("SELECT current_setting('server_version') AS version");
		if (!version[0].version.startsWith('18.'))
			throw new Error('Support integration requires PostgreSQL 18');
		notifications = new SupportNotificationsService(
			prisma as unknown as SupportPrismaService,
			identity as unknown as SupportWebIdentityClient
		);
		service = new SupportConversationsService(
			prisma as unknown as SupportPrismaService,
			identity as unknown as SupportWebIdentityClient,
			notifications
		);
		await prisma.supportNotificationSettings.update({
			where: { id: 'singleton' },
			data: {
				enabled: true,
				emailEnabled: true,
				staffEmails: ['staff@example.invalid'],
				telegramEnabled: true,
				telegramChatId: '-100123456',
				telegramThreadId: 2,
				clientEmailEnabled: true
			}
		});
	}, 90000);
	afterAll(async () => {
		await prisma?.$disconnect();
	});

	it('persists once under concurrent creation/replay and commits ID-only notification Outbox atomically', async () => {
		const dto = createDto();
		const results = await Promise.all([
			service.create(dto, actor, request),
			service.create(dto, actor, request)
		]);
		expect(results[0]).toEqual(results[1]);
		const id = results[0].conversation.id;
		expect(
			await prisma.supportMessage.count({ where: { conversationId: id } })
		).toBe(1);
		expect(
			await prisma.supportNotificationIntent.count({
				where: { conversationId: id }
			})
		).toBe(2);
		const intents = await prisma.supportNotificationIntent.findMany({
			where: { conversationId: id }
		});
		const events = await prisma.outboxEvent.findMany({
			where: { messageId: { in: intents.map(row => row.eventId) } }
		});
		expect(events).toHaveLength(2);
		for (const event of events) {
			expect(JSON.stringify(event.payload)).not.toMatch(
				/First message|staff@example|Integration question|-100123/
			);
			expect(event.availableAt.getTime()).toBeGreaterThan(
				intents[0].windowAt.getTime()
			);
		}
		await expect(
			service.create({ ...dto, text: 'Different payload' }, actor, request)
		).rejects.toBeInstanceOf(ConflictException);
		expect(await service.recover(dto.commandId, actor)).toMatchObject({
			state: 'COMPLETED',
			conversationId: id
		});
		expect(await service.recover(dto.commandId, other)).toMatchObject({
			state: 'NOT_FOUND'
		});
	});
	it('enforces author isolation, stable sequences, monotonic reads and status CAS during concurrent replies', async () => {
		const created = await service.create(createDto(), actor, request);
		const id = created.conversation.id;
		await expect(service.detail(id, other)).rejects.toBeInstanceOf(
			NotFoundException
		);
		await expect(
			service.history(id, { limit: 50 }, other)
		).rejects.toBeInstanceOf(NotFoundException);
		await expect(service.read(id, 1, other)).rejects.toBeInstanceOf(
			NotFoundException
		);
		const reply = (text: string) => ({
			commandId: randomUUID(),
			expectedActorSubject: actor.subject,
			text,
			attachmentIds: []
		});
		await Promise.all([
			service.reply(id, reply('Second'), actor, request),
			service.reply(id, reply('Third'), actor, request)
		]);
		const first = await service.history(id, { limit: 2 }, actor);
		expect(first.items.map(row => row.sequence)).toEqual([2, 3]);
		expect(first.hasMore).toBe(true);
		const older = await service.history(
			id,
			{ limit: 2, beforeSequence: 2 },
			actor
		);
		expect(older.items.map(row => row.sequence)).toEqual([1]);
		await Promise.all([
			service.read(id, 3, operator, true),
			service.read(id, 1, operator, true)
		]);
		expect(await service.read(id, 0, operator, true)).toEqual({
			throughSequence: 3
		});
		await expect(service.read(id, 100, actor)).rejects.toBeInstanceOf(
			BadRequestException
		);
		const old = await service.detail(id, operator, true);
		await service.status(
			id,
			{
				commandId: randomUUID(),
				expectedActorSubject: operator.subject,
				expectedVersion: old.version,
				status: 'RESOLVED'
			},
			operator,
			request
		);
		await service.reply(id, reply('Reopen'), actor, request);
		expect((await service.detail(id, actor)).status).toBe('IN_PROGRESS');
		await expect(
			service.status(
				id,
				{
					commandId: randomUUID(),
					expectedActorSubject: operator.subject,
					expectedVersion: old.version,
					status: 'RESOLVED'
				},
				operator,
				request
			)
		).rejects.toBeInstanceOf(ConflictException);
		const state = await service.detail(id, operator, true);
		expect(state.unreadCount).toBe(1);
	});
	it('rolls back message, command and notifications when attachment admission fails', async () => {
		const created = await service.create(createDto(), actor, request);
		const id = created.conversation.id;
		const before = await service.detail(id, actor);
		const dto = {
			commandId: randomUUID(),
			expectedActorSubject: actor.subject,
			text: 'Must roll back',
			attachmentIds: [randomUUID()]
		};
		await expect(
			service.reply(id, dto, actor, request)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(await service.detail(id, actor)).toEqual(before);
		expect(await service.recover(dto.commandId, actor)).toMatchObject({
			state: 'NOT_FOUND'
		});
		expect(
			await prisma.supportMessage.count({ where: { conversationId: id } })
		).toBe(1);
	});
	it('keeps replies after recipient/delivery failure and applies duplicate outcome once', async () => {
		const created = await service.create(createDto(), actor, request);
		const id = created.conversation.id;
		identity.author.mockImplementationOnce(async () => ({
			schemaVersion: 1,
			subject: operator.subject,
			role: 'ADMIN',
			name: 'Operator',
			workspace: null
		}));
		const reply = await service.reply(
			id,
			{
				commandId: randomUUID(),
				expectedActorSubject: operator.subject,
				text: 'Operator answer',
				attachmentIds: []
			},
			operator,
			request,
			true
		);
		expect(reply.message.senderName).toBe('Специалист поддержки');
		expect(
			await prisma.supportMessage.findUniqueOrThrow({
				where: { id: reply.message.id }
			})
		).toMatchObject({
			senderName: 'Специалист поддержки',
			senderSubject: operator.subject
		});
		const intent = await prisma.supportNotificationIntent.findFirstOrThrow(
			{ where: { conversationId: id, kind: 'support-client-email' } }
		);
		identity.recipient.mockRejectedValueOnce(
			new Error('Identity unavailable')
		);
		await expect(
			notifications.deliveryContext(
				intent.id,
				intent.eventId,
				'support-client-email'
			)
		).rejects.toThrow('Identity unavailable');
		expect((await service.detail(id, actor)).unreadCount).toBe(1);
		expect(
			(await service.history(id, { limit: 50 }, actor)).items.at(-1)?.id
		).toBe(reply.message.id);
		const rabbit = { ack: jest.fn(), nack: jest.fn() };
		const worker = new SupportOutcomeWorkerService(
			prisma as unknown as SupportPrismaService,
			{} as SupportRuntimeService,
			rabbit as unknown as SupportRabbitMqService
		);
		const event = {
			schemaVersion: 1,
			eventId: randomUUID(),
			eventType: 'support.notification.delivery.outcome.v1',
			occurredAt: new Date().toISOString(),
			sourceEventId: intent.eventId,
			sourceKind: intent.kind,
			intentId: intent.id,
			status: 'DELIVERED',
			reason: null
		};
		const message = {
			content: Buffer.from(JSON.stringify(event)),
			properties: {
				messageId: event.eventId,
				type: event.eventType,
				headers: {}
			},
			fields: { routingKey: event.eventType }
		};
		await worker.handle(message as any);
		await worker.handle(message as any);
		expect(rabbit.ack).toHaveBeenCalledTimes(2);
		expect(rabbit.nack).not.toHaveBeenCalled();
		expect(
			await prisma.consumerReceipt.count({
				where: {
					eventId: event.eventId,
					consumer: 'support-notification-outcome'
				}
			})
		).toBe(1);
		expect(
			(
				await prisma.supportNotificationIntent.findUniqueOrThrow({
					where: { id: intent.id }
				})
			).status
		).toBe('DELIVERED');
		// A known typed outcome with a temporarily missing intent reaches its own
		// retry/DLQ, then recovers through the existing admin dispatcher.
		const delayed = {
			...event,
			eventId: randomUUID(),
			intentId: randomUUID(),
			sourceEventId: randomUUID()
		};
		for (let attempt = 0; attempt <= 3; attempt++)
			await worker.handle({
				content: Buffer.from(JSON.stringify(delayed)),
				properties: {
					messageId: delayed.eventId,
					type: delayed.eventType,
					headers: { 'x-retry-attempt': attempt }
				},
				fields: { routingKey: delayed.eventType }
			} as any);
		const failure = await prisma.consumerFailure.findUniqueOrThrow({
			where: {
				eventId_consumer: {
					eventId: delayed.eventId,
					consumer: 'support-notification-outcome'
				}
			}
		});
		expect(failure.status).toBe('OPEN');
		expect(
			await prisma.outboxEvent.count({
				where: {
					messageId: delayed.eventId,
					exchange: { in: ['RETRY', 'DEAD_LETTER'] }
				}
			})
		).toBe(4);
		await prisma.supportNotificationIntent.create({
			data: {
				id: delayed.intentId,
				eventId: delayed.sourceEventId,
				conversationId: id,
				kind: intent.kind,
				notificationType: 'OPERATOR_REPLY',
				recipientSubject: actor.subject,
				settingsVersion: intent.settingsVersion,
				groupKey: hashSupport(delayed.intentId),
				firstSequence: reply.message.sequence,
				lastSequence: reply.message.sequence,
				windowAt: new Date()
			}
		});
		const messaging = new SupportMessagingAdminService(
			prisma as unknown as SupportPrismaService,
			worker
		);
		await messaging.retry(failure.id, operator, request);
		await worker.handle({
			content: Buffer.from(JSON.stringify(delayed)),
			properties: {
				messageId: delayed.eventId,
				type: delayed.eventType,
				headers: { 'x-retry-attempt': 0, 'x-manual-retry-cycle': 1 }
			},
			fields: { routingKey: 'support-notification-outcome' }
		} as any);
		expect(
			(
				await prisma.consumerFailure.findUniqueOrThrow({
					where: { id: failure.id }
				})
			).status
		).toBe('RESOLVED');
		expect(
			(
				await prisma.supportNotificationIntent.findUniqueOrThrow({
					where: { id: delayed.intentId }
				})
			).status
		).toBe('DELIVERED');
		expect(rabbit.nack).not.toHaveBeenCalled();
	});
	it('serializes attachment activation against cleanup and never exposes another authors file', async () => {
		const storage = {
			prepare: jest.fn(async () => ({
				body: Buffer.from('image'),
				mediaType: 'image/png',
				width: 1,
				height: 1,
				byteSize: 5,
				fileName: 'image.png',
				contentHash: 'a'.repeat(64),
				sourceHash: 'b'.repeat(64)
			})),
			put: jest.fn(async () => undefined),
			delete: jest.fn(async () => undefined),
			get: jest.fn()
		};
		const attachments = new SupportAttachmentsService(
			prisma as unknown as SupportPrismaService,
			service,
			storage as unknown as SupportAttachmentStorageService,
			{} as SupportRuntimeService
		);
		const draft = createDto();
		const upload = {
			commandId: randomUUID(),
			expectedActorSubject: actor.subject,
			draftId: draft.draftId
		};
		const file = await attachments.upload(upload, undefined, actor);
		expect(await attachments.upload(upload, undefined, actor)).toEqual(
			file
		);
		expect(storage.put).toHaveBeenCalledTimes(1);
		await expect(
			attachments.content(file.id, other, {} as any)
		).rejects.toBeInstanceOf(NotFoundException);
		expect(storage.get).not.toHaveBeenCalled();
		const created = await service.create(
			{ ...draft, attachmentIds: [file.id] },
			actor,
			request
		);
		expect(created.message.attachments[0].id).toBe(file.id);
		await expect(
			attachments.remove(file.id, actor)
		).rejects.toBeInstanceOf(BadRequestException);
		await prisma.supportAttachment.update({
			where: { id: file.id },
			data: { expiresAt: new Date(0) }
		});
		await attachments.cleanup();
		expect(storage.delete).not.toHaveBeenCalled();
	});
});
