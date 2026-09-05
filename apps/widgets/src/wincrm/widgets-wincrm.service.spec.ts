import {
	ForbiddenException,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	Prisma,
	WidgetEntitlementProjection,
	WincrmConnector
} from '@prisma/widgets-client';
import { randomUUID } from 'node:crypto';
import { WidgetEntity, WidgetType } from '../domain/widgets-domain.types';
import {
	ConfigureConnector,
	WidgetsEligibility
} from './widgets-wincrm.contract';
import { WidgetsWincrmService } from './widgets-wincrm.service';

const now = Date.parse('2026-09-05T12:00:00.000Z');
const command = (): ConfigureConnector => ({
	schemaVersion: 1,
	commandId: randomUUID(),
	workspaceId: randomUUID(),
	sourceId: randomUUID(),
	ownerSubject: 'owner',
	widgetType: WidgetType.WHEEL,
	widgetId: 'cmwidget',
	controlVersion: 1,
	generation: 1,
	enabled: true
});
const eligible = (): WidgetsEligibility => ({
	schemaVersion: 1,
	ownerSubject: 'owner',
	eligible: true,
	reason: 'ELIGIBLE',
	subscriptionId: 'cmbilling',
	version: '2',
	plan: 'EASY',
	startsAt: '2026-09-01T00:00:00.000Z',
	expiresAt: '2026-10-01T00:00:00.000Z',
	checkedAt: new Date(now).toISOString(),
	validUntil: new Date(now + 5000).toISOString()
});
const entitlement = () =>
	({
		id: 'cmbilling',
		userId: 'owner',
		aggregateVersion: 2n,
		plan: 'EASY',
		status: 'ACTIVE',
		startsAt: new Date('2026-09-01T00:00:00.000Z'),
		expiresAt: new Date('2026-10-01T00:00:00.000Z'),
		tombstoned: false
	}) as WidgetEntitlementProjection;
