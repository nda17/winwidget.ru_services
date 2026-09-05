import { randomUUID } from 'node:crypto';
import type { ConsumeMessage } from 'amqplib';
import type { CrmTeamDelivery } from '@prisma/crm-access-client';
import {
	CrmTeamWorkerService,
	TEAM_DELIVERY_LEASE_MS
} from './team-worker.service';
import { parseTeamEvent, teamRoute } from './team-messaging.contract';
import { TEAM_EVENTS, semanticHash } from './team.util';

const event = () => ({
	schemaVersion: 1,
	eventId: randomUUID(),
	eventType: TEAM_EVENTS.admission,
	workspaceId: randomUUID(),
	occurredAt: new Date().toISOString()
});
const message = (value: ReturnType<typeof event>, headers = {}) =>
	({
		content: Buffer.from(JSON.stringify(value)),
		properties: {
			messageId: value.eventId,
			type: value.eventType,
			contentType: 'application/json',
			headers
		}
	}) as ConsumeMessage;
const setup = () => {
	const rows = new Map<string, CrmTeamDelivery>();
	const outbox: unknown[] = [];
	const prisma = {
		$executeRaw: jest.fn().mockResolvedValue(1),
		$transaction: jest.fn(),
		crmTeamDelivery: {
			findUnique: jest
				.fn()
				.mockImplementation(({ where }) =>
					Promise.resolve(
						[...rows.values()].find(row =>
							where.id
								? row.id === where.id
								: row.eventId === where.eventId_consumer.eventId &&
									row.consumer === where.eventId_consumer.consumer
						) ?? null
					)
				),
			findUniqueOrThrow: jest
				.fn()
				.mockImplementation(({ where }) =>
					Promise.resolve(rows.get(where.id))
				),
			create: jest.fn().mockImplementation(({ data }) => {
				const row = {
					id: randomUUID(),
					version: 1,
					workspaceId: null,
					status: 'PROCESSING',
					retryAttempt: 0,
					manualRetryCycle: 0,
					leaseToken: null,
					leaseExpiresAt: null,
					lastError: null,
					deliveredAt: null,
					createdAt: new Date(),
					updatedAt: new Date(),
					...data
				} as CrmTeamDelivery;
				rows.set(row.id, row);
				return Promise.resolve(row);
			}),
			updateMany: jest.fn().mockImplementation(({ where, data }) => {
				const current = rows.get(where.id);
				if (
					!current ||
					Object.entries(where).some(
						([key, value]) =>
							current[key as keyof CrmTeamDelivery] !== value
					)
				)
					return Promise.resolve({ count: 0 });
				const updated = {
					...current,
					...data,
					version: data.version
						? current.version + data.version.increment
						: current.version,
					retryAttempt: data.retryAttempt
						? current.retryAttempt + data.retryAttempt.increment
						: current.retryAttempt
				};
				rows.set(current.id, updated);
				return Promise.resolve({ count: 1 });
			})
		},
		crmTeamOutbox: {
			createMany: jest.fn().mockImplementation(({ data }) => {
				outbox.push(...data);
				return Promise.resolve({ count: 1 });
			})
		}
	};
	prisma.$transaction.mockImplementation(callback => callback(prisma));
	const rabbit = {
		ack: jest.fn(),
		consume: jest.fn(),
		stopConsumers: jest.fn()
	};
	const admissions = {
		admitNext: jest.fn().mockResolvedValue(undefined),
		provision: jest.fn(),
		accept: jest.fn()
	};
	const worker = new CrmTeamWorkerService(
		prisma as never,
		{ workerEnabled: true } as never,
		rabbit as never,
		admissions as never
	);
	return { worker, prisma, rows, outbox, rabbit, admissions };
};

