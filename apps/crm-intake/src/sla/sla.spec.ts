import { ConflictException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { acceptanceHash } from '../acceptance/acceptance.contract';
import { intakeProcessRole } from '../acceptance/acceptance.messaging';
import { parseCrmIntakeDatabaseUrl } from '../prisma/crm-intake-prisma.service';
import { parseCrmIntakePort } from '../runtime/crm-intake-runtime.config';
import { slaDeadline } from './sla-clock';
import {
	intakeSlaEnabled,
	parseSlaCommand,
	parseSlaEvent,
	parseSlaRule,
	type SlaRuleConfig
} from './sla.contract';
import { SlaProcessor, SLA_CONSUMER, SlaLeaseLost } from './sla.processor';
import { SlaPublisher } from './sla.publisher';
import { assertSlaManager, SlaService } from './sla.service';
import { SlaWorker } from './sla.worker';
import { SLA_EVENT_TYPE } from './sla.messaging';

const workspaceId = randomUUID(),
	entryId = randomUUID();
const rule: SlaRuleConfig = {
	enabled: true,
	workingMinutes: 60,
	timeZone: 'Europe/Moscow',
	weekdays: [1, 2, 3, 4, 5],
	workStart: '09:00',
	workEnd: '18:00',
	responsibleBinding: null,
	notifyManagers: true,
	channels: ['EMAIL']
};
const event = () => ({
	schemaVersion: 1 as const,
	workspaceId,
	eventId: randomUUID(),
	jobId: randomUUID(),
	generation: 1
});
const context = {
	schemaVersion: 1 as const,
	workspaceId,
	subject: 'owner',
	role: 'OWNER' as const,
	state: 'ACTIVE' as const,
	dataScope: 'ALL' as const,
	teamIds: [],
	permissions: ['intake:read', 'intake:write']
};
const current = new Date('2026-09-08T12:00:00.000Z');

describe('Intake SLA rule and business clock', () => {
	it.each([
		['2026-09-08T07:00:00.000Z', '2026-09-08T08:00:00.000Z'],
		['2026-09-08T03:00:00.000Z', '2026-09-08T07:00:00.000Z'],
		['2026-09-11T14:30:00.000Z', '2026-09-14T06:30:00.000Z'],
		['2026-09-12T12:00:00.000Z', '2026-09-14T07:00:00.000Z'],
		['2026-09-08T07:00:12.123Z', '2026-09-08T08:00:12.123Z']
	])('counts only working time after %s', (start, expected) =>
		expect(slaDeadline(new Date(start), rule).toISOString()).toBe(expected)
	);
	it('uses local DST windows across spring gaps and autumn folds', () => {
		const config = {
			...rule,
			timeZone: 'America/New_York',
			weekdays: [7],
			workStart: '01:00',
			workEnd: '04:00',
			workingMinutes: 120
		};
		expect(
			slaDeadline(new Date('2026-03-08T06:00:00Z'), config).toISOString()
		).toBe('2026-03-08T08:00:00.000Z');
		expect(
			slaDeadline(new Date('2026-11-01T05:00:00Z'), config).toISOString()
		).toBe('2026-11-01T07:00:00.000Z');
	});
	it.each([
		{ weekdays: [] },
		{ weekdays: [1, 1] },
		{ timeZone: 'not/a/zone' },
		{ workEnd: '09:29' },
		{ workStart: '19:00' },
		{ workingMinutes: 0 },
		{ workingMinutes: 1441 },
		{ notifyManagers: false },
		{ channels: ['SMS'] },
		{ unexpected: true }
	])('rejects invalid rule %j', patch =>
		expect(() => parseSlaRule({ ...rule, ...patch })).toThrow()
	);
	it('requires exact command/event contracts and canonical versions', () => {
		const command = {
			schemaVersion: 1,
			workspaceId,
			commandId: randomUUID(),
			expectedVersion: 0,
			config: rule
		};
		expect(parseSlaCommand(command)).toEqual(command);
		expect(() =>
			parseSlaCommand({ ...command, expectedVersion: -1 })
		).toThrow();
		expect(parseSlaEvent(event()).generation).toBe(1);
		expect(() =>
			parseSlaEvent({ ...event(), recipient: 'private@example.test' })
		).toThrow();
	});
	it('keeps rules read-only for non-managers and expired workspaces', () => {
		expect(() =>
			assertSlaManager({ ...context, role: 'MANAGER' })
		).toThrow(ForbiddenException);
		expect(() =>
			assertSlaManager({ ...context, state: 'READ_ONLY' }, true)
		).toThrow(ForbiddenException);
		expect(() =>
			assertSlaManager({ ...context, state: 'READ_ONLY' })
		).not.toThrow();
		expect(() =>
			assertSlaManager({ ...context, role: 'CRM_ADMIN' }, true)
		).not.toThrow();
	});
});

describe('Intake SLA isolated process gate', () => {
	const env = process.env;
	afterEach(() => {
		process.env = env;
	});
	it('is disabled by default and rejects partial enablement', () => {
		process.env = { ...env };
		delete process.env.CRM_INTAKE_SLA_ENABLED;
		expect(intakeSlaEnabled()).toBe(false);
		expect(() => intakeSlaEnabled('yes')).toThrow();
		process.env.CRM_INTAKE_PROCESS_ROLE = 'sla-worker';
		expect(() => intakeProcessRole()).toThrow(
			'CRM_INTAKE_SLA_ENABLED=true'
		);
	});
	it.each([
		['sla-worker', 5317, '2'],
		['sla-publisher', 5318, '1']
	] as const)('bounds %s process and pool', (role, port, pool) => {
		process.env = {
			...env,
			CRM_INTAKE_SLA_ENABLED: 'true',
			CRM_INTAKE_PROCESS_ROLE: role
		};
		expect(intakeProcessRole()).toBe(role);
		expect(parseCrmIntakePort(undefined, role)).toBe(port);
		expect(() => parseCrmIntakePort('5310', role)).toThrow();
		expect(
			new URL(
				parseCrmIntakeDatabaseUrl(
					'postgresql://ci:ci@localhost/intake?schema=crm_intake&connection_limit=99'
				)
			).searchParams.get('connection_limit')
		).toBe(pool);
	});
	it('does not change the existing API pool', () => {
		process.env = { ...env, CRM_INTAKE_PROCESS_ROLE: 'api' };
		const url = 'postgresql://ci:ci@localhost/intake?connection_limit=5';
		expect(parseCrmIntakeDatabaseUrl(url)).toBe(url);
	});
});

function processorFixture() {
	const value = event(),
		token = randomUUID();
	const receipt = {
		eventId: value.eventId,
		consumer: SLA_CONSUMER,
		workspaceId,
		jobId: value.jobId,
		payloadHash: acceptanceHash(value),
		status: 'PROCESSING',
		leaseToken: token,
		leaseUntil: new Date(current.getTime() + 60000),
		retryAttempt: 0
	};
	const job = {
		id: value.jobId,
		workspaceId,
		entryId,
		generation: 1,
		recipientCursor: null,
		breachedAt: null,
		activeEventId: value.eventId,
		ruleVersion: 1,
		dueAt: current,
		status: 'PROCESSING'
	};
	const db = {
		$executeRaw: jest.fn(),
		$queryRaw: jest.fn().mockResolvedValue([{ now: current }]),
		slaReceipt: {
			findUnique: jest.fn().mockResolvedValue(receipt),
			create: jest.fn(),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		slaJob: {
			findFirst: jest.fn().mockResolvedValue(job),
			updateMany: jest.fn().mockResolvedValue({ count: 1 })
		},
		slaRule: {
			findUnique: jest.fn().mockResolvedValue({
				version: 1,
				config: rule,
				enabled: true,
				ownerBinding: { subject: 'owner', membershipId: null }
			})
		},
		inboxEntry: {
			findFirst: jest.fn().mockResolvedValue({
				id: entryId,
				status: 'NEW',
				version: 1,
				createdBySubject: 'owner',
				teamId: null
			})
		},
		acceptance: { findFirst: jest.fn().mockResolvedValue(null) },
		slaNotification: {
			createMany: jest.fn(),
			findMany: jest.fn().mockResolvedValue([])
		},
		slaOutbox: { createMany: jest.fn() }
	};
	const prisma = {
		...db,
		$transaction: (fn: (tx: typeof db) => unknown) => fn(db)
	};
	const authority = {
		read: jest
			.fn()
			.mockResolvedValue({ allowed: true, items: [], nextCursor: null })
	};
	return {
		value,
		token,
		receipt,
		job,
		db,
		authority,
		processor: new SlaProcessor(prisma as never, authority as never)
	};
}
describe('Intake SLA receipt/CAS and stale cancellation', () => {
	it('commits opaque per-recipient ND Outbox and a bounded page continuation with the same job', async () => {
		const { processor, value, token, db, authority } = processorFixture();
		const nextCursor = randomUUID();
		authority.read.mockResolvedValue({
			allowed: true,
			items: [
				{
					binding: { subject: 'owner', membershipId: null },
					email: 'owner@example.test',
					telegramChatId: null
				}
			],
			nextCursor
		});
		db.slaNotification.createMany.mockImplementation(async ({ data }) => {
			db.slaNotification.findMany.mockResolvedValue(
				data.map((item: Record<string, unknown>) => ({
					...item,
					createdAt: current
				}))
			);
		});
		await processor.run(value, token);
		expect(db.slaNotification.createMany).toHaveBeenCalledWith(
			expect.objectContaining({ skipDuplicates: true })
		);
		expect(db.slaOutbox.createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: [
					expect.objectContaining({
						route: 'ND_EMAIL',
						payload: expect.objectContaining({
							eventType:
								'notification.wincrm.intake-sla.email.requested.v1',
							reference: expect.objectContaining({
								type: 'wincrm-intake-sla',
								workspaceId
							})
						})
					})
				]
			})
		);
		expect(
			JSON.stringify(db.slaOutbox.createMany.mock.calls)
		).not.toContain('owner@example.test');
		expect(db.slaJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: 'PENDING',
					recipientCursor: nextCursor,
					generation: { increment: 1 }
				})
			})
		);
		expect(db.slaOutbox.createMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: [
					expect.objectContaining({
						route: 'MAIN',
						payload: expect.objectContaining({ generation: 2 })
					})
				]
			})
		);
	});
	it('does not steal an active lease or accept changed event payload', async () => {
		const { processor, value, db, receipt } = processorFixture();
		await expect(processor.claim(value, 0)).rejects.toThrow(SlaLeaseLost);
		db.slaReceipt.findUnique.mockResolvedValue({
			...receipt,
			payloadHash: 'different'
		});
		await expect(processor.claim(value, 0)).rejects.toThrow(
			ConflictException
		);
	});
	it('recovers only the exact expired CAS receipt', async () => {
		const { processor, value, db, receipt } = processorFixture();
		db.slaReceipt.findUnique.mockResolvedValue({
			...receipt,
			leaseUntil: new Date(current.getTime() - 1)
		});
		await expect(processor.claim(value, 0)).resolves.toMatchObject({
			state: 'CLAIMED'
		});
		expect(db.slaReceipt.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					leaseToken: receipt.leaseToken,
					leaseUntil: { lte: current }
				})
			})
		);
	});
	it('ack-equivalent duplicate requires a durable terminal receipt', async () => {
		const { processor, value, db, receipt } = processorFixture();
		db.slaReceipt.findUnique.mockResolvedValue({
			...receipt,
			status: 'DELIVERED'
		});
		await expect(processor.claim(value, 0)).resolves.toEqual({
			state: 'DONE'
		});
		expect(db.slaJob.updateMany).not.toHaveBeenCalled();
	});
	it('commits a breach once without pretending that ND delivered it', async () => {
		const { processor, value, token, db, authority } = processorFixture();
		await processor.run(value, token);
		expect(authority.read).toHaveBeenCalledWith(
			workspaceId,
			{ subject: 'owner', membershipId: null },
			rule,
			{ id: entryId, createdBySubject: 'owner', teamId: null },
			null,
			null
		);
		expect(db.slaJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: 'BREACHED',
					breachedAt: current
				})
			})
		);
		expect(db.slaOutbox.createMany).not.toHaveBeenCalled();
	});
	it('cancels a durable acceptance request even while Inbox status remains NEW', async () => {
		const { processor, value, token, db } = processorFixture();
		db.acceptance.findFirst.mockResolvedValue({ id: randomUUID() });
		await processor.run(value, token);
		expect(db.slaJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { status: 'CANCELLED' } })
		);
		expect(db.slaNotification.createMany).not.toHaveBeenCalled();
	});
	it.each(['ACCEPTED', 'REJECTED'])(
		'cancels a stale %s entry',
		async status => {
			const { processor, value, token, db } = processorFixture();
			db.inboxEntry.findFirst.mockResolvedValue({ id: entryId, status });
			await processor.run(value, token);
			expect(db.slaJob.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({ data: { status: 'CANCELLED' } })
			);
		}
	);
	it('does not mark an evaluation complete after its lease was replaced', async () => {
		const { processor, value, token, db } = processorFixture();
		db.slaReceipt.updateMany.mockResolvedValue({ count: 0 });
		await expect(processor.run(value, token)).rejects.toThrow(
			SlaLeaseLost
		);
		expect(db.slaJob.updateMany).not.toHaveBeenCalled();
	});
	it.each([0, 1, 2, 3])(
		'commits retry %i or independent DLQ with its receipt',
		async attempt => {
			const { processor, value, token, db } = processorFixture();
			await expect(processor.fail(value, token, attempt)).resolves.toBe(
				true
			);
			expect(db.slaOutbox.createMany).toHaveBeenCalledWith(
				expect.objectContaining({
					data: [
						expect.objectContaining({
							eventId: value.eventId,
							route: attempt < 3 ? 'MAIN' : 'DLQ',
							retryAttempt: Math.min(attempt + 1, 3)
						})
					]
				})
			);
		}
	);
	it('does not enqueue retry after a failed CAS', async () => {
		const { processor, value, token, db } = processorFixture();
		db.slaReceipt.updateMany.mockResolvedValue({ count: 0 });
		await expect(processor.fail(value, token, 0)).resolves.toBe(false);
		expect(db.slaOutbox.createMany).not.toHaveBeenCalled();
	});
});

