import { DatabaseBackupService } from '@/maintenance/database-backup.service';
import { ScheduledTasksService } from '@/maintenance/scheduled-tasks.service';
import { MaintenanceWorkerService } from '@/maintenance/maintenance-worker.service';
import type { MessagingHeartbeatService } from '@/messaging/messaging-heartbeat.service';
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
		jobType: 'NOTIFICATION_DELIVERY_DATABASE_BACKUP',
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
			jobId,
			jobType: 'NOTIFICATION_DELIVERY_DATABASE_BACKUP',
			scheduleKey: 'manual:test',
			periodStart: null,
			periodEnd: null
		}
	): ConsumeMessage =>
		({
			content: Buffer.from(JSON.stringify(payload)),
			fields: {
				routingKey: 'database.backup.requested.v1'
			},
			properties: {
				messageId,
				type: 'database.backup.requested.v1',
				headers: {}
			}
		}) as ConsumeMessage;

	const createService = (
		config: Record<string, string | undefined> = {},
		jobOverrides: Partial<ScheduledJobRunView> = {}
	) => {
		const job = createJob(jobOverrides);
		const rabbitMq = {
			consume: jest.fn().mockResolvedValue(undefined),
			consumeDeadLetter: jest.fn().mockResolvedValue(undefined),
			cancelConsumers: jest.fn().mockResolvedValue(undefined),
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
			requeueInterrupted: jest.fn(),
			releaseOrFail: jest.fn()
		} as unknown as ScheduledJobsService;
		const scheduledTasks = {
			getEventForType: jest.fn().mockReturnValue({
				eventType: 'database.backup.requested.v1',
				routingKey: 'database.backup.requested.v1',
				deadLetterRoutingKey: 'database-backup.dead-letter',
				payload: {
					schemaVersion: 1,
					eventType: 'database.backup.requested.v1'
				}
			})
		} as unknown as ScheduledTasksService;
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			$queryRaw: jest.fn().mockImplementation(statement => {
				const sql = statement.strings.join('?');
				return sql.includes('integration_delivery_failures')
					? []
					: [{ status: ScheduledJobRunStatus.FAILED, attempts: 0 }];
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
				fileName: 'winwidget-db.dump',
				fileSize: 123,
				fileSha256: 'a'.repeat(64),
				createdAt: now,
				telegramSent: true,
				telegramReceipt: {
					messageId: 41,
					chatId: '-100123',
					messageThreadId: 42,
					fileId: 'telegram-file-id',
					fileUniqueId: 'telegram-file-unique-id'
				}
			})
		} as unknown as DatabaseBackupService;
		const configService = {
			get: jest.fn((key: string) => config[key])
		} as unknown as ConfigService;
		const heartbeat = {
			markSuccessfulConsume: jest.fn()
		} as unknown as MessagingHeartbeatService;

		return {
			service: new MaintenanceWorkerService(
				rabbitMq,
				configService,
				prisma,
				scheduledJobs,
				scheduledTasks,
				backup,
				heartbeat
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
			'notification-delivery',
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
			{
				fileName: 'winwidget-db.dump',
				fileSize: 123,
				fileSha256: 'a'.repeat(64),
				createdAt: now,
				telegramSent: true,
				telegramReceipt: {
					messageId: 41,
					chatId: '-100123',
					messageThreadId: 42,
					fileId: 'telegram-file-id',
					fileUniqueId: 'telegram-file-unique-id'
				}
			}
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
				retryingAt: null,
				resolution: 'DELIVERED',
				resolutionComment: null,
				resolvedById: null,
				activeRetryToken: null
			}
		});
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('marks the first scheduled service backup without changing shared settings updated_at', async () => {
		const { service, transaction } = createService(
			{},
			{
				scheduleKey: '2026-07-24',
				trigger: ScheduledJobRunTrigger.SCHEDULED,
				periodStart: now,
				periodEnd: '2026-07-25T00:00:00.000Z',
				input: {
					chatId: '-100123',
					messageThreadId: 42,
					trigger: 'SCHEDULED',
					periodStart: now
				}
			}
		);

		await (service as any).handle('database-backup', createMessage());

		expect(transaction.$executeRaw).toHaveBeenCalledTimes(1);
		const [query, periodStart, completedAt] = transaction.$executeRaw.mock
			.calls[0] as [TemplateStringsArray, Date, Date];
		const sql = query.join('?');
		expect(sql).toContain('UPDATE "telegram_bot_settings"');
		expect(sql).toContain('"database_backup_last_sent_period_start"');
		expect(sql).toContain('"database_backup_last_sent_at"');
		expect(sql).not.toContain('"updated_at"');
		expect(periodStart).toEqual(new Date(now));
		expect(completedAt).toEqual(expect.any(Date));
		expect(transaction.telegramBotSettings.update).not.toHaveBeenCalled();
	});

	it('rejects the first scheduled service completion when the settings singleton is missing', async () => {
		const { service, rabbitMq, scheduledJobs, transaction, prisma } =
			createService(
				{},
				{
					scheduleKey: '2026-07-24',
					trigger: ScheduledJobRunTrigger.SCHEDULED,
					periodStart: now,
					periodEnd: '2026-07-25T00:00:00.000Z',
					input: {
						chatId: '-100123',
						messageThreadId: 42,
						trigger: 'SCHEDULED',
						periodStart: now
					}
				}
			);
		transaction.$executeRaw.mockResolvedValue(0);
		(scheduledJobs.releaseOrFail as jest.Mock).mockResolvedValue({
			state: 'retry_scheduled',
			job: createJob({
				status: ScheduledJobRunStatus.QUEUED,
				leaseOwner: null,
				leaseToken: null,
				leaseExpiresAt: null,
				lastError: 'Database backup settings singleton is missing'
			})
		});

		await (service as any).handle('database-backup', createMessage());

		expect(scheduledJobs.releaseOrFail).toHaveBeenCalledWith(
			jobId,
			leaseToken,
			expect.objectContaining({
				message: 'Database backup settings singleton is missing'
			}),
			30_000,
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(
			prisma.integrationDeliveryFailure.updateMany
		).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('executes notification-delivery as an independent backup target', async () => {
		const notificationJobType = 'NOTIFICATION_DELIVERY_DATABASE_BACKUP';
		const { service, backup, scheduledJobs, transaction } = createService(
			{},
			{
				jobType: notificationJobType,
				scheduleKey: '2026-07-24',
				trigger: ScheduledJobRunTrigger.SCHEDULED,
				periodStart: now,
				periodEnd: '2026-07-25T00:00:00.000Z',
				input: {
					chatId: '-100123',
					messageThreadId: 42,
					trigger: 'SCHEDULED',
					periodStart: now
				}
			}
		);
		const message = createMessage(jobId, {
			schemaVersion: 1,
			eventType: 'database.backup.requested.v1',
			jobId,
			jobType: notificationJobType,
			scheduleKey: '2026-07-24',
			periodStart: now,
			periodEnd: '2026-07-25T00:00:00.000Z'
		});

		await (service as any).handle('database-backup', message);

		expect(scheduledJobs.claim).toHaveBeenCalledWith(
			jobId,
			expect.any(String),
			120_000,
			notificationJobType,
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(backup.createAndSend).toHaveBeenCalledWith(
			jobId,
			'notification-delivery',
			expect.objectContaining({ trigger: 'SCHEDULED' }),
			expect.any(AbortSignal)
		);
		expect(transaction.telegramBotSettings.update).not.toHaveBeenCalled();
	});

	it('executes Reporting as an independent backup target', async () => {
		const reportingJobType = 'REPORTING_DATABASE_BACKUP';
		const { service, backup, scheduledJobs, transaction } = createService(
			{},
			{
				jobType: reportingJobType,
				scheduleKey: '2026-07-24',
				trigger: ScheduledJobRunTrigger.SCHEDULED,
				periodStart: now,
				periodEnd: '2026-07-25T00:00:00.000Z',
				input: {
					chatId: '-100123',
					messageThreadId: 42,
					trigger: 'SCHEDULED',
					periodStart: now
				}
			}
		);
		const message = createMessage(jobId, {
			schemaVersion: 1,
			eventType: 'database.backup.requested.v1',
			jobId,
			jobType: reportingJobType,
			scheduleKey: '2026-07-24',
			periodStart: now,
			periodEnd: '2026-07-25T00:00:00.000Z'
		});

		await (service as any).handle('database-backup', message);

		expect(scheduledJobs.claim).toHaveBeenCalledWith(
			jobId,
			expect.any(String),
			120_000,
			reportingJobType,
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(backup.createAndSend).toHaveBeenCalledWith(
			jobId,
			'reporting',
			expect.objectContaining({ trigger: 'SCHEDULED' }),
			expect.any(AbortSignal)
		);
		expect(transaction.telegramBotSettings.update).not.toHaveBeenCalled();
	});

	it('executes Widgets as an independent backup target', async () => {
		const widgetsJobType = 'WIDGETS_DATABASE_BACKUP';
		const { service, backup, scheduledJobs, transaction } = createService(
			{},
			{
				jobType: widgetsJobType,
				scheduleKey: '2026-07-24',
				trigger: ScheduledJobRunTrigger.SCHEDULED,
				periodStart: now,
				periodEnd: '2026-07-25T00:00:00.000Z',
				input: {
					chatId: '-100123',
					messageThreadId: 42,
					trigger: 'SCHEDULED',
					periodStart: now
				}
			}
		);
		const message = createMessage(jobId, {
			schemaVersion: 1,
			eventType: 'database.backup.requested.v1',
			jobId,
			jobType: widgetsJobType,
			scheduleKey: '2026-07-24',
			periodStart: now,
			periodEnd: '2026-07-25T00:00:00.000Z'
		});

		await (service as any).handle('database-backup', message);

		expect(scheduledJobs.claim).toHaveBeenCalledWith(
			jobId,
			expect.any(String),
			120_000,
			widgetsJobType,
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(backup.createAndSend).toHaveBeenCalledWith(
			jobId,
			'widgets',
			expect.objectContaining({ trigger: 'SCHEDULED' }),
			expect.any(AbortSignal)
		);
		expect(transaction.telegramBotSettings.update).not.toHaveBeenCalled();
	});

	it.each([
		['Identity', 'IDENTITY_DATABASE_BACKUP', 'identity'],
		['Platform', 'PLATFORM_DATABASE_BACKUP', 'platform']
	])(
		'executes %s as an independent backup target',
		async (_, jobType, target) => {
			const { service, backup, scheduledJobs, transaction } =
				createService(
					{},
					{
						jobType,
						scheduleKey: '2026-07-24',
						trigger: ScheduledJobRunTrigger.SCHEDULED,
						periodStart: now,
						periodEnd: '2026-07-25T00:00:00.000Z',
						input: {
							chatId: '-100123',
							messageThreadId: 42,
							trigger: 'SCHEDULED',
							periodStart: now
						}
					}
				);
			const message = createMessage(jobId, {
				schemaVersion: 1,
				eventType: 'database.backup.requested.v1',
				jobId,
				jobType,
				scheduleKey: '2026-07-24',
				periodStart: now,
				periodEnd: '2026-07-25T00:00:00.000Z'
			});

			await (service as any).handle('database-backup', message);

			expect(scheduledJobs.claim).toHaveBeenCalledWith(
				jobId,
				expect.any(String),
				120_000,
				jobType,
				expect.objectContaining({
					eventType: 'database.backup.requested.v1'
				})
			);
			expect(backup.createAndSend).toHaveBeenCalledWith(
				jobId,
				target,
				expect.objectContaining({ trigger: 'SCHEDULED' }),
				expect.any(AbortSignal)
			);
			expect(
				transaction.telegramBotSettings.update
			).not.toHaveBeenCalled();
		}
	);

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

	it('does not republish a DLQ message after the terminal intent was persisted', async () => {
		const { service, rabbitMq, scheduledJobs, backup } = createService();
		(scheduledJobs.claim as jest.Mock).mockResolvedValue({
			state: 'terminal',
			job: createJob({
				status: ScheduledJobRunStatus.FAILED,
				finishedAt: now,
				lastError: 'Backup failed'
			})
		});

		await (service as any).handle('database-backup', createMessage());

		expect(backup.createAndSend).not.toHaveBeenCalled();
		expect(rabbitMq.publishDeadLetter).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
	});

	it('acks a newly failed job without direct DLQ publication', async () => {
		const { service, rabbitMq, scheduledJobs, backup } = createService();
		(backup.createAndSend as jest.Mock).mockRejectedValue(
			new Error('Backup failed')
		);
		(scheduledJobs.releaseOrFail as jest.Mock).mockResolvedValue({
			state: 'failed',
			job: createJob({
				status: ScheduledJobRunStatus.FAILED,
				finishedAt: now,
				lastError: 'Backup failed'
			})
		});

		await (service as any).handle('database-backup', createMessage());

		expect(rabbitMq.publishDeadLetter).not.toHaveBeenCalled();
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
			job: createJob({ jobType: 'UNSUPPORTED_MAINTENANCE_JOB' })
		});

		await (service as any).handle('database-backup', createMessage());

		expect(scheduledJobs.claim).toHaveBeenCalledWith(
			jobId,
			expect.any(String),
			120_000,
			'NOTIFICATION_DELIVERY_DATABASE_BACKUP',
			expect.objectContaining({
				deadLetterRoutingKey: 'database-backup.dead-letter'
			})
		);
		expect(backup.createAndSend).not.toHaveBeenCalled();
		expect(rabbitMq.publishDeadLetter).toHaveBeenCalledWith(
			'database-backup',
			expect.any(Object),
			0,
			jobId,
			'Unexpected database backup job type: UNSUPPORTED_MAINTENANCE_JOB',
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

	it('uses the same deterministic ID for malformed redeliveries', async () => {
		const { service, rabbitMq } = createService();

		await (service as any).handle(
			'database-backup',
			createMessage('not-a-uuid')
		);
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
			'messageId must be a UUID',
			'database.backup.requested.v1'
		);
		expect(
			(rabbitMq.publishDeadLetter as jest.Mock).mock.calls[0][3]
		).not.toBe('not-a-uuid');
		expect(
			(rabbitMq.publishDeadLetter as jest.Mock).mock.calls[1][3]
		).toBe((rabbitMq.publishDeadLetter as jest.Mock).mock.calls[0][3]);
		expect(rabbitMq.ack).toHaveBeenCalledTimes(2);
	});

	it('does not let a stale DLQ delivery fail a job reopened for manual retry', async () => {
		const { service, rabbitMq, transaction } = createService();
		transaction.$queryRaw.mockImplementation(statement => {
			const sql = statement.strings.join('?');
			return sql.includes('integration_delivery_failures')
				? [{ resolvedAt: null }]
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

	it('does not let an older DLQ attempt overwrite a newer terminal failure', async () => {
		const { service, rabbitMq, transaction } = createService();
		transaction.$queryRaw.mockImplementation(statement => {
			const sql = statement.strings.join('?');
			return sql.includes('integration_delivery_failures')
				? [{ resolvedAt: null }]
				: [{ status: ScheduledJobRunStatus.FAILED, attempts: 8 }];
		});
		const message = createMessage();
		message.properties.headers = {
			'x-retry-attempt': 4,
			'x-last-error': 'Old backup failure'
		};

		await (service as any).collectDeadLetter('database-backup', message);

		expect(
			transaction.integrationDeliveryFailure.upsert
		).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('ignores a late backup DLQ event after the failure was closed', async () => {
		const { service, rabbitMq, transaction } = createService();
		transaction.$queryRaw.mockImplementation(statement => {
			const sql = statement.strings.join('?');
			return sql.includes('integration_delivery_failures')
				? [{ resolvedAt: new Date('2026-07-24T01:00:00.000Z') }]
				: [{ status: ScheduledJobRunStatus.FAILED }];
		});

		await (service as any).collectDeadLetter(
			'database-backup',
			createMessage()
		);

		expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
		expect(
			transaction.integrationDeliveryFailure.upsert
		).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
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

	it('is ready only after initialization and becomes unready before shutdown drains', async () => {
		const { service, rabbitMq } = createService();
		let finishCancellation!: () => void;
		(rabbitMq.cancelConsumers as jest.Mock).mockReturnValue(
			new Promise<void>(resolve => {
				finishCancellation = resolve;
			})
		);

		expect(service.isReady()).toBe(false);
		await service.onModuleInit();
		expect(service.isReady()).toBe(true);

		const shutdown = service.beforeApplicationShutdown('SIGTERM');
		expect(service.isReady()).toBe(false);

		finishCancellation();
		await shutdown;
	});

	it('waits for active handlers before shutdown', async () => {
		const { service, rabbitMq } = createService();
		let resolveHandler!: () => void;
		const handler = (service as any).trackHandler(
			() =>
				new Promise<void>(resolve => {
					resolveHandler = resolve;
				})
		);
		let shutdownFinished = false;
		const shutdown = service
			.beforeApplicationShutdown('SIGTERM')
			.then(() => {
				shutdownFinished = true;
			});

		await Promise.resolve();
		expect(rabbitMq.cancelConsumers).toHaveBeenCalledTimes(1);
		expect(shutdownFinished).toBe(false);

		resolveHandler();
		await handler;
		await shutdown;

		expect(shutdownFinished).toBe(true);
	});

	it('aborts and atomically requeues an active backup during shutdown', async () => {
		const { service, rabbitMq, scheduledJobs, backup } = createService();
		const shutdownOrder: string[] = [];
		(rabbitMq.cancelConsumers as jest.Mock).mockImplementation(() => {
			shutdownOrder.push('cancel-consumers');
			return Promise.resolve();
		});
		let backupStarted!: () => void;
		const started = new Promise<void>(resolve => {
			backupStarted = resolve;
		});
		(backup.createAndSend as jest.Mock).mockImplementation(
			(_jobId, _target, _input, signal: AbortSignal) =>
				new Promise((_resolve, reject) => {
					backupStarted();
					signal.addEventListener(
						'abort',
						() => {
							shutdownOrder.push('abort-backup');
							reject(signal.reason);
						},
						{ once: true }
					);
				})
		);
		(scheduledJobs.requeueInterrupted as jest.Mock).mockResolvedValue({
			state: 'requeued',
			job: createJob({
				status: ScheduledJobRunStatus.QUEUED,
				attempts: 0,
				leaseOwner: null,
				leaseToken: null,
				leaseExpiresAt: null
			})
		});
		const handler = (service as any).trackHandler(() =>
			(service as any).handle('database-backup', createMessage())
		);
		await started;

		await service.beforeApplicationShutdown('SIGTERM');
		await handler;

		expect(rabbitMq.cancelConsumers).toHaveBeenCalledTimes(1);
		expect(shutdownOrder).toEqual(['cancel-consumers', 'abort-backup']);
		expect(scheduledJobs.requeueInterrupted).toHaveBeenCalledWith(
			jobId,
			leaseToken,
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(scheduledJobs.releaseOrFail).not.toHaveBeenCalled();
		expect(rabbitMq.ack).toHaveBeenCalledTimes(1);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('does not claim a new backup after shutdown starts', async () => {
		const { service, rabbitMq, scheduledJobs, backup } = createService();

		await service.beforeApplicationShutdown('SIGTERM');
		await (service as any).handle('database-backup', createMessage());

		expect(scheduledJobs.claim).not.toHaveBeenCalled();
		expect(backup.createAndSend).not.toHaveBeenCalled();
		expect(rabbitMq.nack).toHaveBeenCalledWith(expect.any(Object), true);
	});

	it('does not classify an existing backup error as a shutdown interruption', async () => {
		const { service } = createService();
		await service.beforeApplicationShutdown('SIGTERM');
		const lease = (service as any).startLeaseRenewal(jobId, leaseToken);
		const backupError = new Error('pg_dump failed');

		expect(lease.signal.aborted).toBe(true);
		expect(lease.wasInterruptedByShutdown(lease.signal.reason)).toBe(true);
		expect(lease.wasInterruptedByShutdown(backupError)).toBe(false);
		await lease.stop();
	});

	it('does not overwrite an earlier lease abort with a shutdown reason', async () => {
		jest.useFakeTimers();
		const { service, scheduledJobs } = createService({
			SCHEDULED_JOB_LEASE_RENEW_INTERVAL_MS: '5000'
		});
		(scheduledJobs.renewLease as jest.Mock).mockResolvedValue(null);
		const lease = (service as any).startLeaseRenewal(jobId, leaseToken);
		(service as any).activeLeases.set(jobId, lease);

		try {
			await jest.advanceTimersByTimeAsync(5_000);
			const leaseError = lease.signal.reason;
			expect(lease.signal.aborted).toBe(true);

			await service.beforeApplicationShutdown('SIGTERM');

			expect(lease.signal.reason).toBe(leaseError);
			expect(lease.wasInterruptedByShutdown(leaseError)).toBe(false);
		} finally {
			await lease.stop();
			jest.useRealTimers();
		}
	});

	it('does not forgive a real backup error that races with shutdown', async () => {
		const { service, scheduledJobs, backup } = createService();
		const backupError = new Error('pg_dump failed');
		let backupStarted!: () => void;
		let rejectBackup!: (error: Error) => void;
		const started = new Promise<void>(resolve => {
			backupStarted = resolve;
		});
		(backup.createAndSend as jest.Mock).mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					rejectBackup = reject;
					backupStarted();
				})
		);
		(scheduledJobs.releaseOrFail as jest.Mock).mockResolvedValue({
			state: 'retry_scheduled',
			job: createJob({
				status: ScheduledJobRunStatus.QUEUED,
				leaseOwner: null,
				leaseToken: null,
				leaseExpiresAt: null,
				lastError: backupError.message
			})
		});
		const handler = (service as any).trackHandler(() =>
			(service as any).handle('database-backup', createMessage())
		);
		await started;

		const shutdown = service.beforeApplicationShutdown('SIGTERM');
		rejectBackup(backupError);
		await handler;
		await shutdown;

		expect(scheduledJobs.releaseOrFail).toHaveBeenCalledWith(
			jobId,
			leaseToken,
			backupError,
			30_000,
			expect.any(Object)
		);
		expect(scheduledJobs.requeueInterrupted).not.toHaveBeenCalled();
	});

	it('requeues a job claimed while shutdown is already in progress', async () => {
		const { service, scheduledJobs, backup } = createService();
		let resolveClaim!: (value: unknown) => void;
		(scheduledJobs.claim as jest.Mock).mockReturnValue(
			new Promise(resolve => {
				resolveClaim = resolve;
			})
		);
		(backup.createAndSend as jest.Mock).mockImplementation(
			(_jobId, _target, _input, signal: AbortSignal) => {
				expect(signal.aborted).toBe(true);
				return Promise.reject(signal.reason);
			}
		);
		(scheduledJobs.requeueInterrupted as jest.Mock).mockResolvedValue({
			state: 'requeued',
			job: createJob({
				status: ScheduledJobRunStatus.QUEUED,
				attempts: 0,
				leaseOwner: null,
				leaseToken: null,
				leaseExpiresAt: null
			})
		});
		const handler = (service as any).trackHandler(() =>
			(service as any).handle('database-backup', createMessage())
		);
		await Promise.resolve();

		const shutdown = service.beforeApplicationShutdown('SIGTERM');
		resolveClaim({
			state: 'claimed',
			job: createJob(),
			leaseToken
		});
		await handler;
		await shutdown;

		expect(backup.createAndSend).toHaveBeenCalledWith(
			jobId,
			'notification-delivery',
			expect.any(Object),
			expect.objectContaining({ aborted: true })
		);
		expect(scheduledJobs.requeueInterrupted).toHaveBeenCalledTimes(1);
		expect(scheduledJobs.releaseOrFail).not.toHaveBeenCalled();
	});

	it('acknowledges a shutdown delivery after its lease ownership changed', async () => {
		const { service, rabbitMq, scheduledJobs } = createService();
		(scheduledJobs.requeueInterrupted as jest.Mock).mockResolvedValue({
			state: 'lost'
		});
		const message = createMessage();

		await (service as any).requeueInterruptedJob(
			message,
			createJob(),
			leaseToken
		);

		expect(rabbitMq.ack).toHaveBeenCalledWith(message);
		expect(rabbitMq.nack).not.toHaveBeenCalled();
	});

	it('requeues the Rabbit delivery when shutdown persistence fails', async () => {
		const { service, rabbitMq, scheduledJobs } = createService();
		(scheduledJobs.requeueInterrupted as jest.Mock).mockRejectedValue(
			new Error('PostgreSQL unavailable')
		);
		const message = createMessage();

		await (service as any).requeueInterruptedJob(
			message,
			createJob(),
			leaseToken
		);

		expect(rabbitMq.ack).not.toHaveBeenCalled();
		expect(rabbitMq.nack).toHaveBeenCalledWith(message, true);
	});

	it('bounds shutdown when consumer cancellation does not settle', async () => {
		jest.useFakeTimers();
		const { service, rabbitMq } = createService();
		(rabbitMq.cancelConsumers as jest.Mock).mockReturnValue(
			new Promise<void>(() => undefined)
		);

		try {
			const shutdown = service.beforeApplicationShutdown('SIGTERM');
			await jest.advanceTimersByTimeAsync(20_000);
			await expect(shutdown).resolves.toBeUndefined();
		} finally {
			jest.useRealTimers();
		}
	});
});
