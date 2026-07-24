import { DatabaseBackupService } from '@/maintenance/database-backup.service';
import { ScheduledTasksService } from '@/maintenance/scheduled-tasks.service';
import { MaintenanceWorkerService } from '@/maintenance/maintenance-worker.service';
import { RabbitMqService } from '@/messaging/rabbitmq.service';
import { PrismaService } from '@/prisma.service';
import { ScheduledJobsService } from '@/scheduled-jobs/scheduled-jobs.service';
import { ScheduledJobRunView } from '@/scheduled-jobs/scheduled-jobs.types';
import { ConfigService } from '@nestjs/config';
import {
	ScheduledJobRunStatus,
	ScheduledJobRunTrigger
} from '@prisma/client';
import type { ConsumeMessage } from 'amqplib';

describe('MaintenanceWorkerService', () => {
	const jobId = '11111111-1111-4111-8111-111111111111';
	const leaseToken = '22222222-2222-4222-8222-222222222222';
	const now = '2026-07-24T00:00:00.000Z';

	const createJob = (
		overrides: Partial<ScheduledJobRunView> = {}
	): ScheduledJobRunView => ({
		id: jobId,
		jobType: 'DATABASE_BACKUP',
		scheduleKey: 'manual:test',
		trigger: ScheduledJobRunTrigger.MANUAL,
		status: ScheduledJobRunStatus.PROCESSING,
		scheduledFor: now,
		periodStart: null,
		periodEnd: null,
		input: {
			chatId: '-100123',
			messageThreadId: 42,
			trigger: 'MANUAL',
			periodStart: null
		},
		checkpoint: {},
		result: null,
		attempts: 1,
		maxAttempts: 4,
		availableAt: now,
		leaseOwner: 'maintenance:test',
		leaseToken,
		leaseExpiresAt: '2026-07-24T00:02:00.000Z',
		startedAt: now,
		finishedAt: null,
		lastError: null,
		createdAt: now,
		updatedAt: now,
		...overrides
	});

	const createMessage = (
		messageId: string = jobId,
		payload: unknown = {
			schemaVersion: 1,
			eventType: 'database.backup.requested.v1',
			jobId
		}
	): ConsumeMessage =>
		({
			content: Buffer.from(JSON.stringify(payload)),
			properties: {
				messageId,
				headers: {}
			}
		}) as ConsumeMessage;

	const createService = (
		config: Record<string, string | undefined> = {}
	) => {
		const job = createJob();
		const rabbitMq = {
			consume: jest.fn().mockResolvedValue(undefined),
			consumeDeadLetter: jest.fn().mockResolvedValue(undefined),
			ack: jest.fn(),
			nack: jest.fn(),
			publishRetry: jest.fn().mockResolvedValue(undefined),
			publishDeadLetter: jest.fn().mockResolvedValue(undefined)
		} as unknown as RabbitMqService;
		const scheduledJobs = {
			claim: jest.fn().mockResolvedValue({
				state: 'claimed',
				job,
				leaseToken
			}),
			renewLease: jest.fn().mockResolvedValue(new Date()),
			completeInTransaction: jest.fn().mockResolvedValue({
				...job,
				status: ScheduledJobRunStatus.SUCCEEDED
			}),
			releaseOrFail: jest.fn()
		} as unknown as ScheduledJobsService;
		const scheduledTasks = {
			getEventForType: jest.fn().mockReturnValue({
				eventType: 'database.backup.requested.v1',
				routingKey: 'database.backup.requested.v1',
				payload: {
					schemaVersion: 1,
					eventType: 'database.backup.requested.v1'
				}
			})
		} as unknown as ScheduledTasksService;
		const transaction = {
			$queryRaw: jest.fn().mockImplementation(statement => {
				const sql = statement.strings.join('?');
				return sql.includes('integration_delivery_failures')
					? []
					: [{ status: ScheduledJobRunStatus.FAILED }];
			}),
			telegramBotSettings: {
				update: jest.fn().mockResolvedValue({})
			},
			integrationDeliveryFailure: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 }),
				upsert: jest.fn().mockResolvedValue({})
			},
			scheduledJobRun: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		};
		const prisma = {
			integrationDeliveryFailure: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			$transaction: jest.fn(callback => callback(transaction))
		} as unknown as PrismaService;
		const backup = {
			createAndSend: jest.fn().mockResolvedValue({
				fileName: 'winwidget.dump',
				fileSize: 123,
				createdAt: now,
				telegramSent: true
			})
		} as unknown as DatabaseBackupService;
		const configService = {
			get: jest.fn((key: string) => config[key])
		} as unknown as ConfigService;

		return {
			service: new MaintenanceWorkerService(
				rabbitMq,
				configService,
				prisma,
				scheduledJobs,
				scheduledTasks,
				backup
			),
			rabbitMq,
			scheduledJobs,
			backup,
			transaction,
			prisma
		};
	};

	it('completes the claimed job before acknowledging the delivery', async () => {
		const {
			service,
			rabbitMq,
			scheduledJobs,
			backup,
			transaction,
			prisma
		} = createService();

		await (service as any).handle('database-backup', createMessage());

		expect(backup.createAndSend).toHaveBeenCalledWith(
			jobId,
			expect.objectContaining({
				chatId: '-100123',
				messageThreadId: 42
			}),
			expect.any(AbortSignal)
		);
		expect(scheduledJobs.completeInTransaction).toHaveBeenCalledWith(
			expect.any(Object),
			jobId,
			leaseToken,
			expect.objectContaining({ telegramSent: true })
		);
		expect(
			transaction.integrationDeliveryFailure.updateMany
		).not.toHaveBeenCalled();
		expect(
			prisma.integrationDeliveryFailure.updateMany
		).toHaveBeenCalledWith({
			where: {
				eventId: jobId,
				integration: 'database-backup',
				resolvedAt: null
			},
			data: {
				resolvedAt: expect.any(Date),
				retryingAt: null
			}
		});
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('keeps a completed backup successful when resolving an old DLQ record fails', async () => {
		const { service, rabbitMq, scheduledJobs, prisma } = createService();
		(
			prisma.integrationDeliveryFailure.updateMany as jest.Mock
		).mockRejectedValue(new Error('Delivery failure row is locked'));

		await (service as any).handle('database-backup', createMessage());

		expect(scheduledJobs.completeInTransaction).toHaveBeenCalledTimes(1);
		expect(scheduledJobs.releaseOrFail).not.toHaveBeenCalled();
		expect(rabbitMq.publishRetry).not.toHaveBeenCalled();
		expect(rabbitMq.publishDeadLetter).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('uses the originally claimed lease when persisting an Outbox retry', async () => {
		const { service, rabbitMq, scheduledJobs, backup } = createService();
		(backup.createAndSend as jest.Mock).mockRejectedValue(
			new Error('Telegram unavailable')
		);
		(scheduledJobs.releaseOrFail as jest.Mock).mockResolvedValue({
			state: 'retry_scheduled',
			job: createJob({
				status: ScheduledJobRunStatus.QUEUED,
				leaseToken: null,
				leaseOwner: null,
				leaseExpiresAt: null,
				lastError: 'Telegram unavailable'
			})
		});

		await (service as any).handle('database-backup', createMessage());

		expect(scheduledJobs.releaseOrFail).toHaveBeenCalledWith(
			jobId,
			leaseToken,
			expect.any(Error),
			30_000,
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(rabbitMq.publishRetry).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('acknowledges a stale delivery after its lease has already been lost', async () => {
		const { service, rabbitMq, scheduledJobs, backup } = createService();
		(backup.createAndSend as jest.Mock).mockRejectedValue(
			new Error('Lease lost')
		);
		(scheduledJobs.releaseOrFail as jest.Mock).mockResolvedValue({
			state: 'lost'
		});

		await (service as any).handle('database-backup', createMessage());

		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('dead-letters a missing durable job instead of requeueing forever', async () => {
		const { service, rabbitMq, scheduledJobs } = createService();
		(scheduledJobs.claim as jest.Mock).mockResolvedValue({
			state: 'not_found'
		});

		await (service as any).handle('database-backup', createMessage());

		expect(rabbitMq.publishDeadLetter).toHaveBeenCalledWith(
			'database-backup',
			expect.any(Object),
			0,
			jobId,
			expect.stringContaining('job not found'),
			'database.backup.requested.v1'
		);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('uses a delayed broker retry when PostgreSQL fails before the job claim', async () => {
		const { service, rabbitMq, scheduledJobs, backup } = createService();
		(scheduledJobs.claim as jest.Mock).mockRejectedValue(
			new Error('PostgreSQL unavailable')
		);

		await (service as any).handle('database-backup', createMessage());

		expect(backup.createAndSend).not.toHaveBeenCalled();
		expect(rabbitMq.publishRetry).toHaveBeenCalledWith(
			'database-backup',
			expect.any(Object),
			1,
			jobId,
			'database.backup.requested.v1'
		);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('does not claim or execute a durable job of another type', async () => {
		const { service, rabbitMq, scheduledJobs, backup } = createService();
		(scheduledJobs.claim as jest.Mock).mockResolvedValue({
			state: 'busy',
			job: createJob({ jobType: 'DAILY_TELEGRAM_SUMMARY' })
		});

		await (service as any).handle('database-backup', createMessage());

		expect(scheduledJobs.claim).toHaveBeenCalledWith(
			jobId,
			expect.any(String),
			120_000,
			'DATABASE_BACKUP'
		);
		expect(backup.createAndSend).not.toHaveBeenCalled();
		expect(rabbitMq.publishDeadLetter).toHaveBeenCalledWith(
			'database-backup',
			expect.any(Object),
			0,
			jobId,
			'Unexpected database backup job type: DAILY_TELEGRAM_SUMMARY',
			'database.backup.requested.v1'
		);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('acknowledges busy duplicates without creating another broker retry', async () => {
		const { service, rabbitMq, scheduledJobs } = createService();
		(scheduledJobs.claim as jest.Mock).mockResolvedValue({
			state: 'busy',
			job: createJob()
		});

		await (service as any).handle('database-backup', createMessage());

		expect(rabbitMq.publishRetry).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('replaces an invalid Rabbit message id before sending malformed input to DLQ', async () => {
		const { service, rabbitMq } = createService();

		await (service as any).handle(
			'database-backup',
			createMessage('not-a-uuid')
		);

		expect(rabbitMq.publishDeadLetter).toHaveBeenCalledWith(
			'database-backup',
			expect.any(Object),
			0,
			expect.stringMatching(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
			),
			'Invalid database backup event payload',
			'database.backup.requested.v1'
		);
		expect(
			(rabbitMq.publishDeadLetter as jest.Mock).mock.calls[0][3]
		).not.toBe('not-a-uuid');
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('does not let a stale DLQ delivery fail a job reopened for manual retry', async () => {
		const { service, rabbitMq, transaction } = createService();
		transaction.$queryRaw.mockImplementation(statement => {
			const sql = statement.strings.join('?');
			return sql.includes('integration_delivery_failures')
				? [{ id: 'failure-1' }]
				: [{ status: ScheduledJobRunStatus.QUEUED }];
		});
		const message = createMessage();
		message.properties.headers = {
			'x-retry-attempt': 4,
			'x-last-error': 'Telegram unavailable'
		};

		await (service as any).collectDeadLetter('database-backup', message);

		expect(
			transaction.integrationDeliveryFailure.upsert
		).not.toHaveBeenCalled();
		expect(
			(
				transaction.$queryRaw.mock.calls[1][0] as {
					strings: string[];
				}
			).strings.join('?')
		).toContain('FOR SHARE');
		expect(
			(
				transaction.$queryRaw.mock.calls[0][0] as {
					strings: string[];
				}
			).strings.join('?')
		).toContain('FOR UPDATE');
		expect(transaction.scheduledJobRun.updateMany).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('persists a malformed DLQ message under a safe UUID', async () => {
		const { service, rabbitMq, transaction } = createService();
		const message = createMessage('invalid-id', { malformed: true });

		await (service as any).collectDeadLetter('database-backup', message);

		const eventId =
			transaction.integrationDeliveryFailure.upsert.mock.calls[0][0].create
				.eventId;
		expect(eventId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
		);
		expect(eventId).not.toBe('invalid-id');
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('forces one in-flight backup even if a larger prefetch is configured', async () => {
		const { service, rabbitMq } = createService({
			MAINTENANCE_WORKER_PREFETCH: '5'
		});

		await service.onModuleInit();

		expect(rabbitMq.consume).toHaveBeenCalledWith(
			'database-backup',
			expect.any(Function),
			1
		);
		expect(rabbitMq.consumeDeadLetter).toHaveBeenCalledWith(
			'database-backup',
			expect.any(Function),
			1
		);
	});
});