describe('Intake SLA durable producer and consumer', () => {
	it('creates the unique job and future Outbox in one owner transaction', async () => {
		const tx = {
			$executeRaw: jest.fn(),
			$queryRaw: jest.fn().mockResolvedValue([
				{
					workspaceId,
					entryId,
					receivedAt: new Date('2026-09-08T07:00:00Z'),
					version: 1,
					config: rule
				}
			]),
			slaJob: { create: jest.fn() },
			slaOutbox: { createMany: jest.fn() }
		};
		const prisma = { $transaction: jest.fn(fn => fn(tx)) };
		expect(
			await new SlaService(
				prisma as never,
				{} as never,
				{} as never
			).schedule()
		).toBe(1);
		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(tx.slaJob.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				workspaceId,
				entryId,
				ruleVersion: 1,
				dueAt: new Date('2026-09-08T08:00:00Z')
			})
		});
		expect(tx.slaOutbox.createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: [
					expect.objectContaining({
						availableAt: new Date('2026-09-08T08:00:00Z')
					})
				]
			})
		);
	});
	it('never ack before processing or a retry transaction completes', async () => {
		const value = event(),
			order: string[] = [];
		const processor = {
			claim: jest
				.fn()
				.mockResolvedValue({ state: 'CLAIMED', token: randomUUID() }),
			run: jest.fn().mockRejectedValue(new Error('dependency')),
			fail: jest.fn(async () => {
				order.push('commit');
				return true;
			}),
			renew: jest.fn()
		};
		const rabbit = {
			ack: jest.fn(() => order.push('ack')),
			nackAfterBackoff: jest.fn()
		};
		await new SlaWorker(
			processor as never,
			rabbit as never,
			{} as never,
			{} as never
		).handle({
			content: Buffer.from(JSON.stringify(value)),
			properties: {
				messageId: value.eventId,
				type: SLA_EVENT_TYPE,
				contentType: 'application/json'
			}
		} as never);
		expect(order).toEqual(['commit', 'ack']);
	});
	it('retries unconfirmed publications indefinitely and does not block on a locked scheduler row', async () => {
		const value = event(),
			row = {
				id: randomUUID(),
				eventId: value.eventId,
				payload: value,
				route: 'MAIN',
				retryAttempt: 0,
				attempts: 99999,
				leaseToken: ''
			};
		const prisma = {
			$queryRaw: jest.fn().mockResolvedValue([{ now: current }]),
			slaOutbox: {
				updateMany: jest.fn(async args => {
					if (args.data.status === 'PUBLISHING')
						row.leaseToken = args.data.leaseToken;
					return { count: 1 };
				}),
				findMany: jest.fn().mockResolvedValue([{ id: row.id }]),
				findUnique: jest.fn().mockResolvedValue(row)
			}
		};
		const rabbit = {
			publish: jest
				.fn()
				.mockRejectedValue(new Error('private broker error'))
		};
		await new SlaPublisher(
			prisma as never,
			rabbit as never,
			{
				schedule: jest.fn().mockRejectedValue(new Error('locked'))
			} as never,
			{} as never
		).tick();
		expect(rabbit.publish).toHaveBeenCalled();
		expect(prisma.slaOutbox.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: 'PENDING',
					lastErrorCode: 'PUBLICATION_UNCONFIRMED'
				})
			})
		);
	});
});
