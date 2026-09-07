import {
	type ScheduledJobRun,
	ScheduledJobRunStatus,
	ScheduledJobRunTrigger
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { ScheduledJobsService } from './scheduled-jobs.service';
import type { EnqueueOperationsOutboxInput } from '../messaging/operations-outbox.service';
import { OperationalAlertService } from '../monitoring/operational-alert.service';

const scheduledJob = () => {
	const now = new Date('2026-08-26T08:00:00.000Z');
	return {
		id: randomUUID(),
		jobType: 'OPERATIONS_DATABASE_BACKUP',
		scheduleKey: 'daily:operations:2026-08-26',
		trigger: ScheduledJobRunTrigger.SCHEDULED,
		status: ScheduledJobRunStatus.QUEUED,
		scheduledFor: now,
		periodStart: now,
		periodEnd: new Date('2026-08-27T08:00:00.000Z'),
		input: { schemaVersion: 1 },
		checkpoint: {},
		result: null,
		attempts: 0,
		maxAttempts: 4,
		availableAt: now,
		leaseOwner: null,
		leaseToken: null,
		leaseExpiresAt: null,
		startedAt: null,
		finishedAt: null,
		lastError: null,
		createdAt: now,
		updatedAt: now
	};
};

describe('ScheduledJobsService', () => {
	it('creates the durable job and its publication in one transaction', async () => {
		const job = scheduledJob();
		const transaction = {
			$executeRaw: jest.fn(),
			scheduledJobRun: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue(job)
			}
		};
		const prisma = {
			$transaction: jest.fn((callback: (value: unknown) => unknown) =>
				callback(transaction)
			)
		};
		const outbox = { enqueue: jest.fn().mockResolvedValue({}) };
		const service = new ScheduledJobsService(
			prisma as never,
			outbox as never,
			{} as never
		);

		await expect(
			service.enqueueUnique({
				jobType: job.jobType,
				scheduleKey: job.scheduleKey,
				scheduledFor: job.scheduledFor,
				input: job.input
			})
		).resolves.toEqual({
			created: true,
			job: expect.objectContaining({ id: job.id, status: 'QUEUED' })
		});

		expect(outbox.enqueue).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				eventType: 'operations.scheduled-job.requested.v1',
				routingKey: 'operations.scheduled-job.requested.v1',
				aggregateId: job.id,
				payload: expect.objectContaining({
					schemaVersion: 1,
					jobId: job.id,
					jobType: job.jobType
				})
			})
		);
	});
});

