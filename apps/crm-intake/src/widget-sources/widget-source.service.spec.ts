import { ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WidgetSourceService } from './widget-source.service';
import { WidgetControlProcessor } from './widget-control.processor';
import { WidgetsControlDependencyError } from './widgets-control.client';
const workspaceId = randomUUID(),
	sourceId = randomUUID(),
	commandId = randomUUID(),
	eventId = randomUUID();
const actor = {
	schemaVersion: 1,
	workspaceId,
	subject: 'original-admin',
	role: 'CRM_ADMIN',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['intake:read', 'intake:manage-sources']
};
function setup() {
	const source = {
		id: sourceId,
		workspaceId,
		name: 'Source',
		ownerSubject: 'canonical-owner',
		widgetType: 'QUIZ',
		widgetId: 'opaque-widget',
		connectorId: randomUUID(),
		createdBySubject: actor.subject,
		teamId: null,
		version: 1,
		controlVersion: 1,
		generation: 1,
		enabled: true,
		currentCommandId: commandId,
		appliedControlVersion: null,
		appliedGeneration: null,
		syncState: 'PENDING',
		lastErrorCode: null,
		syncedAt: null,
		createdAt: new Date(),
		updatedAt: new Date()
	};
	const job = {
		commandId,
		workspaceId,
		sourceId,
		connectorId: source.connectorId,
		ownerSubject: source.ownerSubject,
		actorSubject: actor.subject,
		requestedBySubject: actor.subject,
		widgetType: 'QUIZ',
		widgetId: source.widgetId,
		controlVersion: 1,
		generation: 1,
		enabled: true,
		status: 'PROCESSING',
		leaseToken: randomUUID(),
		leaseUntil: new Date(Date.now() + 30000),
		activeEventId: eventId
	};
	const tx = {
		$executeRawUnsafe: jest.fn(),
		$queryRaw: jest
			.fn()
			.mockResolvedValue([
				{ locked: true, now: new Date('2030-01-01T00:00:00.000Z') }
			]),
		managedWidgetSource: {
			findFirst: jest.fn().mockResolvedValue(source),
			findUnique: jest.fn().mockResolvedValue(source),
			findUniqueOrThrow: jest.fn().mockResolvedValue(source),
			create: jest.fn().mockResolvedValue(source),
			updateMany: jest.fn().mockResolvedValue({ count: 1 }),
			update: jest.fn().mockResolvedValue(source)
		},
		widgetControlJob: {
			findUnique: jest.fn().mockResolvedValue(job),
			findFirst: jest.fn().mockResolvedValue(job),
			create: jest.fn(),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		widgetControlReceipt: {
			findUnique: jest.fn().mockResolvedValue(null),
			create: jest.fn(),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		widgetControlOutbox: { create: jest.fn() },
		intakeCommand: {
			findUnique: jest.fn().mockResolvedValue(null),
			create: jest.fn()
		},
		intakeActivity: { create: jest.fn() }
	};
	const prisma = { ...tx, $transaction: jest.fn(async fn => fn(tx)) };
	const authorization = {
		authorize: jest.fn().mockResolvedValue(actor),
		authorizeWidgetSource: jest
			.fn()
			.mockResolvedValue({ ...actor, ownerSubject: 'canonical-owner' })
	};
	const widgets = {
		configure: jest.fn().mockResolvedValue({
			schemaVersion: 1,
			connector: {
				...source,
				id: source.connectorId,
				sourceId: source.id
			}
		}),
		candidates: jest.fn()
	};
	const service = new WidgetSourceService(
		prisma as never,
		authorization as never,
		widgets as never,
		{ enabled: true } as never
	);
	const processor = new WidgetControlProcessor(
		prisma as never,
		authorization as never,
		widgets as never
	);
	const event = {
		schemaVersion: 1 as const,
		eventId,
		workspaceId,
		sourceId,
		commandId,
		controlVersion: 1,
		generation: 1
	};
	return {
		source,
		job,
		tx,
		prisma,
		authorization,
		widgets,
		service,
		processor,
		event
	};
}
describe('Managed widget source control plane', () => {
	test('creation stores canonical owner and source delegation with common namespace receipt+audit+Outbox', async () => {
		const { service, tx } = setup();
		const dto = {
			schemaVersion: 1 as const,
			workspaceId,
			commandId: randomUUID(),
			name: ' Source ',
			widgetType: 'QUIZ' as const,
			widgetId: 'opaque-widget',
			teamId: null
		};
		const result = await service.create('Bearer user', dto);
		expect(result).toMatchObject({
			schemaVersion: 1,
			command: { id: dto.commandId, state: 'QUEUED' }
		});
		expect(tx.managedWidgetSource.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				ownerSubject: 'canonical-owner',
				createdBySubject: actor.subject
			})
		});
		expect(JSON.stringify(tx.$queryRaw.mock.calls)).toContain(
			'crm-intake:command:' + dto.commandId
		);
		expect(tx.intakeCommand.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				entityKind: 'widget-source',
				actorSubject: actor.subject
			})
		});
		expect(tx.intakeActivity.create).toHaveBeenCalled();
		expect(tx.widgetControlOutbox.create).toHaveBeenCalled();
		expect(tx.$executeRawUnsafe).toHaveBeenLastCalledWith(
			expect.stringContaining('SET CONSTRAINTS')
		);
	});
	test.each(['entry', 'source', 'import'])(
		'UUID collision with existing %s command is not a separate namespace',
		async entityKind => {
			const { service, tx } = setup();
			tx.intakeCommand.findUnique.mockResolvedValue({
				workspaceId,
				actorSubject: actor.subject,
				entityKind,
				requestHash: 'other'
			} as never);
			await expect(
				service.create('Bearer user', {
					schemaVersion: 1,
					workspaceId,
					commandId,
					name: 'Source',
					widgetType: 'QUIZ',
					widgetId: 'widget',
					teamId: null
				})
			).rejects.toMatchObject({ status: 409 });
			expect(tx.managedWidgetSource.create).not.toHaveBeenCalled();
			expect(tx.widgetControlOutbox.create).not.toHaveBeenCalled();
		}
	);
	test('disable is immediately local and does not require delegated-owner RPC', async () => {
		const { service, tx, authorization } = setup();
		await service.configure('Bearer user', sourceId, {
			schemaVersion: 1,
			workspaceId,
			commandId: randomUUID(),
			expectedVersion: 1,
			enabled: false
		});
		expect(authorization.authorizeWidgetSource).not.toHaveBeenCalled();
		expect(tx.managedWidgetSource.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: sourceId, workspaceId, version: 1 },
				data: expect.objectContaining({
					enabled: false,
					generation: 1,
					controlVersion: { increment: 1 }
				})
			})
		);
	});
	test('reenable advances generation and keeps original delegate, not current admin', async () => {
		const { service, source, authorization, tx } = setup();
		source.enabled = false;
		authorization.authorize.mockResolvedValue({
			...actor,
			subject: 'another-admin'
		});
		await service.configure('Bearer user', sourceId, {
			schemaVersion: 1,
			workspaceId,
			commandId: randomUUID(),
			expectedVersion: 1,
			enabled: true
		});
		expect(authorization.authorizeWidgetSource).toHaveBeenCalledWith(
			workspaceId,
			'original-admin'
		);
		expect(tx.managedWidgetSource.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ generation: 2 })
			})
		);
	});
	test('changed owner and stale source version fail before command side effects', async () => {
		const { service, authorization, tx } = setup();
		authorization.authorizeWidgetSource.mockResolvedValue({
			...actor,
			ownerSubject: 'changed'
		});
		await expect(
			service.configure('Bearer user', sourceId, {
				schemaVersion: 1,
				workspaceId,
				commandId: randomUUID(),
				expectedVersion: 1,
				enabled: true
			})
		).rejects.toMatchObject({ status: 403 });
		expect(tx.widgetControlOutbox.create).not.toHaveBeenCalled();
		await expect(
			service.configure('Bearer user', sourceId, {
				schemaVersion: 1,
				workspaceId,
				commandId: randomUUID(),
				expectedVersion: 2,
				enabled: false
			})
		).rejects.toMatchObject({ status: 409 });
	});
	test('READ_ONLY manager controls denied while owner/admin source read stays accessible', async () => {
		const { service, authorization } = setup();
		authorization.authorize.mockResolvedValue({
			...actor,
			state: 'READ_ONLY',
			permissions: ['intake:read']
		});
		await expect(
			service.get('Bearer user', workspaceId, sourceId)
		).resolves.toHaveProperty('source.id', sourceId);
		await expect(
			service.configure('Bearer user', sourceId, {
				schemaVersion: 1,
				workspaceId,
				commandId: randomUUID(),
				expectedVersion: 1,
				enabled: false
			})
		).rejects.toMatchObject({ status: 403 });
	});
	test('candidates retain ineligible real widgets but redact other workspace bindings', async () => {
		const { service, widgets } = setup();
		widgets.candidates.mockResolvedValue({
			page: 1,
			pageSize: 25,
			total: 1,
			eligibility: {
				eligible: false,
				reason: 'EXPIRED',
				plan: 'EASY',
				startsAt: null,
				expiresAt: null,
				checkedAt: 'date',
				validUntil: 'date'
			},
			items: [
				{
					widgetId: 'widget',
					widgetType: 'QUIZ',
					name: 'Widget',
					isActive: true,
					publishedVersion: 1,
					createdAt: 'date',
					connector: { workspaceId: randomUUID(), sourceId: randomUUID() }
				}
			]
		});
		const result = await service.candidates('Bearer user', {
			workspaceId,
			page: 1,
			pageSize: 25
		});
		expect(result.items[0]).toMatchObject({
			connection: 'OTHER_WORKSPACE',
			sourceId: null
		});
		expect(result.eligibility.eligible).toBe(false);
		expect(Object.keys(result.items[0])).not.toContain('connector');
	});
});
describe('Managed source fresh configure worker', () => {
	test('enable uses fresh original actor, then scoped configure, then durable exact acknowledgment', async () => {
		const { processor, event, job, authorization, widgets, tx } = setup();
		await processor.run(event, job.leaseToken);
		expect(authorization.authorizeWidgetSource).toHaveBeenCalledWith(
			workspaceId,
			'original-admin'
		);
		expect(widgets.configure).toHaveBeenCalledWith(
			job.connectorId,
			expect.objectContaining({
				commandId,
				ownerSubject: 'canonical-owner',
				enabled: true
			})
		);
		expect(tx.widgetControlJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: 'APPLIED' })
			})
		);
		expect(tx.managedWidgetSource.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					currentCommandId: commandId,
					controlVersion: 1,
					generation: 1
				})
			})
		);
	});
	test('technical disable converges even if original delegation is no longer active', async () => {
		const { processor, event, job, source, authorization, widgets } =
			setup();
		job.enabled = false;
		source.enabled = false;
		authorization.authorizeWidgetSource.mockRejectedValue(
			new ForbiddenException()
		);
		await processor.run(event, job.leaseToken);
		expect(authorization.authorizeWidgetSource).not.toHaveBeenCalled();
		expect(widgets.configure).toHaveBeenCalledWith(
			job.connectorId,
			expect.objectContaining({ enabled: false })
		);
	});
	test('disabled/superseded local desired state stops an old enable before HTTP', async () => {
		const { processor, event, job, source, widgets, tx } = setup();
		source.currentCommandId = randomUUID();
		source.controlVersion = 2;
		source.enabled = false;
		await processor.run(event, job.leaseToken);
		expect(widgets.configure).not.toHaveBeenCalled();
		expect(tx.widgetControlJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: 'SUPERSEDED' })
			})
		);
		expect(tx.managedWidgetSource.updateMany).not.toHaveBeenCalled();
	});
	test('fresh revocation or changed canonical owner prevents RPC', async () => {
		const { processor, event, job, authorization, widgets } = setup();
		authorization.authorizeWidgetSource.mockRejectedValueOnce(
			new ForbiddenException()
		);
		await expect(
			processor.run(event, job.leaseToken)
		).rejects.toMatchObject({ status: 403 });
		expect(widgets.configure).not.toHaveBeenCalled();
		authorization.authorizeWidgetSource.mockResolvedValue({
			...actor,
			ownerSubject: 'changed'
		});
		await expect(
			processor.run(event, job.leaseToken)
		).rejects.toMatchObject({ status: 403 });
	});
	test('transient failures retry via own Outbox while permanent denial is blocked with DLQ', async () => {
		const { processor, event, job, tx } = setup();
		expect(
			await processor.fail(
				event,
				job.leaseToken,
				0,
				new Error('private dependency details')
			)
		).toBe(true);
		expect(tx.widgetControlOutbox.create).toHaveBeenLastCalledWith({
			data: expect.objectContaining({
				route: 'MAIN',
				retryAttempt: 1,
				availableAt: new Date('2030-01-01T00:00:05.000Z')
			})
		});
		await processor.fail(
			event,
			job.leaseToken,
			3,
			new WidgetsControlDependencyError(
				403,
				'widgets_wincrm_subscription_required'
			)
		);
		expect(tx.managedWidgetSource.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ currentCommandId: commandId }),
				data: {
					syncState: 'BLOCKED',
					lastErrorCode: 'SUBSCRIPTION_REQUIRED'
				}
			})
		);
		expect(tx.widgetControlOutbox.create).toHaveBeenLastCalledWith({
			data: expect.objectContaining({ route: 'DLQ' })
		});
		expect(
			JSON.stringify(tx.widgetControlOutbox.create.mock.calls)
		).not.toContain('private dependency details');
	});
	test('stale remote command becomes superseded only with own newer desired evidence', async () => {
		const { processor, event, job, source, tx } = setup();
		source.controlVersion = 2;
		await processor.fail(
			event,
			job.leaseToken,
			0,
			new WidgetsControlDependencyError(
				409,
				'widgets_wincrm_control_stale'
			)
		);
		expect(tx.widgetControlJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: 'SUPERSEDED' })
			})
		);
		expect(tx.widgetControlOutbox.create).not.toHaveBeenCalled();
	});
});