describe('WinCRM team durable delivery', () => {
	it('takes a durable PROCESSING receipt before the first external call and acks only after delivered commit', async () => {
		const { worker, rows, admissions, rabbit } = setup();
		const value = event();
		admissions.admitNext.mockImplementation(async () => {
			expect([...rows.values()][0]).toMatchObject({
				eventId: value.eventId,
				consumer: 'admission',
				status: 'PROCESSING'
			});
			expect(rabbit.ack).not.toHaveBeenCalled();
		});
		await worker.handle('admission', message(value));
		expect([...rows.values()][0].status).toBe('DELIVERED');
		expect(rabbit.ack).toHaveBeenCalledTimes(1);
		await worker.handle('admission', message(value));
		expect(admissions.admitNext).toHaveBeenCalledTimes(1);
	});
	it('does not repeat external work while an unexpired claim owns it; retains a delayed durable wake before ack', async () => {
		const { worker, rows, outbox, admissions } = setup();
		const value = event();
		let release!: () => void;
		admissions.admitNext.mockImplementation(
			() =>
				new Promise<void>(resolve => {
					release = resolve;
				})
		);
		const first = worker.handle('admission', message(value));
		while (!release)
			await new Promise<void>(resolve => setImmediate(resolve));
		await worker.handle('admission', message(value));
		expect(admissions.admitNext).toHaveBeenCalledTimes(1);
		expect(outbox[0]).toMatchObject({
			exchange: 'winwidget.manual-retry',
			routingKey: teamRoute('admission'),
			availableAt: [...rows.values()][0].leaseExpiresAt
		});
		release();
		await first;
	});
	it('recovers an expired PROCESSING lease with CAS before invoking dependencies', async () => {
		const { worker, prisma, admissions, rows } = setup();
		const value = event();
		const oldToken = randomUUID();
		await prisma.crmTeamDelivery.create({
			data: {
				...value,
				eventId: value.eventId,
				consumer: 'admission',
				payload: value,
				payloadHash: semanticHash(value),
				leaseToken: oldToken,
				leaseExpiresAt: new Date(0)
			}
		});
		await worker.handle('admission', message(value));
		expect(
			prisma.crmTeamDelivery.updateMany.mock.calls[0][0]
		).toMatchObject({
			where: { version: 1, leaseToken: oldToken },
			data: { leaseExpiresAt: expect.any(Date) }
		});
		expect(admissions.admitNext).toHaveBeenCalledTimes(1);
		expect([...rows.values()][0].status).toBe('DELIVERED');
	});
	it('writes independent retry and DLQ messages transactionally and rejects stale retry tokens', async () => {
		const { worker, rows, outbox, admissions } = setup();
		const value = event();
		admissions.admitNext.mockRejectedValue(
			new Error('private-detail-never-stored')
		);
		await worker.handle('admission', message(value));
		let row = [...rows.values()][0];
		expect(row).toMatchObject({
			status: 'RETRY_SCHEDULED',
			retryAttempt: 1,
			lastError: 'TEAM_OPERATION_FAILED'
		});
		await worker.handle('admission', message(value));
		expect(admissions.admitNext).toHaveBeenCalledTimes(1);
		for (let attempt = 1; attempt <= 3; attempt++) {
			row = [...rows.values()][0];
			await worker.handle(
				'admission',
				message(value, {
					'x-original-event-id': value.eventId,
					'x-delivery-token': row.leaseToken,
					'x-retry-attempt': row.retryAttempt,
					'x-manual-retry-cycle': row.manualRetryCycle
				})
			);
		}
		expect([...rows.values()][0].status).toBe('DEAD_LETTERED');
		expect(outbox).toHaveLength(4);
		expect(outbox[3]).toMatchObject({
			exchange: 'winwidget.dead-letter',
			routingKey: 'crm-access.team.admission.dead-letter'
		});
		expect(JSON.stringify(outbox)).not.toContain('private-detail');
	});
	it('quarantines malformed body without storing token-shaped raw fields or trusting foreign workspace', async () => {
		const { worker, rows, outbox, admissions } = setup();
		const value = {
			...event(),
			jwt: 'not-a-real-token-but-must-never-be-persisted'
		};
		await worker.handle('admission', message(value));
		expect(admissions.admitNext).not.toHaveBeenCalled();
		expect([...rows.values()][0]).toMatchObject({
			workspaceId: null,
			status: 'DEAD_LETTERED',
			lastError: 'INVALID_EVENT'
		});
		expect(JSON.stringify(outbox)).not.toContain('not-a-real-token');
	});
	it('quarantines actor/payload reuse without overwriting the original delivery receipt', async () => {
		const { worker, rows, admissions } = setup();
		const value = event();
		await worker.handle('admission', message(value));
		await worker.handle(
			'admission',
			message({ ...value, workspaceId: randomUUID() })
		);
		expect(admissions.admitNext).toHaveBeenCalledTimes(1);
		expect(rows.size).toBe(2);
	});
	it.each(['eventId', 'workspaceId', 'occurredAt', 'schemaVersion'])(
		'strictly rejects invalid %s in the event envelope',
		field => {
			expect(() =>
				parseTeamEvent({ ...event(), [field]: 'invalid' }, 'admission')
			).toThrow('INVALID_EVENT');
		}
	);
	it('keeps the maximum sequential HTTP timeout budget below the recovery lease', () => {
		expect(TEAM_DELIVERY_LEASE_MS).toBeGreaterThan(4 * 60_000);
	});
});