// These doubles evaluate the CAS against the current row, not the earlier
// findUnique snapshot. They exercise read/write races without claiming PG tests.
function fixture(overrides: Partial<ScheduledJobRun> = {}) {
	const state = {
		job: { ...scheduledJob(), ...overrides } as ScheduledJobRun | null,
		outbox: [] as Array<
			EnqueueOperationsOutboxInput & {
				availableAt?: Date;
				published?: boolean;
			}
		>,
		alerts: [] as unknown[]
	};
	let beforeCas: ((job: ScheduledJobRun) => void) | undefined;
	const matches = (row: ScheduledJobRun, where: Record<string, unknown>) =>
		Object.entries(where).every(([key, expected]) => {
			const actual = (row as unknown as Record<string, unknown>)[key];
			if (
				expected &&
				typeof expected === 'object' &&
				!(expected instanceof Date)
			) {
				const filter = expected as { lte?: Date; gt?: Date };
				if (!(actual instanceof Date)) return false;
				if (filter.lte) return actual.getTime() <= filter.lte.getTime();
				if (filter.gt) return actual.getTime() > filter.gt.getTime();
				throw new Error('Unsupported CAS fixture filter');
			}
			return actual === expected;
		});
	const transaction = {
		scheduledJobRun: {
			findUnique: jest.fn(async () => structuredClone(state.job)),
			findFirst: jest.fn(async () => structuredClone(state.job)),
			findUniqueOrThrow: jest.fn(async () => structuredClone(state.job)),
			updateMany: jest.fn(
				async ({
					where,
					data
				}: {
					where: Record<string, unknown>;
					data: Record<string, unknown>;
				}) => {
					if (!state.job) return { count: 0 };
					const mutate = beforeCas;
					beforeCas = undefined;
					mutate?.(state.job);
					if (!matches(state.job, where)) return { count: 0 };
					for (const [key, value] of Object.entries(data)) {
						if (key === 'attempts' && value && typeof value === 'object')
							state.job.attempts += (
								value as { increment: number }
							).increment;
						else
							(state.job as unknown as Record<string, unknown>)[key] =
								value;
					}
					return { count: 1 };
				}
			)
		},
		outboxEvent: {
			updateMany: jest.fn(
				async ({
					where,
					data
				}: {
					where: { eventId: string };
					data: { availableAt: Date };
				}) => {
					const event = state.outbox.find(
						item => item.eventId === where.eventId
					);
					if (!event) return { count: 0 };
					event.availableAt = data.availableAt;
					return { count: 1 };
				}
			)
		},
		operationalAlert: {
			upsert: jest.fn(async (input: unknown) => {
				state.alerts.push(input);
				return input;
			})
		}
	};
	const prisma = {
		...transaction,
		$transaction: jest.fn(
			async (callback: (tx: typeof transaction) => Promise<unknown>) => {
				const snapshot = structuredClone(state);
				try {
					return await callback(transaction);
				} catch (error) {
					Object.assign(state, snapshot);
					throw error;
				}
			}
		)
	};
	const outbox = {
		enqueue: jest.fn(
			async (_tx: unknown, input: EnqueueOperationsOutboxInput) => {
				state.outbox.push(input);
			}
		)
	};
	const alerts = new OperationalAlertService(prisma as never);
	const service = new ScheduledJobsService(
		prisma as never,
		outbox as never,
		alerts
	);
	const event = {
		eventId: randomUUID(),
		jobId: state.job!.id,
		jobType: state.job!.jobType
	};
	return {
		service,
		state,
		transaction,
		prisma,
		outbox,
		event,
		race: (mutate: (job: ScheduledJobRun) => void) => {
			beforeCas = mutate;
		}
	};
}

