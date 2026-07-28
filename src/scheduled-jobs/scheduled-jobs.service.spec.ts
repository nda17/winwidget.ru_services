import { PrismaService } from '@/prisma.service';
import { ScheduledJobsService } from '@/scheduled-jobs/scheduled-jobs.service';
import {
	SCHEDULED_JOB_TYPES,
	ScheduledJobOutboxEvent
} from '@/scheduled-jobs/scheduled-jobs.types';
import {
	ScheduledJobRun,
	ScheduledJobRunStatus,
	ScheduledJobRunTrigger
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

describe('ScheduledJobsService', () => {
	const now = new Date('2026-07-24T00:00:00.000Z');
	const event: ScheduledJobOutboxEvent = {
		eventType: 'telegram.daily-summary.requested.v1',
		routingKey: 'telegram.daily-summary.requested.v1',
		deadLetterRoutingKey: 'daily-summary-telegram.dead-letter',
		payload: { schemaVersion: 1 }
	};

	const createJob = (
		overrides: Partial<ScheduledJobRun> = {}
	): ScheduledJobRun => ({
		id: randomUUID(),
		jobType: SCHEDULED_JOB_TYPES.DAILY_TELEGRAM_SUMMARY,
		scheduleKey: '2026-07-23T21:00:00.000Z',
		trigger: ScheduledJobRunTrigger.SCHEDULED,
		status: ScheduledJobRunStatus.QUEUED,
		scheduledFor: now,
		periodStart: new Date('2026-07-22T21:00:00.000Z'),
		periodEnd: new Date('2026-07-23T21:00:00.000Z'),
		input: {},
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
		updatedAt: now,
		...overrides
	});

	const enqueueInput = {
		jobType: SCHEDULED_JOB_TYPES.DAILY_TELEGRAM_SUMMARY,
		scheduleKey: '2026-07-23T21:00:00.000Z',
		scheduledFor: now,
		periodStart: new Date('2026-07-22T21:00:00.000Z'),
		periodEnd: new Date('2026-07-23T21:00:00.000Z')
	};

	it('creates a unique job and its Outbox event in one transaction', async () => {
		const job = createJob();
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ id: job.id }]),
			scheduledJobRun: {
				findUniqueOrThrow: jest.fn().mockResolvedValue(job)
			},
			outboxEvent: {
				create: jest.fn().mockResolvedValue({})
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new ScheduledJobsService(prisma);

		const result = await service.enqueueUnique(enqueueInput, event);

		expect(result.created).toBe(true);
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				messageId: job.id,
				eventType: event.eventType,
				routingKey: event.routingKey,
				payload: expect.objectContaining({
					jobId: job.id,
					jobType: job.jobType,
					periodStart: job.periodStart?.toISOString(),
					periodEnd: job.periodEnd?.toISOString()
				})
			})
		});
	});

	it('does not create a second Outbox event after a schedule-key conflict', async () => {
		const job = createJob();
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			scheduledJobRun: {
				findUniqueOrThrow: jest.fn().mockResolvedValue(job)
			},
			outboxEvent: {
				create: jest.fn()
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new ScheduledJobsService(prisma);

		const result = await service.enqueueUnique(enqueueInput, event);

		expect(result.created).toBe(false);
		expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
		expect(
			transaction.scheduledJobRun.findUniqueOrThrow
		).toHaveBeenCalledWith({
			where: {
				jobType_scheduleKey: {
					jobType: enqueueInput.jobType,
					scheduleKey: enqueueInput.scheduleKey
				}
			}
		});
	});

	it('atomically schedules a retry through the Outbox while attempts remain', async () => {
		const jobId = randomUUID();
		const leaseToken = randomUUID();
		const retryAt = new Date('2026-07-24T00:01:00.000Z');
		const job = createJob({
			id: jobId,
			status: ScheduledJobRunStatus.QUEUED,
			attempts: 1,
			availableAt: retryAt,
			lastError: 'Telegram unavailable'
		});
		const transaction = {
			$queryRaw: jest
				.fn()
				.mockResolvedValueOnce([
					{ id: jobId, attempts: 1, maxAttempts: 4 }
				])
				.mockResolvedValueOnce([{ availableAt: retryAt }]),
			scheduledJobRun: {
				findUniqueOrThrow: jest.fn().mockResolvedValue(job)
			},
			outboxEvent: {
				create: jest.fn().mockResolvedValue({})
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new ScheduledJobsService(prisma);

		const result = await service.releaseOrFail(
			jobId,
			leaseToken,
			new Error('Telegram unavailable'),
			60_000,
			event
		);

		expect(result.state).toBe('retry_scheduled');
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				messageId: jobId,
				availableAt: retryAt
			})
		});
	});

	it('atomically requeues an interrupted job without consuming an attempt', async () => {
		const jobId = randomUUID();
		const leaseToken = randomUUID();
		const job = createJob({
			id: jobId,
			status: ScheduledJobRunStatus.QUEUED,
			attempts: 0,
			availableAt: now
		});
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ availableAt: now }]),
			scheduledJobRun: {
				findUniqueOrThrow: jest.fn().mockResolvedValue(job)
			},
			outboxEvent: {
				create: jest.fn().mockResolvedValue({})
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new ScheduledJobsService(prisma);

		const result = await service.requeueInterrupted(
			jobId,
			leaseToken,
			event
		);

		expect(result.state).toBe('requeued');
		const requeueSql = transaction.$queryRaw.mock.calls[0][0] as {
			strings: string[];
			values: unknown[];
		};
		expect(requeueSql.strings.join('?')).toContain(
			'GREATEST("attempts" - 1, 0)'
		);
		expect(requeueSql.strings.join('?')).toContain(
			'AND "lease_token" = ?::uuid'
		);
		expect(requeueSql.values).toContain(leaseToken);
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				messageId: jobId,
				availableAt: now
			})
		});
	});

	it('does not requeue an interrupted job after lease ownership changed', async () => {
		const jobId = randomUUID();
		const leaseToken = randomUUID();
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			scheduledJobRun: {
				findUniqueOrThrow: jest.fn()
			},
			outboxEvent: {
				create: jest.fn()
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new ScheduledJobsService(prisma);

		await expect(
			service.requeueInterrupted(jobId, leaseToken, event)
		).resolves.toEqual({ state: 'lost' });
		expect(
			transaction.scheduledJobRun.findUniqueOrThrow
		).not.toHaveBeenCalled();
		expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
	});

	it('atomically marks an exhausted job failed and creates its DLQ intent', async () => {
		const jobId = randomUUID();
		const leaseToken = randomUUID();
		const job = createJob({
			id: jobId,
			status: ScheduledJobRunStatus.FAILED,
			attempts: 4,
			finishedAt: now,
			lastError: 'Backup failed'
		});
		const transaction = {
			$queryRaw: jest
				.fn()
				.mockResolvedValue([{ id: jobId, attempts: 4, maxAttempts: 4 }]),
			$executeRaw: jest.fn().mockResolvedValue(1),
			scheduledJobRun: {
				findUniqueOrThrow: jest.fn().mockResolvedValue(job)
			},
			outboxEvent: {
				create: jest.fn().mockResolvedValue({})
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new ScheduledJobsService(prisma);

		const result = await service.releaseOrFail(
			jobId,
			leaseToken,
			new Error('Backup failed'),
			60_000,
			event
		);

		expect(result.state).toBe('failed');
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				messageId: jobId,
				deduplicationKey: `scheduled-job:${jobId}:dead-letter:4`,
				routingKey: event.deadLetterRoutingKey,
				headers: expect.objectContaining({
					'x-retry-attempt': 4,
					'x-last-error': 'Backup failed'
				})
			})
		});
	});

	it('forces a non-exhausted job to fail when retry is not allowed', async () => {
		const jobId = randomUUID();
		const leaseToken = randomUUID();
		const job = createJob({
			id: jobId,
			status: ScheduledJobRunStatus.FAILED,
			attempts: 1,
			maxAttempts: 4,
			finishedAt: now,
			lastError: 'Telegram destination is no longer available'
		});
		const transaction = {
			$queryRaw: jest
				.fn()
				.mockResolvedValue([{ id: jobId, attempts: 1, maxAttempts: 4 }]),
			$executeRaw: jest.fn().mockResolvedValue(1),
			scheduledJobRun: {
				findUniqueOrThrow: jest.fn().mockResolvedValue(job)
			},
			outboxEvent: {
				create: jest.fn().mockResolvedValue({})
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new ScheduledJobsService(prisma);

		const result = await service.releaseOrFail(
			jobId,
			leaseToken,
			new Error('Telegram destination is no longer available'),
			60_000,
			event,
			{ allowRetry: false }
		);

		expect(result.state).toBe('failed');
		expect(transaction.$executeRaw).toHaveBeenCalledTimes(1);
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				messageId: jobId,
				deduplicationKey: `scheduled-job:${jobId}:dead-letter:1`,
				routingKey: event.deadLetterRoutingKey
			})
		});
	});

	it('persists one terminal Outbox event when an expired job is exhausted', async () => {
		const processingJob = createJob({
			status: ScheduledJobRunStatus.PROCESSING,
			attempts: 4,
			maxAttempts: 4,
			leaseOwner: 'maintenance-worker:test',
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date('2026-07-23T23:59:00.000Z'),
			startedAt: new Date('2026-07-23T23:50:00.000Z')
		});
		const failedJob = createJob({
			...processingJob,
			status: ScheduledJobRunStatus.FAILED,
			leaseOwner: null,
			leaseToken: null,
			leaseExpiresAt: null,
			finishedAt: now,
			lastError: 'Scheduled job lease expired'
		});
		const transaction = {
			$queryRaw: jest
				.fn()
				.mockResolvedValueOnce([{ id: processingJob.id }])
				.mockResolvedValueOnce([{ availableAt: now }]),
			scheduledJobRun: {
				findMany: jest.fn().mockResolvedValue([processingJob]),
				findUniqueOrThrow: jest.fn().mockResolvedValue(failedJob)
			},
			outboxEvent: {
				create: jest.fn().mockResolvedValue({})
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new ScheduledJobsService(prisma);

		const result = await service.recoverExpired(() => event);

		expect(result).toEqual({ requeued: 0, failed: 1 });
		expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				messageId: failedJob.id,
				deduplicationKey: `scheduled-job:${failedJob.id}:dead-letter:4`,
				routingKey: event.deadLetterRoutingKey,
				headers: expect.objectContaining({
					'x-retry-attempt': 4,
					'x-last-error': 'Scheduled job lease expired'
				}),
				availableAt: now
			})
		});
		const failureSql = transaction.$queryRaw.mock.calls[1][0] as {
			strings: string[];
		};
		const query = failureSql.strings.join('?');
		expect(query.match(/\bWHERE\b/g)).toHaveLength(1);
		expect(query).toContain(
			`"status" = 'FAILED'::"ScheduledJobRunStatus"`
		);
		expect(query).toContain(
			`AND "status" = 'PROCESSING'::"ScheduledJobRunStatus"`
		);
	});

	it('atomically creates a DLQ intent when claim discovers an exhausted job', async () => {
		const failedJob = createJob({
			status: ScheduledJobRunStatus.FAILED,
			attempts: 4,
			maxAttempts: 4,
			finishedAt: now,
			lastError: 'Maximum scheduled job attempts exhausted'
		});
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ id: failedJob.id }]),
			scheduledJobRun: {
				findUniqueOrThrow: jest.fn().mockResolvedValue(failedJob)
			},
			outboxEvent: {
				create: jest.fn().mockResolvedValue({})
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction)),
			$queryRaw: jest.fn().mockResolvedValue([]),
			scheduledJobRun: {
				findUnique: jest.fn().mockResolvedValue(failedJob)
			}
		} as unknown as PrismaService;
		const service = new ScheduledJobsService(prisma);

		await expect(
			service.claim(
				failedJob.id,
				'daily-summary:test',
				120_000,
				SCHEDULED_JOB_TYPES.DAILY_TELEGRAM_SUMMARY,
				event
			)
		).resolves.toEqual({
			state: 'terminal',
			job: expect.objectContaining({
				id: failedJob.id,
				status: ScheduledJobRunStatus.FAILED
			})
		});
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				messageId: failedJob.id,
				deduplicationKey: `scheduled-job:${failedJob.id}:dead-letter:4`,
				routingKey: event.deadLetterRoutingKey,
				headers: expect.objectContaining({
					'x-retry-attempt': 4,
					'x-last-error': 'Maximum scheduled job attempts exhausted'
				})
			})
		});
	});

	it('rejects a period with only one boundary before touching the database', async () => {
		const prisma = {
			$transaction: jest.fn()
		} as unknown as PrismaService;
		const service = new ScheduledJobsService(prisma);

		await expect(
			service.enqueueUnique(
				{
					...enqueueInput,
					periodEnd: null
				},
				event
			)
		).rejects.toThrow(
			'periodStart and periodEnd must be provided together'
		);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it('rejects completion, skip and failure release after the lease expires', async () => {
		const jobId = randomUUID();
		const leaseToken = randomUUID();
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(0),
			$queryRaw: jest.fn().mockResolvedValue([]),
			scheduledJobRun: {
				findUniqueOrThrow: jest.fn()
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction)),
			$executeRaw: jest.fn().mockResolvedValue(0)
		} as unknown as PrismaService;
		const service = new ScheduledJobsService(prisma);

		await expect(
			service.completeInTransaction(transaction as any, jobId, leaseToken)
		).resolves.toBeNull();
		await expect(
			service.skip(jobId, leaseToken, 'No longer needed')
		).resolves.toBeNull();
		await expect(
			service.releaseOrFail(
				jobId,
				leaseToken,
				new Error('Lease lost'),
				30_000,
				event
			)
		).resolves.toEqual({ state: 'lost' });

		const sqlStatements = [
			transaction.$executeRaw.mock.calls[0][0],
			(prisma.$executeRaw as jest.Mock).mock.calls[0][0],
			transaction.$queryRaw.mock.calls[0][0]
		] as Array<{ strings: string[] }>;
		for (const statement of sqlStatements) {
			expect(statement.strings.join('?')).toContain(
				`"lease_expires_at" > NOW()`
			);
		}
		expect(
			transaction.scheduledJobRun.findUniqueOrThrow
		).not.toHaveBeenCalled();
	});

	it('atomically stores the delivery checkpoint before releasing the lease', async () => {
		const jobId = randomUUID();
		const leaseToken = randomUUID();
		const deliveryEventId = randomUUID();
		const waitingJob = createJob({
			id: jobId,
			status: ScheduledJobRunStatus.PROCESSING,
			checkpoint: { deliveryEventId },
			leaseOwner: null,
			leaseToken: null,
			leaseExpiresAt: null
		});
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			scheduledJobRun: {
				findUniqueOrThrow: jest.fn().mockResolvedValue(waitingJob)
			}
		};
		const service = new ScheduledJobsService({} as PrismaService);

		await expect(
			service.awaitExternalDeliveryInTransaction(
				transaction as any,
				jobId,
				leaseToken,
				deliveryEventId,
				{ deliveryEventId }
			)
		).resolves.toEqual(
			expect.objectContaining({
				id: jobId,
				checkpoint: { deliveryEventId },
				leaseToken: null
			})
		);

		const sql = transaction.$executeRaw.mock.calls[0][0] as {
			strings: string[];
			values: unknown[];
		};
		const query = sql.strings.join('?');
		expect(query).toContain(`"checkpoint" = CAST(? AS jsonb)`);
		expect(query).toContain(`"lease_owner" = NULL`);
		expect(query).toContain(`"lease_token" = NULL`);
		expect(query).toContain(`"lease_expires_at" = NULL`);
		expect(sql.values).toContain(JSON.stringify({ deliveryEventId }));
	});

	it('includes the expected job type in exhausted-state and claim CAS updates', async () => {
		const job = createJob();
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			scheduledJobRun: {
				findUniqueOrThrow: jest.fn()
			},
			outboxEvent: {
				create: jest.fn()
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction)),
			$queryRaw: jest.fn().mockResolvedValue([]),
			scheduledJobRun: {
				findUnique: jest.fn().mockResolvedValue(job)
			}
		} as unknown as PrismaService;
		const service = new ScheduledJobsService(prisma);

		await service.claim(
			job.id,
			'daily-summary:test',
			120_000,
			SCHEDULED_JOB_TYPES.DAILY_TELEGRAM_SUMMARY,
			event
		);

		const exhaustedSql = transaction.$queryRaw.mock.calls[0][0] as {
			strings: string[];
			values: unknown[];
		};
		const claimSql = (prisma.$queryRaw as jest.Mock).mock.calls[0][0] as {
			strings: string[];
			values: unknown[];
		};
		for (const statement of [exhaustedSql, claimSql]) {
			expect(statement.strings.join('?')).toContain('AND "job_type" = ?');
			expect(statement.values).toContain(
				SCHEDULED_JOB_TYPES.DAILY_TELEGRAM_SUMMARY
			);
		}
	});
});