function setup(enabled = true) {
	let connector: WincrmConnector | null = null;
	const receipts = new Map<string, unknown>();
	const tx = {
		$executeRaw: jest.fn().mockResolvedValue(0),
		$queryRaw: jest.fn().mockResolvedValue([{ id: 'cmwidget' }]),
		widgetOwnerProjection: {
			findUnique: jest.fn().mockResolvedValue({
				status: 'ACTIVE',
				tombstoned: false,
				deletedAt: null
			})
		},
		wincrmConnector: {
			findUnique: jest.fn().mockImplementation(async () => connector),
			findFirst: jest.fn().mockResolvedValue(null),
			create: jest.fn().mockImplementation(
				async ({ data }) =>
					(connector = {
						...data,
						createdAt: new Date(now - 1000),
						updatedAt: new Date(now)
					})
			),
			update: jest.fn().mockImplementation(
				async ({ data }) =>
					(connector = {
						...connector,
						...data,
						updatedAt: new Date(now)
					})
			)
		},
		wincrmConnectorCommand: {
			findUnique: jest
				.fn()
				.mockImplementation(
					async ({ where }) => receipts.get(where.commandId) ?? null
				),
			create: jest.fn().mockImplementation(async ({ data }) => {
				receipts.set(data.commandId, data);
				return data;
			})
		},
		wincrmTransferIntent: {
			create: jest.fn().mockImplementation(async ({ data }) => data),
			findUnique: jest.fn()
		},
		widgetsOutboxEvent: { create: jest.fn() }
	};
	const prisma = {
		...tx,
		$transaction: jest
			.fn()
			.mockImplementation(async operation => operation(tx))
	};
	const repository = {
		findById: jest.fn().mockResolvedValue({
			id: 'cmwidget',
			userId: 'owner',
			isActive: true,
			publishedAt: new Date(now - 1000)
		})
	};
	const billing = { eligibility: jest.fn().mockResolvedValue(eligible()) };
	const service = new WidgetsWincrmService(
		prisma as never,
		repository as never,
		{ enabled, apiEnabled: enabled } as never,
		billing as never
	);
	return {
		service,
		prisma,
		tx,
		billing,
		repository,
		setConnector: (value: WincrmConnector) => (connector = value)
	};
}
describe('Widgets native connector durable boundaries', () => {
	beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(now));
	afterEach(() => jest.restoreAllMocks());
	it('default off performs no connector SQL, HTTP or readiness reads', async () => {
		const test = setup(false);
		await test.service.capture(test.tx as never, {} as never);
		await test.service.readiness();
		expect(test.tx.$queryRaw).not.toHaveBeenCalled();
		expect(test.tx.wincrmConnector.findFirst).not.toHaveBeenCalled();
		expect(test.billing.eligibility).not.toHaveBeenCalled();
		await expect(
			test.service.candidates('owner', 1, 10)
		).rejects.toBeInstanceOf(NotFoundException);
	});
	it('checks Billing before a transaction and persists command receipt with exact replay', async () => {
		const test = setup();
		const input = command();
		const id = randomUUID();
		const original = await test.service.configure(id, input);
		expect(
			test.billing.eligibility.mock.invocationCallOrder[0]
		).toBeLessThan(test.prisma.$transaction.mock.invocationCallOrder[0]);
		expect(await test.service.configure(id, input)).toEqual(original);
		expect(test.tx.wincrmConnector.create).toHaveBeenCalledTimes(1);
		const lockStatements = test.tx.$queryRaw.mock.calls
			.map(call => Array.from(call[0] as string[]).join(''))
			.filter(statement => statement.includes('pg_advisory_xact_lock'));
		expect(lockStatements.length).toBeGreaterThan(0);
		for (const statement of lockStatements)
			expect(statement).toContain('::text');
		expect(test.tx.wincrmConnectorCommand.create).toHaveBeenCalledTimes(1);
		await expect(
			test.service.configure(id, { ...input, enabled: false })
		).rejects.toMatchObject({ status: 409 });
	});
	it('old receipt returns original snapshot without re-enabling a newer disabled generation', async () => {
		const test = setup();
		const input = command();
		const id = randomUUID();
		const original = await test.service.configure(id, input);
		await test.service.configure(id, {
			...input,
			commandId: randomUUID(),
			controlVersion: 2,
			enabled: false
		});
		expect(await test.service.configure(id, input)).toEqual(original);
		expect(test.tx.wincrmConnector.update).toHaveBeenCalledTimes(1);
		await expect(
			test.service.configure(id, { ...input, commandId: randomUUID() })
		).rejects.toMatchObject({ status: 409 });
		await expect(
			test.service.configure(id, {
				...input,
				commandId: randomUUID(),
				controlVersion: 3
			})
		).rejects.toMatchObject({ status: 409 });
		await expect(
			test.service.configure(id, {
				...input,
				commandId: randomUUID(),
				controlVersion: 3,
				generation: 2
			})
		).resolves.toMatchObject({
			connector: { enabled: true, generation: 2 }
		});
	});
	it('security-reducing tombstone is durable without Billing or a surviving widget', async () => {
		const test = setup();
		const input = { ...command(), enabled: false, controlVersion: 2 };
		const id = randomUUID();
		test.billing.eligibility.mockRejectedValue(new Error('offline'));
		test.tx.widgetOwnerProjection.findUnique.mockResolvedValue(null);
		await expect(test.service.configure(id, input)).resolves.toMatchObject(
			{ connector: { enabled: false, enabledAt: null } }
		);
		expect(test.billing.eligibility).not.toHaveBeenCalled();
		expect(
			test.tx.widgetOwnerProjection.findUnique
		).not.toHaveBeenCalled();
	});
	it('rejects cross-workspace rebinding and one widget cannot have two active connectors', async () => {
		const test = setup();
		const input = command();
		const id = randomUUID();
		await test.service.configure(id, input);
		await expect(
			test.service.configure(id, {
				...input,
				commandId: randomUUID(),
				workspaceId: randomUUID(),
				controlVersion: 2
			})
		).rejects.toMatchObject({ status: 409 });
		test.tx.wincrmConnector.findUnique.mockResolvedValue(null);
		test.tx.wincrmConnector.findFirst.mockResolvedValue({
			id: 'other'
		} as never);
		await expect(
			test.service.configure(randomUUID(), {
				...input,
				commandId: randomUUID(),
				sourceId: randomUUID()
			})
		).rejects.toMatchObject({ status: 409 });
	});
	it('rejects no paid period, changed owner and a snapshot that expired while acquiring own locks', async () => {
		const test = setup();
		const input = command();
		test.billing.eligibility.mockResolvedValueOnce({
			...eligible(),
			eligible: false,
			reason: 'TRIAL'
		});
		await expect(
			test.service.configure(randomUUID(), input)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(test.prisma.$transaction).not.toHaveBeenCalled();
		test.tx.widgetOwnerProjection.findUnique.mockResolvedValueOnce({
			status: 'DELETED'
		} as never);
		await expect(
			test.service.configure(randomUUID(), input)
		).rejects.toBeInstanceOf(ForbiddenException);
		test.billing.eligibility.mockResolvedValueOnce({
			...eligible(),
			validUntil: new Date(now).toISOString()
		});
		await expect(
			test.service.configure(randomUUID(), input)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(test.tx.wincrmConnector.create).not.toHaveBeenCalled();
	});
	it('READY and SKIPPED both create a same-transaction identifier-only Outbox with original Billing CUID', async () => {
		const test = setup();
		const input = command();
		const connection = {
			...input,
			id: randomUUID(),
			enabledAt: new Date(now - 1000)
		} as unknown as WincrmConnector;
		test.tx.wincrmConnector.findFirst.mockResolvedValue(
			connection as never
		);
		const captured = {
			type: WidgetType.WHEEL,
			widget: {
				id: 'cmwidget',
				userId: 'owner',
				name: 'Widget',
				publishedVersion: 2
			} as WidgetEntity,
			lead: {
				id: 'cmlead',
				createdAt: new Date(now),
				phone: '+79990000000'
			},
			config: {},
			entitlement: entitlement(),
			contactName: null
		};
		await test.service.capture(test.tx as never, captured);
		expect(test.billing.eligibility).not.toHaveBeenCalled();
		expect(
			test.tx.wincrmTransferIntent.create.mock.calls[0][0].data
		).toMatchObject({
			state: 'READY',
			originalSubscriptionId: 'cmbilling',
			originalSubscriptionVersion: '2'
		});
		expect(
			test.tx.widgetsOutboxEvent.create.mock.calls[0][0].data.payload
		).not.toHaveProperty('payload');
		expect(
			JSON.stringify(
				test.tx.widgetsOutboxEvent.create.mock.calls[0][0].data.payload
			)
		).not.toContain('+79990000000');
		await test.service.capture(test.tx as never, {
			...captured,
			contactName: '<b>unsafe</b>'
		});
		expect(
			test.tx.wincrmTransferIntent.create.mock.calls[1][0].data
		).toMatchObject({
			state: 'SKIPPED',
			reason: 'TEXT_UNSUPPORTED',
			payload: Prisma.DbNull
		});
		expect(test.tx.widgetsOutboxEvent.create).toHaveBeenCalledTimes(2);
		for (const [call] of test.tx.widgetsOutboxEvent.create.mock.calls)
			expect(call.data.aggregateVersion).toBe(1n);
	});
	it('never swallows DB failure or emits Outbox without durable intent', async () => {
		const test = setup();
		const input = command();
		test.tx.wincrmConnector.findFirst.mockResolvedValue({
			...input,
			id: randomUUID(),
			enabledAt: new Date(now - 1000)
		} as never);
		test.tx.wincrmTransferIntent.create.mockRejectedValue(
			new Error('database failure')
		);
		await expect(
			test.service.capture(test.tx as never, {
				type: WidgetType.WHEEL,
				widget: {
					id: 'cmwidget',
					userId: 'owner',
					name: 'Widget',
					publishedVersion: 1
				} as WidgetEntity,
				lead: { id: 'cmlead', createdAt: new Date(now) },
				config: {},
				entitlement: entitlement(),
				contactName: null
			})
		).rejects.toThrow('database failure');
		expect(test.tx.widgetsOutboxEvent.create).not.toHaveBeenCalled();
	});
	it('transfer context fails closed on foreign bindings and never revives after original deadline', async () => {
		const test = setup();
		const binding = {
			eventId: randomUUID(),
			connectorId: randomUUID(),
			workspaceId: randomUUID(),
			sourceId: randomUUID(),
			generation: 1
		};
		test.setConnector({
			id: binding.connectorId,
			workspaceId: binding.workspaceId,
			sourceId: binding.sourceId,
			ownerSubject: 'owner',
			widgetType: 'WHEEL',
			widgetId: 'cmwidget',
			enabled: true,
			generation: 1
		} as WincrmConnector);
		test.tx.wincrmTransferIntent.findUnique.mockResolvedValue({
			id: randomUUID(),
			...binding,
			ownerSubject: 'owner',
			widgetType: 'WHEEL',
			widgetId: 'cmwidget',
			state: 'READY',
			originalDeadline: new Date(now),
			originalPeriodStartsAt: new Date(now - 1000),
			originalSubscriptionId: 'cmbilling',
			originalSubscriptionVersion: '1'
		});
		await expect(
			test.service.context(randomUUID(), {
				...binding,
				workspaceId: randomUUID()
			})
		).rejects.toBeInstanceOf(NotFoundException);
		await expect(
			test.service.context(randomUUID(), binding)
		).resolves.toMatchObject({
			deliver: false,
			reason: 'PERIOD_EXPIRED',
			payload: null
		});
		expect(test.billing.eligibility).not.toHaveBeenCalled();
	});
	it('rejects an inconsistent persisted owner/widget binding before any payload or Billing read', async () => {
		const test = setup();
		const binding = {
			eventId: randomUUID(),
			connectorId: randomUUID(),
			workspaceId: randomUUID(),
			sourceId: randomUUID(),
			generation: 1
		};
		test.setConnector({
			id: binding.connectorId,
			workspaceId: binding.workspaceId,
			sourceId: binding.sourceId,
			ownerSubject: 'owner-A',
			widgetType: 'WHEEL',
			widgetId: 'widget-A',
			enabled: true,
			generation: 1
		} as WincrmConnector);
		test.tx.wincrmTransferIntent.findUnique.mockResolvedValue({
			...binding,
			ownerSubject: 'owner-B',
			widgetType: 'QUIZ',
			widgetId: 'widget-B',
			state: 'SKIPPED',
			reason: 'TEXT_UNSUPPORTED',
			payload: null
		});
		await expect(
			test.service.context(randomUUID(), binding)
		).rejects.toMatchObject({ status: 503 });
		expect(test.billing.eligibility).not.toHaveBeenCalled();
	});
});