describe('Operations backup lease recovery', () => {
	const now = new Date('2026-08-26T09:00:00.000Z');
	const processing = (expiresInMs: number): Partial<ScheduledJobRun> => ({
		status: ScheduledJobRunStatus.PROCESSING,
		attempts: 1,
		leaseToken: randomUUID(),
		leaseOwner: 'old-worker',
		leaseExpiresAt: new Date(now.getTime() + expiresInMs)
	});
	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(now);
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	it.each(['claim', 'claimNext', 'claimBackup'] as const)(
		'%s cannot steal a lease renewed between read and CAS',
		async method => {
			const f = fixture(processing(-1));
			const token = f.state.job!.leaseToken;
			f.race(job => {
				job.leaseExpiresAt = new Date(now.getTime() + 60_000);
			});
			const result =
				method === 'claimBackup'
					? await f.service.claimBackup(f.event, 'worker', 60_000)
					: method === 'claim'
						? await f.service.claim(f.event.jobId, 'worker', 60_000)
						: await f.service.claimNext('worker', 60_000);
			expect(result).toEqual(
				method === 'claimBackup' ? { status: 'REQUEUE' } : null
			);
			expect(f.state.job!.leaseToken).toBe(token);
			expect(f.state.job!.attempts).toBe(1);
			expect(
				f.transaction.scheduledJobRun.updateMany.mock.calls[0][0].where
			).toMatchObject({
				leaseExpiresAt: { lte: now },
				availableAt: { lte: now },
				maxAttempts: 4
			});
		}
	);

	it.each(['claim', 'claimNext', 'claimBackup'] as const)(
		'%s rechecks availability in CAS',
		async method => {
			const f = fixture();
			f.race(job => {
				job.availableAt = new Date(now.getTime() + 60_000);
			});
			const result =
				method === 'claimBackup'
					? await f.service.claimBackup(f.event, 'worker', 60_000)
					: method === 'claim'
						? await f.service.claim(f.event.jobId, 'worker', 60_000)
						: await f.service.claimNext('worker', 60_000);
			expect(result).toEqual(
				method === 'claimBackup' ? { status: 'REQUEUE' } : null
			);
			expect(f.state.job!.status).toBe('QUEUED');
			expect(f.state.job!.attempts).toBe(0);
		}
	);

	it('recovers crash-after-claim through a delayed trigger without stealing the live lease', async () => {
		const f = fixture();
		const first = await f.service.claimBackup(
			f.event,
			'crashed-worker',
			60_000
		);
		expect(first.status).toBe('CLAIMED');
		const claimed = structuredClone(f.state.job);
		await expect(
			f.service.claimBackup(f.event, 'replacement-worker', 60_000)
		).resolves.toEqual({ status: 'DEFERRED' });
		expect(f.state.job).toEqual(claimed);
		expect(f.state.outbox[0]).toMatchObject({
			availableAt: new Date(now.getTime() + 60_000),
			eventType: 'operations.scheduled-job.requested.v1',
			routingKey: 'operations.scheduled-job.requested.v1',
			payload: {
				schemaVersion: 1,
				jobId: f.event.jobId,
				jobType: f.event.jobType
			}
		});
		jest.setSystemTime(now.getTime() + 60_000);
		const retry = f.state.outbox[0].payload as unknown as typeof f.event;
		const second = await f.service.claimBackup(
			retry,
			'replacement-worker',
			60_000
		);
		expect(second).toMatchObject({
			status: 'CLAIMED',
			job: { attempts: 2, leaseOwner: 'replacement-worker' }
		});
		if (first.status !== 'CLAIMED' || second.status !== 'CLAIMED')
			throw new Error('Expected claims');
		expect(second.leaseToken).not.toBe(first.leaseToken);
		await expect(
			f.service.complete(f.event.jobId, first.leaseToken, {})
		).resolves.toBe(false);
		await expect(
			f.service.complete(f.event.jobId, second.leaseToken, {})
		).resolves.toBe(true);
		await expect(
			f.service.claimBackup(retry, 'worker', 60_000)
		).resolves.toEqual({ status: 'TERMINAL' });
	});

	it('allocates a new durable trigger on repeated delivery, including its already published recovery event', async () => {
		const f = fixture(processing(60_000));
		await f.service.claimBackup(f.event, 'worker', 60_000);
		f.state.outbox[0].published = true;
		await f.service.claimBackup(f.event, 'worker', 60_000);
		await f.service.claimBackup(
			f.state.outbox[0].payload as unknown as typeof f.event,
			'worker',
			60_000
		);
		expect(new Set(f.state.outbox.map(item => item.eventId)).size).toBe(3);
		expect(
			new Set(f.state.outbox.map(item => item.deduplicationKey)).size
		).toBe(3);
		expect(
			f.state.outbox.every(
				item =>
					item.eventId === item.payload.eventId &&
					item.eventId !== f.event.eventId
			)
		).toBe(true);
		expect(
			f.state.outbox.every(
				item =>
					Object.keys(item.payload).sort().join(',') ===
					'eventId,jobId,jobType,schemaVersion'
			)
		).toBe(true);
		expect(
			f.transaction.scheduledJobRun.updateMany
		).not.toHaveBeenCalled();
	});

	it('defers a not-yet-available queued job without consuming an attempt', async () => {
		const f = fixture({ availableAt: new Date(now.getTime() + 120_000) });
		await expect(
			f.service.claimBackup(f.event, 'worker', 60_000)
		).resolves.toEqual({ status: 'DEFERRED' });
		expect(f.state.outbox[0].availableAt).toEqual(
			f.state.job!.availableAt
		);
		expect(f.state.job!.attempts).toBe(0);
	});

	it.each(['outbox', 'delay'] as const)(
		'rolls back an incomplete %s deferral instead of proving an ACK',
		async stage => {
			const f = fixture(processing(60_000));
			if (stage === 'outbox')
				f.outbox.enqueue.mockRejectedValueOnce(new Error('Unavailable'));
			else
				f.transaction.outboxEvent.updateMany.mockResolvedValueOnce({
					count: 0
				});
			await expect(
				f.service.claimBackup(f.event, 'worker', 60_000)
			).rejects.toThrow();
			expect(f.state.outbox).toHaveLength(0);
			expect(f.state.job!.status).toBe('PROCESSING');
		}
	);

	it('terminalizes exhausted expired processing with its alert in the same transaction', async () => {
		const f = fixture({ ...processing(0), attempts: 4 });
		await expect(
			f.service.claimBackup(f.event, 'worker', 60_000)
		).resolves.toEqual({ status: 'TERMINAL' });
		expect(f.state.job).toMatchObject({
			status: 'FAILED',
			attempts: 4,
			leaseToken: null,
			leaseExpiresAt: null,
			finishedAt: now
		});
		expect(f.state.alerts).toEqual([
			expect.objectContaining({
				create: expect.objectContaining({
					deduplicationKey: 'database-backup:operations',
					referenceId: f.event.jobId,
					severity: 'HIGH'
				})
			})
		]);
		expect(f.state.outbox).toHaveLength(0);
		await f.service.claimBackup(f.event, 'worker', 60_000);
		expect(f.state.alerts).toHaveLength(1);
	});

	it('rolls back FAILED if the terminal alert cannot be stored', async () => {
		const f = fixture({ ...processing(-1), attempts: 4 });
		f.transaction.operationalAlert.upsert.mockRejectedValueOnce(
			new Error('Unavailable')
		);
		await expect(
			f.service.claimBackup(f.event, 'worker', 60_000)
		).rejects.toThrow('Unavailable');
		expect(f.state.job!.status).toBe('PROCESSING');
	});

	it('never terminalizes a final attempt with a live or concurrently renewed lease', async () => {
		const live = fixture({ ...processing(60_000), attempts: 4 });
		await expect(
			live.service.claimBackup(live.event, 'worker', 60_000)
		).resolves.toEqual({ status: 'DEFERRED' });
		expect(live.state.alerts).toHaveLength(0);
		const race = fixture({ ...processing(-1), attempts: 4 });
		race.race(job => {
			job.leaseExpiresAt = new Date(now.getTime() + 60_000);
		});
		await expect(
			race.service.claimBackup(race.event, 'worker', 60_000)
		).resolves.toEqual({ status: 'REQUEUE' });
		expect(race.state.job!.status).toBe('PROCESSING');
		expect(race.state.alerts).toHaveLength(0);
	});

	it.each(['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED'] as const)(
		'acknowledges terminal %s without restarting it',
		async status => {
			const f = fixture({ status });
			await expect(
				f.service.claimBackup(f.event, 'worker', 60_000)
			).resolves.toEqual({ status: 'TERMINAL' });
			expect(
				f.transaction.scheduledJobRun.updateMany
			).not.toHaveBeenCalled();
			expect(f.state.outbox).toHaveLength(0);
		}
	);

	it.each(['unknown-type', 'wrong-backup-type', 'missing-job'] as const)(
		'rejects %s without claiming or scheduling it',
		async kind => {
			const f = fixture();
			if (kind === 'unknown-type') f.event.jobType = 'DATABASE_RESTORE';
			if (kind === 'wrong-backup-type')
				f.event.jobType = 'WIDGETS_DATABASE_BACKUP';
			if (kind === 'missing-job') f.state.job = null;
			await expect(
				f.service.claimBackup(f.event, 'worker', 60_000)
			).resolves.toEqual({ status: 'REJECT' });
			expect(
				f.transaction.scheduledJobRun.updateMany
			).not.toHaveBeenCalled();
			expect(f.state.outbox).toHaveLength(0);
		}
	);

	it('fails closed on malformed processing lease evidence', async () => {
		const f = fixture({ ...processing(60_000), leaseExpiresAt: null });
		await expect(
			f.service.claimBackup(f.event, 'worker', 60_000)
		).rejects.toThrow('lease is invalid');
		expect(f.state.outbox).toHaveLength(0);
	});

	it('does not fail an expired or replaced lease', async () => {
		const f = fixture(processing(0));
		await expect(
			f.service.fail(
				f.event.jobId,
				f.state.job!.leaseToken!,
				new Error('Failure')
			)
		).resolves.toBe(false);
		expect(
			f.transaction.scheduledJobRun.updateMany
		).not.toHaveBeenCalled();
		const race = fixture(processing(60_000));
		const token = race.state.job!.leaseToken!;
		race.race(job => {
			job.leaseToken = randomUUID();
		});
		await expect(
			race.service.fail(race.event.jobId, token, new Error('Failure'))
		).resolves.toBe(false);
		expect(race.state.outbox).toHaveLength(0);
	});

	it('atomically queues a failed active attempt and its delayed event', async () => {
		const f = fixture(processing(60_000));
		await expect(
			f.service.fail(
				f.event.jobId,
				f.state.job!.leaseToken!,
				new Error('Failure'),
				30_000
			)
		).resolves.toBe(true);
		expect(f.state.job).toMatchObject({
			status: 'QUEUED',
			attempts: 1,
			leaseToken: null
		});
		expect(f.state.outbox[0].availableAt).toEqual(
			f.state.job!.availableAt
		);
		expect(
			f.transaction.scheduledJobRun.updateMany.mock.calls[0][0].where
		).toMatchObject({ leaseExpiresAt: { gt: now } });
	});

	it('rejects a failure CAS if expiry changed after the read', async () => {
		const f = fixture(processing(60_000));
		const token = f.state.job!.leaseToken!;
		f.race(job => {
			job.leaseExpiresAt = now;
		});
		await expect(
			f.service.fail(f.event.jobId, token, new Error('Failure'))
		).resolves.toBe(false);
		expect(f.state.job!.status).toBe('PROCESSING');
		expect(f.state.outbox).toHaveLength(0);
	});

	it('records terminal failure and alert together for a live final attempt', async () => {
		const f = fixture({ ...processing(60_000), attempts: 4 });
		await expect(
			f.service.fail(
				f.event.jobId,
				f.state.job!.leaseToken!,
				new Error('Failure')
			)
		).resolves.toBe(true);
		expect(f.state.job).toMatchObject({
			status: 'FAILED',
			leaseToken: null,
			finishedAt: now
		});
		expect(f.state.alerts).toHaveLength(1);
		expect(f.state.outbox).toHaveLength(0);
	});

	it('rolls back failure when delayed retry or terminal alert cannot be persisted', async () => {
		const retry = fixture(processing(60_000));
		retry.transaction.outboxEvent.updateMany.mockResolvedValueOnce({
			count: 0
		});
		await expect(
			retry.service.fail(
				retry.event.jobId,
				retry.state.job!.leaseToken!,
				new Error('Failure')
			)
		).rejects.toThrow();
		expect(retry.state.job!.status).toBe('PROCESSING');
		expect(retry.state.outbox).toHaveLength(0);
		const terminal = fixture({ ...processing(60_000), attempts: 4 });
		terminal.transaction.operationalAlert.upsert.mockRejectedValueOnce(
			new Error('Unavailable')
		);
		await expect(
			terminal.service.fail(
				terminal.event.jobId,
				terminal.state.job!.leaseToken!,
				new Error('Failure')
			)
		).rejects.toThrow();
		expect(terminal.state.job!.status).toBe('PROCESSING');
	});
});
