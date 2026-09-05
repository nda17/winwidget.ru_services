import { randomUUID } from 'node:crypto';
import {
	ForbiddenException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	WidgetTransferProcessor,
	TransferOutcome
} from './widget-transfer.processor';
import {
	transferHash,
	WINCRM_TRANSFER_EVENT
} from './widget-transfer.contract';
import { IntakeService, inboxEntryView } from '../intake/intake.service';
import { WidgetTransferService } from './widget-transfer.service';

function setup() {
	const event = {
		schemaVersion: 1 as const,
		eventType: WINCRM_TRANSFER_EVENT as typeof WINCRM_TRANSFER_EVENT,
		eventId: randomUUID(),
		occurredAt: new Date(Date.now() - 1000).toISOString(),
		transferId: randomUUID(),
		connectorId: randomUUID(),
		generation: 1,
		workspaceId: randomUUID(),
		sourceId: randomUUID(),
		originalSubscriptionId: 'subscription',
		originalSubscriptionVersion: '1',
		originalPeriodStartsAt: new Date(Date.now() - 10000).toISOString(),
		originalDeadline: new Date(Date.now() + 60000).toISOString()
	};
	const source = {
		id: event.sourceId,
		workspaceId: event.workspaceId,
		connectorId: event.connectorId,
		createdBySubject: 'original-admin',
		ownerSubject: 'owner',
		teamId: null,
		enabled: true,
		generation: 1,
		widgetType: 'QUIZ',
		widgetId: 'widget'
	};
	const context = {
		schemaVersion: 1 as const,
		workspaceId: event.workspaceId,
		subject: source.createdBySubject,
		ownerSubject: source.ownerSubject,
		role: 'CRM_ADMIN' as const,
		state: 'ACTIVE' as const,
		dataScope: 'ALL' as const,
		teamIds: [],
		permissions: ['intake:read', 'intake:manage-sources']
	};
	const payload = {
		schemaVersion: 1,
		widget: {
			type: 'QUIZ',
			id: 'widget',
			name: 'Quiz',
			publishedVersion: 1
		},
		lead: {
			id: 'lead',
			createdAt: event.occurredAt,
			contactName: null,
			contactRaw: 'contact',
			phoneRaw: 'raw',
			phoneE164: null,
			email: 'not-an-email',
			pageUrl: null,
			redactions: []
		},
		details: { type: 'QUIZ', result: 'Typed result', answers: [] }
	};
	let receipt: Record<string, any> | null = null;
	const tx = {
		$executeRawUnsafe: jest.fn(),
		$queryRaw: jest
			.fn()
			.mockImplementation(() =>
				Promise.resolve([{ locked: true, now: new Date() }])
			),
		managedWidgetSource: {
			findUnique: jest.fn().mockImplementation(async () => source),
			findFirst: jest.fn().mockImplementation(async () => source)
		},
		widgetTransferReceipt: {
			findUnique: jest.fn().mockImplementation(async ({ where }) => {
				if (
					where.eventId_consumer &&
					receipt?.eventId !== where.eventId_consumer.eventId
				)
					return null;
				return receipt;
			}),
			findUniqueOrThrow: jest.fn().mockImplementation(async () => receipt),
			findFirst: jest
				.fn()
				.mockImplementation(async args =>
					receipt &&
					(!args.where.leaseToken ||
						args.where.leaseToken === receipt.leaseToken)
						? receipt
						: null
				),
			create: jest.fn().mockImplementation(async ({ data }) => {
				receipt = {
					...data,
					version: 1,
					retryAttempt: 0,
					retryGeneration: 0,
					lastErrorCode: null,
					entryId: null,
					auditCommandId: null,
					completedAt: null,
					createdAt: new Date(),
					updatedAt: new Date()
				};
				return receipt;
			}),
			updateMany: jest.fn().mockImplementation(async ({ data }) => {
				if (!receipt) return { count: 0 };
				const version = receipt.version;
				Object.assign(receipt, data, {
					version: version + 1,
					updatedAt: new Date()
				});
				if (data.retryGeneration?.increment) receipt.retryGeneration = 1;
				return { count: 1 };
			})
		},
		inboxEntry: {
			create: jest.fn().mockImplementation(async ({ data }) => data),
			findFirst: jest.fn()
		},
		widgetEntrySnapshot: { create: jest.fn(), findFirst: jest.fn() },
		intakeActivity: { create: jest.fn() },
		intakeCommand: {
			findUnique: jest.fn().mockResolvedValue(null),
			create: jest.fn()
		},
		widgetTransferOutbox: { create: jest.fn() }
	};
	const prisma = {
		...tx,
		$transaction: jest.fn().mockImplementation(async fn => fn(tx))
	};
	const auth = {
		authorizeWidgetSource: jest.fn().mockResolvedValue(context),
		authorize: jest.fn().mockResolvedValue(context)
	};
	const widgets = {
		context: jest.fn().mockResolvedValue({
			deliver: true,
			reason: 'READY',
			validUntil: new Date(Date.now() + 4000).toISOString(),
			payload
		})
	};
	return {
		event,
		source,
		context,
		payload,
		tx,
		prisma,
		auth,
		widgets,
		receipt: () => receipt,
		processor: new WidgetTransferProcessor(
			prisma as never,
			auth as never,
			widgets as never
		)
	};
}
describe('durable Widgets transfer boundary', () => {
	test('claims before context, writes only NEW with immutable snapshot/audit/proof, and duplicates perform no HTTP', async () => {
		const c = setup();
		const claim = await c.processor.claim(c.event);
		expect(claim.state).toBe('CLAIMED');
		if (claim.state !== 'CLAIMED') return;
		expect(c.tx.widgetTransferReceipt.create).toHaveBeenCalled();
		expect(c.widgets.context).not.toHaveBeenCalled();
		await c.processor.run(c.event, claim.token);
		expect(c.auth.authorizeWidgetSource).toHaveBeenCalledTimes(2);
		expect(c.auth.authorizeWidgetSource).toHaveBeenLastCalledWith(
			c.event.workspaceId,
			'original-admin'
		);
		expect(c.tx.inboxEntry.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				origin: 'WIDGET',
				sourceId: null,
				widgetSourceId: c.source.id,
				name: null,
				email: null,
				message: null
			})
		});
		expect(
			c.tx.widgetEntrySnapshot.create.mock.calls[0][0].data.payload
		).toEqual(c.payload);
		expect(c.receipt()).toMatchObject({
			status: 'DELIVERED',
			lastErrorCode: null,
			leaseToken: null
		});
		expect(c.tx.$executeRawUnsafe).toHaveBeenLastCalledWith(
			expect.stringContaining('IMMEDIATE')
		);
		expect(await c.processor.claim(c.event)).toEqual({ state: 'DONE' });
		expect(c.widgets.context).toHaveBeenCalledTimes(1);
	});
	test('parallel leased duplicate and binding collision cannot call context', async () => {
		const c = setup();
		await c.processor.claim(c.event);
		await expect(c.processor.claim(c.event)).rejects.toMatchObject({
			status: 503
		});
		await expect(
			c.processor.claim({ ...c.event, originalSubscriptionVersion: '2' })
		).rejects.toMatchObject({ status: 409 });
		expect(c.widgets.context).not.toHaveBeenCalled();
	});
	test('same transfer under another event is quarantinable conflict, not an endless unique-key retry', async () => {
		const c = setup();
		await c.processor.claim(c.event);
		await expect(
			c.processor.claim({ ...c.event, eventId: randomUUID() })
		).rejects.toMatchObject({ status: 409 });
		expect(c.tx.widgetTransferReceipt.create).toHaveBeenCalledTimes(1);
		expect(c.widgets.context).not.toHaveBeenCalled();
	});
	test('heartbeat uses a short transaction with explicit deferred proof verification', async () => {
		const c = setup();
		const claim = await c.processor.claim(c.event);
		if (claim.state !== 'CLAIMED') return;
		c.prisma.$transaction.mockClear();
		await expect(c.processor.renew(c.event, claim.token)).resolves.toBe(
			true
		);
		expect(c.prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(c.tx.$executeRawUnsafe).toHaveBeenLastCalledWith(
			expect.stringContaining('IMMEDIATE')
		);
	});
	test.each(['disable', 'generation', 'expiry'])(
		'%s blocks new delivery before external context',
		async mode => {
			const c = setup();
			const claim = await c.processor.claim(c.event);
			if (claim.state !== 'CLAIMED') return;
			if (mode === 'disable') c.source.enabled = false;
			if (mode === 'generation') c.source.generation = 2;
			if (mode === 'expiry') {
				c.event.originalDeadline = new Date(Date.now() - 1).toISOString();
				c.receipt()!.payloadHash = transferHash(c.event);
			}
			await expect(
				c.processor.run(c.event, claim.token)
			).rejects.toBeInstanceOf(TransferOutcome);
			expect(c.widgets.context).not.toHaveBeenCalled();
			expect(c.tx.inboxEntry.create).not.toHaveBeenCalled();
		}
	);
	test('revocation before context and after context each prohibit insert', async () => {
		for (const after of [false, true]) {
			const c = setup();
			const claim = await c.processor.claim(c.event);
			if (claim.state !== 'CLAIMED') continue;
			if (after)
				c.auth.authorizeWidgetSource
					.mockResolvedValueOnce(c.context)
					.mockRejectedValueOnce(new ForbiddenException());
			else
				c.auth.authorizeWidgetSource.mockRejectedValue(
					new ForbiddenException()
				);
			await expect(
				c.processor.run(c.event, claim.token)
			).rejects.toMatchObject({ status: 403 });
			expect(c.tx.inboxEntry.create).not.toHaveBeenCalled();
		}
	});
	test('disable during context is rechecked under own source lock', async () => {
		const c = setup();
		const claim = await c.processor.claim(c.event);
		if (claim.state !== 'CLAIMED') return;
		c.widgets.context.mockImplementationOnce(async () => {
			c.source.enabled = false;
			return {
				deliver: true,
				reason: 'READY',
				payload: c.payload,
				validUntil: new Date(Date.now() + 4000).toISOString()
			};
		});
		await expect(
			c.processor.run(c.event, claim.token)
		).rejects.toMatchObject({ code: 'LOCAL_DISABLED' });
		expect(c.tx.$queryRaw).toHaveBeenCalled();
		expect(c.tx.inboxEntry.create).not.toHaveBeenCalled();
	});
	test('expired context cannot write even after successful authorization', async () => {
		const c = setup();
		const claim = await c.processor.claim(c.event);
		if (claim.state !== 'CLAIMED') return;
		c.widgets.context.mockResolvedValue({
			...c.widgets.context.getMockImplementation(),
			deliver: true,
			payload: c.payload,
			validUntil: new Date(Date.now() - 1).toISOString()
		});
		await expect(
			c.processor.run(c.event, claim.token)
		).rejects.toMatchObject({ status: 503 });
		expect(c.tx.inboxEntry.create).not.toHaveBeenCalled();
	});
	test('retry and DLQ are committed beside failed receipt, without storing contact payload', async () => {
		const c = setup();
		const claim = await c.processor.claim(c.event);
		if (claim.state !== 'CLAIMED') return;
		const databaseNow = new Date('2026-01-01T00:00:00.000Z');
		c.tx.$queryRaw.mockResolvedValue([{ now: databaseNow }]);
		expect(
			await c.processor.fail(
				c.event,
				claim.token,
				0,
				new ServiceUnavailableException()
			)
		).toBe(true);
		expect(c.receipt()).toMatchObject({
			status: 'RETRY_PENDING',
			retryAttempt: 1
		});
		expect(c.tx.widgetTransferOutbox.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				route: 'MAIN',
				payload: c.event,
				retryAttempt: 1,
				availableAt: new Date(databaseNow.getTime() + 5000)
			})
		});
		expect(
			JSON.stringify(c.tx.widgetTransferOutbox.create.mock.calls)
		).not.toContain('contact');
		expect(await c.processor.claim(c.event, 0)).toEqual({ state: 'DONE' });
		const retry = await c.processor.claim(c.event, 1);
		if (retry.state !== 'CLAIMED') return;
		await c.processor.fail(
			c.event,
			retry.token,
			1,
			new ForbiddenException()
		);
		expect(c.receipt()).toMatchObject({
			status: 'BLOCKED',
			lastErrorCode: 'DELEGATION_REVOKED'
		});
		expect(c.tx.widgetTransferOutbox.create).toHaveBeenLastCalledWith({
			data: expect.objectContaining({ route: 'DLQ' })
		});
	});
	test('terminal skip is durable with no new retry event', async () => {
		const c = setup();
		const claim = await c.processor.claim(c.event);
		if (claim.state !== 'CLAIMED') return;
		await c.processor.fail(
			c.event,
			claim.token,
			0,
			new TransferOutcome('SKIPPED', 'PERIOD_EXPIRED')
		);
		expect(c.receipt()).toMatchObject({
			status: 'SKIPPED',
			entryId: null
		});
		expect(c.tx.widgetTransferOutbox.create).not.toHaveBeenCalled();
	});
	test('manual retry keeps original event/delegate, adds global receipt and returns historical command', async () => {
		const c = setup();
		const env = process.env;
		process.env = {
			...env,
			CRM_INTAKE_WIDGETS_ENABLED: 'true',
			CRM_INTAKE_WIDGET_TRANSFERS_ENABLED: 'true'
		};
		try {
			const claim = await c.processor.claim(c.event);
			if (claim.state !== 'CLAIMED') return;
			await c.processor.fail(
				c.event,
				claim.token,
				0,
				new ForbiddenException()
			);
			const service = new WidgetTransferService(
				c.prisma as never,
				c.auth as never
			);
			const dto = {
				schemaVersion: 1 as const,
				workspaceId: c.event.workspaceId,
				commandId: randomUUID(),
				expectedVersion: c.receipt()!.version
			};
			await service.retry('Bearer', c.source.id, c.event.transferId, dto);
			expect(c.receipt()).toMatchObject({
				actorSubject: 'original-admin',
				retryGeneration: 1,
				status: 'RETRY_PENDING'
			});
			expect(
				c.tx.intakeCommand.create.mock.calls[0][0].data.entityKind
			).toBe('widget-transfer');
			expect(c.tx.widgetTransferOutbox.create).toHaveBeenLastCalledWith({
				data: expect.objectContaining({
					payload: c.event,
					retryGeneration: 1,
					route: 'MAIN'
				})
			});
		} finally {
			process.env = env;
		}
	});
	test('details use own stored snapshot with read scope, no Widgets reauthorization', async () => {
		const c = setup();
		const id = randomUUID();
		const entry = {
			id,
			workspaceId: c.event.workspaceId,
			origin: 'WIDGET',
			widgetSourceId: c.source.id,
			sourceId: null,
			name: null,
			createdBySubject: 'original-admin',
			receivedAt: new Date(),
			updatedAt: new Date(),
			acceptedAt: null,
			rejectedAt: null
		};
		c.tx.inboxEntry.findFirst.mockResolvedValue(entry);
		c.tx.widgetEntrySnapshot.findFirst.mockResolvedValue({
			payload: c.payload,
			payloadHash: transferHash(c.payload),
			byteCount: Buffer.byteLength(JSON.stringify(c.payload))
		});
		const service = new IntakeService(c.prisma as never);
		const result = await service.widgetDetails(
			{ ...c.context, state: 'READ_ONLY' },
			c.event.workspaceId,
			id
		);
		expect(result).toMatchObject({
			sourceId: c.source.id,
			payload: c.payload
		});
		expect(inboxEntryView(entry as never).sourceId).toBe(c.source.id);
		expect(c.auth.authorizeWidgetSource).not.toHaveBeenCalled();
		c.tx.inboxEntry.findFirst.mockResolvedValue(null);
		await expect(
			service.widgetDetails(c.context, c.event.workspaceId, id)
		).rejects.toMatchObject({ status: 404 });
	});
});
