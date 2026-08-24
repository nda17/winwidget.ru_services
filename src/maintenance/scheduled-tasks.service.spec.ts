import { ScheduledTasksService } from '@/maintenance/scheduled-tasks.service';
import type { PrismaService } from '@/prisma.service';
import type { ScheduledJobsService } from '@/scheduled-jobs/scheduled-jobs.service';
import type { ConfigService } from '@nestjs/config';
import {
	ScheduledJobRun,
	ScheduledJobRunStatus,
	ScheduledJobRunTrigger
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

describe('ScheduledTasksService', () => {
	const period = {
		start: new Date('2026-07-22T21:00:00.000Z'),
		end: new Date('2026-07-23T21:00:00.000Z'),
		key: '2026-07-23'
	};
	const scheduledFor = new Date('2026-07-23T22:50:00.000Z');

	const createService = (lastSentPeriodStart: Date | null = null) => {
		const transaction = {
			telegramBotSettings: {
				upsert: jest.fn().mockResolvedValue({
					dailySummaryChatId: ' -100123 ',
					databaseBackupEnabled: true,
					databaseBackupThreadId: 43,
					databaseBackupLastSentPeriodStart: lastSentPeriodStart
				}),
				findUniqueOrThrow: jest.fn().mockResolvedValue({
					dailySummaryChatId: ' -100123 ',
					databaseBackupEnabled: true,
					databaseBackupThreadId: 43,
					databaseBackupLastSentPeriodStart: lastSentPeriodStart
				})
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction)),
			telegramBotSettings: {
				upsert: jest.fn().mockResolvedValue({
					dailySummaryChatId: ' -100123 ',
					databaseBackupEnabled: true,
					databaseBackupThreadId: 43,
					databaseBackupLastSentPeriodStart: lastSentPeriodStart
				})
			}
		} as unknown as PrismaService;
		const scheduledJobs = {
			enqueueUnique: jest.fn().mockResolvedValue({
				created: true,
				job: { id: '11111111-1111-4111-8111-111111111111' }
			}),
			enqueueUniqueInTransaction: jest
				.fn()
				.mockImplementation((_transaction, input) =>
					Promise.resolve({
						created: true,
						job: {
							id: {
								NOTIFICATION_DELIVERY_DATABASE_BACKUP:
									'22222222-2222-4222-8222-222222222222',
								CAMPAIGNS_DATABASE_BACKUP:
									'33333333-3333-4333-8333-333333333333',
								REPORTING_DATABASE_BACKUP:
									'44444444-4444-4444-8444-444444444444',
								WIDGETS_DATABASE_BACKUP:
									'55555555-5555-4555-8555-555555555555',
								BILLING_DATABASE_BACKUP:
									'66666666-6666-4666-8666-666666666666',
								IDENTITY_DATABASE_BACKUP:
									'77777777-7777-4777-8777-777777777777',
								PLATFORM_DATABASE_BACKUP:
									'88888888-8888-4888-8888-888888888888'
							}[input.jobType]
						}
					})
				)
		} as unknown as ScheduledJobsService;
		const service = new ScheduledTasksService(prisma, scheduledJobs, {
			get: jest.fn((key: string) =>
				key === 'TELEGRAM_INFO_BOT_TOKEN' ? 'telegram-token' : undefined
			)
		} as unknown as ConfigService);
		return { service, scheduledJobs, transaction, prisma };
	};

	it('creates independent service-owned database backup jobs', async () => {
		const { service, scheduledJobs, transaction } = createService();
		const scheduleStart = new Date('2026-07-23T22:45:00.000Z');
		const notificationScheduledFor = new Date('2026-07-23T23:00:00.000Z');
		const campaignsScheduledFor = new Date('2026-07-23T23:15:00.000Z');
		const reportingScheduledFor = new Date('2026-07-23T23:30:00.000Z');
		const widgetsScheduledFor = new Date('2026-07-23T23:45:00.000Z');
		const billingScheduledFor = new Date('2026-07-24T00:00:00.000Z');
		const identityScheduledFor = new Date('2026-07-24T00:15:00.000Z');
		const platformScheduledFor = new Date('2026-07-24T00:30:00.000Z');

		const result = await service.enqueueDailyDatabaseBackups(
			period,
			scheduleStart
		);

		expect(result?.notificationDelivery.job.id).toBe(
			'22222222-2222-4222-8222-222222222222'
		);
		expect(result?.campaigns.job.id).toBe(
			'33333333-3333-4333-8333-333333333333'
		);
		expect(result?.reporting.job.id).toBe(
			'44444444-4444-4444-8444-444444444444'
		);
		expect(result?.widgets.job.id).toBe(
			'55555555-5555-4555-8555-555555555555'
		);
		expect(result?.billing.job.id).toBe(
			'66666666-6666-4666-8666-666666666666'
		);
		expect(result?.identity.job.id).toBe(
			'77777777-7777-4777-8777-777777777777'
		);
		expect(result?.platform.job.id).toBe(
			'88888888-8888-4888-8888-888888888888'
		);
		expect(
			scheduledJobs.enqueueUniqueInTransaction
		).toHaveBeenNthCalledWith(
			1,
			transaction,
			expect.objectContaining({
				jobType: 'NOTIFICATION_DELIVERY_DATABASE_BACKUP',
				scheduledFor: notificationScheduledFor,
				availableAt: notificationScheduledFor
			}),
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(
			scheduledJobs.enqueueUniqueInTransaction
		).toHaveBeenNthCalledWith(
			2,
			transaction,
			expect.objectContaining({
				jobType: 'CAMPAIGNS_DATABASE_BACKUP',
				scheduledFor: campaignsScheduledFor,
				availableAt: campaignsScheduledFor
			}),
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(
			scheduledJobs.enqueueUniqueInTransaction
		).toHaveBeenNthCalledWith(
			3,
			transaction,
			expect.objectContaining({
				jobType: 'REPORTING_DATABASE_BACKUP',
				scheduledFor: reportingScheduledFor,
				availableAt: reportingScheduledFor
			}),
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(
			scheduledJobs.enqueueUniqueInTransaction
		).toHaveBeenNthCalledWith(
			4,
			transaction,
			expect.objectContaining({
				jobType: 'WIDGETS_DATABASE_BACKUP',
				scheduledFor: widgetsScheduledFor,
				availableAt: widgetsScheduledFor
			}),
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(
			scheduledJobs.enqueueUniqueInTransaction
		).toHaveBeenNthCalledWith(
			5,
			transaction,
			expect.objectContaining({
				jobType: 'BILLING_DATABASE_BACKUP',
				scheduledFor: billingScheduledFor,
				availableAt: billingScheduledFor
			}),
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(
			scheduledJobs.enqueueUniqueInTransaction
		).toHaveBeenNthCalledWith(
			6,
			transaction,
			expect.objectContaining({
				jobType: 'IDENTITY_DATABASE_BACKUP',
				scheduledFor: identityScheduledFor,
				availableAt: identityScheduledFor
			}),
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(
			scheduledJobs.enqueueUniqueInTransaction
		).toHaveBeenNthCalledWith(
			7,
			transaction,
			expect.objectContaining({
				jobType: 'PLATFORM_DATABASE_BACKUP',
				scheduledFor: platformScheduledFor,
				availableAt: platformScheduledFor
			}),
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
	});

	it('enqueues all database backups as separate jobs in one transaction', async () => {
		const transaction = {};
		const prisma = {
			telegramBotSettings: {
				upsert: jest.fn().mockResolvedValue({
					databaseBackupEnabled: true,
					databaseBackupLastSentPeriodStart: null,
					dailySummaryChatId: ' -100123 ',
					databaseBackupThreadId: 43
				})
			},
			$transaction: jest.fn(callback => callback(transaction))
		} as unknown as PrismaService;
		const scheduledJobs = {
			enqueueUniqueInTransaction: jest.fn((_transaction, input) =>
				Promise.resolve({
					created: true,
					job: {
						id: {
							NOTIFICATION_DELIVERY_DATABASE_BACKUP:
								'22222222-2222-4222-8222-222222222222',
							CAMPAIGNS_DATABASE_BACKUP:
								'33333333-3333-4333-8333-333333333333',
							REPORTING_DATABASE_BACKUP:
								'44444444-4444-4444-8444-444444444444',
							WIDGETS_DATABASE_BACKUP:
								'55555555-5555-4555-8555-555555555555',
							BILLING_DATABASE_BACKUP:
								'66666666-6666-4666-8666-666666666666',
							IDENTITY_DATABASE_BACKUP:
								'77777777-7777-4777-8777-777777777777',
							PLATFORM_DATABASE_BACKUP:
								'88888888-8888-4888-8888-888888888888'
						}[input.jobType]
					}
				})
			)
		} as unknown as ScheduledJobsService;
		const service = new ScheduledTasksService(prisma, scheduledJobs, {
			get: jest.fn().mockReturnValue('telegram-token')
		} as unknown as ConfigService);

		const result = await service.enqueueDailyDatabaseBackups(
			period,
			scheduledFor
		);

		expect(result).toEqual({
			notificationDelivery: expect.objectContaining({ created: true }),
			campaigns: expect.objectContaining({ created: true }),
			reporting: expect.objectContaining({ created: true }),
			widgets: expect.objectContaining({ created: true }),
			billing: expect.objectContaining({ created: true }),
			identity: expect.objectContaining({ created: true }),
			platform: expect.objectContaining({ created: true })
		});
		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(scheduledJobs.enqueueUniqueInTransaction).toHaveBeenCalledTimes(
			7
		);
		expect(
			scheduledJobs.enqueueUniqueInTransaction
		).toHaveBeenNthCalledWith(
			1,
			transaction,
			expect.objectContaining({
				jobType: 'NOTIFICATION_DELIVERY_DATABASE_BACKUP',
				scheduleKey: period.key,
				input: expect.objectContaining({ trigger: 'SCHEDULED' })
			}),
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(
			scheduledJobs.enqueueUniqueInTransaction
		).toHaveBeenNthCalledWith(
			2,
			transaction,
			expect.objectContaining({
				jobType: 'CAMPAIGNS_DATABASE_BACKUP',
				scheduleKey: period.key,
				input: expect.objectContaining({
					trigger: 'SCHEDULED'
				})
			}),
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(
			scheduledJobs.enqueueUniqueInTransaction
		).toHaveBeenNthCalledWith(
			3,
			transaction,
			expect.objectContaining({
				jobType: 'REPORTING_DATABASE_BACKUP',
				scheduleKey: period.key,
				input: expect.objectContaining({
					trigger: 'SCHEDULED'
				})
			}),
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(
			scheduledJobs.enqueueUniqueInTransaction
		).toHaveBeenNthCalledWith(
			4,
			transaction,
			expect.objectContaining({
				jobType: 'WIDGETS_DATABASE_BACKUP',
				scheduleKey: period.key,
				input: expect.objectContaining({
					trigger: 'SCHEDULED'
				})
			}),
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(
			scheduledJobs.enqueueUniqueInTransaction
		).toHaveBeenNthCalledWith(
			5,
			transaction,
			expect.objectContaining({
				jobType: 'BILLING_DATABASE_BACKUP',
				scheduleKey: period.key,
				input: expect.objectContaining({
					trigger: 'SCHEDULED'
				})
			}),
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(
			scheduledJobs.enqueueUniqueInTransaction
		).toHaveBeenNthCalledWith(
			6,
			transaction,
			expect.objectContaining({
				jobType: 'IDENTITY_DATABASE_BACKUP',
				scheduleKey: period.key,
				input: expect.objectContaining({
					trigger: 'SCHEDULED'
				})
			}),
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(
			scheduledJobs.enqueueUniqueInTransaction
		).toHaveBeenNthCalledWith(
			7,
			transaction,
			expect.objectContaining({
				jobType: 'PLATFORM_DATABASE_BACKUP',
				scheduleKey: period.key,
				input: expect.objectContaining({
					trigger: 'SCHEDULED'
				})
			}),
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
	});

	it('does not enqueue any backup when the daily period is already complete', async () => {
		const prisma = {
			telegramBotSettings: {
				upsert: jest.fn().mockResolvedValue({
					databaseBackupEnabled: true,
					databaseBackupLastSentPeriodStart: period.start
				})
			},
			$transaction: jest.fn()
		} as unknown as PrismaService;
		const scheduledJobs = {
			enqueueUniqueInTransaction: jest.fn()
		} as unknown as ScheduledJobsService;
		const service = new ScheduledTasksService(
			prisma,
			scheduledJobs,
			{} as ConfigService
		);

		await expect(
			service.enqueueDailyDatabaseBackups(period, scheduledFor)
		).resolves.toBeNull();
		expect(prisma.$transaction).not.toHaveBeenCalled();
		expect(
			scheduledJobs.enqueueUniqueInTransaction
		).not.toHaveBeenCalled();
	});

	const createManualBackupJob = (
		adminId: string,
		scheduleKey: string,
		overrides: Partial<ScheduledJobRun> = {}
	): ScheduledJobRun => ({
		id: randomUUID(),
		jobType: 'REPORTING_DATABASE_BACKUP',
		scheduleKey,
		trigger: ScheduledJobRunTrigger.MANUAL,
		status: ScheduledJobRunStatus.QUEUED,
		scheduledFor,
		periodStart: null,
		periodEnd: null,
		input: {
			chatId: '-100123',
			messageThreadId: 43,
			trigger: 'MANUAL',
			periodStart: null,
			requestedByAdminId: adminId
		},
		checkpoint: {},
		result: null,
		attempts: 0,
		maxAttempts: 4,
		availableAt: scheduledFor,
		leaseOwner: null,
		leaseToken: null,
		leaseExpiresAt: null,
		startedAt: null,
		finishedAt: null,
		lastError: null,
		createdAt: scheduledFor,
		updatedAt: scheduledFor,
		...overrides
	});

	const createManualBackupService = (
		findUniqueResult: ScheduledJobRun | null,
		findFirstResult: ScheduledJobRun | null,
		enqueuedJob?: ScheduledJobRun
	) => {
		const settingsUpsert = jest.fn().mockResolvedValue({
			dailySummaryChatId: ' -100123 ',
			databaseBackupThreadId: 43
		});
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			telegramBotSettings: {
				upsert: settingsUpsert
			},
			scheduledJobIdempotencyKey: {
				findUnique: jest
					.fn()
					.mockResolvedValue(
						findUniqueResult ? { job: findUniqueResult } : null
					),
				create: jest.fn().mockResolvedValue({})
			},
			scheduledJobRun: {
				findFirst: jest.fn().mockResolvedValue(findFirstResult)
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction))
		} as unknown as PrismaService;
		const scheduledJobs = {
			enqueueUniqueInTransaction: jest.fn().mockResolvedValue({
				created: true,
				job: enqueuedJob
					? {
							...enqueuedJob,
							scheduledFor: enqueuedJob.scheduledFor.toISOString(),
							periodStart: null,
							periodEnd: null,
							availableAt: enqueuedJob.availableAt.toISOString(),
							leaseExpiresAt: null,
							startedAt: null,
							finishedAt: null,
							createdAt: enqueuedJob.createdAt.toISOString(),
							updatedAt: enqueuedJob.updatedAt.toISOString()
						}
					: null
			})
		} as unknown as ScheduledJobsService;
		const configService = {
			get: jest.fn().mockReturnValue('telegram-token')
		} as unknown as ConfigService;

		return {
			service: new ScheduledTasksService(
				prisma,
				scheduledJobs,
				configService
			),
			transaction,
			scheduledJobs,
			configService
		};
	};

	it('returns the same terminal manual backup for a repeated Idempotency-Key', async () => {
		const adminId = randomUUID();
		const idempotencyKey = randomUUID();
		const job = createManualBackupJob(
			adminId,
			`manual:${adminId}:${idempotencyKey}`,
			{
				status: ScheduledJobRunStatus.SUCCEEDED,
				finishedAt: scheduledFor
			}
		);
		const { service, transaction, scheduledJobs, configService } =
			createManualBackupService(job, null);
		(configService.get as jest.Mock).mockReturnValue(undefined);

		const result = await service.enqueueManualDatabaseBackup(
			'reporting',
			adminId,
			idempotencyKey.toUpperCase()
		);

		expect(result).toEqual({
			target: 'reporting',
			jobId: job.id,
			status: ScheduledJobRunStatus.SUCCEEDED,
			queuedAt: job.createdAt.toISOString(),
			created: false
		});
		expect(
			transaction.scheduledJobIdempotencyKey.findUnique
		).toHaveBeenCalledWith({
			where: {
				adminId_jobType_idempotencyKey: {
					adminId,
					jobType: 'REPORTING_DATABASE_BACKUP',
					idempotencyKey
				}
			},
			include: { job: true }
		});
		expect(transaction.scheduledJobRun.findFirst).not.toHaveBeenCalled();
		expect(
			scheduledJobs.enqueueUniqueInTransaction
		).not.toHaveBeenCalled();
		expect(
			transaction.scheduledJobIdempotencyKey.create
		).not.toHaveBeenCalled();
		expect(transaction.telegramBotSettings.upsert).not.toHaveBeenCalled();
		expect(configService.get).not.toHaveBeenCalled();
	});

	it('reuses the current admin active backup before creating another one', async () => {
		const adminId = randomUUID();
		const activeJob = createManualBackupJob(
			adminId,
			`manual:${adminId}:${randomUUID()}`
		);
		const { service, transaction, scheduledJobs } =
			createManualBackupService(null, activeJob);

		const result = await service.enqueueManualDatabaseBackup(
			'reporting',
			adminId,
			randomUUID()
		);

		expect(result.jobId).toBe(activeJob.id);
		expect(result.created).toBe(false);
		expect(transaction.scheduledJobRun.findFirst).toHaveBeenCalledWith({
			where: expect.objectContaining({
				trigger: ScheduledJobRunTrigger.MANUAL,
				input: {
					path: ['requestedByAdminId'],
					equals: adminId
				}
			}),
			orderBy: { createdAt: 'desc' }
		});
		expect(
			scheduledJobs.enqueueUniqueInTransaction
		).not.toHaveBeenCalled();
		expect(
			transaction.scheduledJobIdempotencyKey.create
		).toHaveBeenCalledWith({
			data: {
				adminId,
				jobType: 'REPORTING_DATABASE_BACKUP',
				idempotencyKey: expect.any(String),
				jobId: activeJob.id
			}
		});
		expect(transaction.telegramBotSettings.upsert).not.toHaveBeenCalled();
		expect(
			transaction.$executeRaw.mock.invocationCallOrder[0]
		).toBeLessThan(
			transaction.scheduledJobRun.findFirst.mock.invocationCallOrder[0]
		);
	});

	it('creates a new manual backup with an admin-scoped deterministic key', async () => {
		const adminId = randomUUID();
		const idempotencyKey = randomUUID();
		const job = createManualBackupJob(
			adminId,
			`manual:${adminId}:${idempotencyKey}`
		);
		const { service, transaction, scheduledJobs } =
			createManualBackupService(null, null, job);

		const result = await service.enqueueManualDatabaseBackup(
			'reporting',
			adminId,
			idempotencyKey
		);

		expect(result.jobId).toBe(job.id);
		expect(result.created).toBe(true);
		expect(scheduledJobs.enqueueUniqueInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				jobType: 'REPORTING_DATABASE_BACKUP',
				scheduleKey: `manual:reporting:${adminId}:${idempotencyKey}`,
				trigger: ScheduledJobRunTrigger.MANUAL,
				input: expect.objectContaining({
					requestedByAdminId: adminId
				})
			}),
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(
			transaction.scheduledJobIdempotencyKey.create
		).toHaveBeenCalledWith({
			data: {
				adminId,
				jobType: 'REPORTING_DATABASE_BACKUP',
				idempotencyKey,
				jobId: job.id
			}
		});
	});

	it('creates Notification Delivery manual jobs under an independent job type', async () => {
		const adminId = randomUUID();
		const idempotencyKey = randomUUID();
		const job = createManualBackupJob(
			adminId,
			`manual:notification-delivery:${adminId}:${idempotencyKey}`,
			{
				jobType: 'NOTIFICATION_DELIVERY_DATABASE_BACKUP'
			}
		);
		const { service, transaction, scheduledJobs } =
			createManualBackupService(null, null, job);

		const result = await service.enqueueManualDatabaseBackup(
			'notification-delivery',
			adminId,
			idempotencyKey
		);

		expect(result).toEqual(
			expect.objectContaining({
				target: 'notification-delivery',
				jobId: job.id,
				created: true
			})
		);
		expect(scheduledJobs.enqueueUniqueInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				jobType: 'NOTIFICATION_DELIVERY_DATABASE_BACKUP',
				scheduleKey: `manual:notification-delivery:${adminId}:${idempotencyKey}`
			}),
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
		expect(
			transaction.scheduledJobIdempotencyKey.create
		).toHaveBeenCalledWith({
			data: {
				adminId,
				jobType: 'NOTIFICATION_DELIVERY_DATABASE_BACKUP',
				idempotencyKey,
				jobId: job.id
			}
		});
	});

	it('creates Widgets manual jobs under an independent job type', async () => {
		const adminId = randomUUID();
		const idempotencyKey = randomUUID();
		const job = createManualBackupJob(
			adminId,
			`manual:widgets:${adminId}:${idempotencyKey}`,
			{ jobType: 'WIDGETS_DATABASE_BACKUP' }
		);
		const { service, transaction, scheduledJobs } =
			createManualBackupService(null, null, job);

		const result = await service.enqueueManualDatabaseBackup(
			'widgets',
			adminId,
			idempotencyKey
		);

		expect(result).toEqual(
			expect.objectContaining({
				target: 'widgets',
				jobId: job.id,
				created: true
			})
		);
		expect(scheduledJobs.enqueueUniqueInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				jobType: 'WIDGETS_DATABASE_BACKUP',
				scheduleKey: `manual:widgets:${adminId}:${idempotencyKey}`
			}),
			expect.objectContaining({
				eventType: 'database.backup.requested.v1'
			})
		);
	});

	it('maps two different active request keys to one job and one Outbox creation', async () => {
		const adminId = randomUUID();
		const firstKey = randomUUID();
		const secondKey = randomUUID();
		const job = createManualBackupJob(
			adminId,
			`manual:${adminId}:${firstKey}`
		);
		const idempotencyMappings = new Map<
			string,
			{ job: ScheduledJobRun }
		>();
		let activeJob: ScheduledJobRun | null = null;
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(1),
			telegramBotSettings: {
				upsert: jest.fn().mockResolvedValue({
					dailySummaryChatId: '-100123',
					databaseBackupThreadId: 43
				})
			},
			scheduledJobIdempotencyKey: {
				findUnique: jest.fn(
					({
						where
					}: {
						where: {
							adminId_jobType_idempotencyKey: {
								idempotencyKey: string;
							};
						};
					}) =>
						Promise.resolve(
							idempotencyMappings.get(
								where.adminId_jobType_idempotencyKey.idempotencyKey
							) ?? null
						)
				),
				create: jest.fn(
					({
						data
					}: {
						data: {
							idempotencyKey: string;
						};
					}) => {
						idempotencyMappings.set(data.idempotencyKey, {
							job
						});
						return Promise.resolve({});
					}
				)
			},
			scheduledJobRun: {
				findFirst: jest.fn(() => Promise.resolve(activeJob))
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction))
		} as unknown as PrismaService;
		const scheduledJobs = {
			enqueueUniqueInTransaction: jest.fn().mockImplementation(() => {
				activeJob = job;
				return Promise.resolve({
					created: true,
					job: {
						...job,
						scheduledFor: job.scheduledFor.toISOString(),
						periodStart: null,
						periodEnd: null,
						availableAt: job.availableAt.toISOString(),
						leaseExpiresAt: null,
						startedAt: null,
						finishedAt: null,
						createdAt: job.createdAt.toISOString(),
						updatedAt: job.updatedAt.toISOString()
					}
				});
			})
		} as unknown as ScheduledJobsService;
		const service = new ScheduledTasksService(prisma, scheduledJobs, {
			get: jest.fn().mockReturnValue('telegram-token')
		} as unknown as ConfigService);

		const first = await service.enqueueManualDatabaseBackup(
			'reporting',
			adminId,
			firstKey
		);
		const second = await service.enqueueManualDatabaseBackup(
			'reporting',
			adminId,
			secondKey
		);

		expect(first.jobId).toBe(job.id);
		expect(second).toEqual(
			expect.objectContaining({
				jobId: job.id,
				created: false
			})
		);
		expect(scheduledJobs.enqueueUniqueInTransaction).toHaveBeenCalledTimes(
			1
		);
		expect(
			transaction.scheduledJobIdempotencyKey.create
		).toHaveBeenCalledTimes(2);
		expect(transaction.telegramBotSettings.upsert).toHaveBeenCalledTimes(
			1
		);
		expect([...idempotencyMappings.keys()].sort()).toEqual(
			[firstKey, secondKey].sort()
		);
	});

	it('creates a new job for a new key after the previous job is terminal', async () => {
		const adminId = randomUUID();
		const previousJob = createManualBackupJob(
			adminId,
			`manual:${adminId}:${randomUUID()}`,
			{
				status: ScheduledJobRunStatus.SUCCEEDED,
				finishedAt: scheduledFor
			}
		);
		const newKey = randomUUID();
		const nextJob = createManualBackupJob(
			adminId,
			`manual:${adminId}:${newKey}`
		);
		const { service, scheduledJobs } = createManualBackupService(
			null,
			null,
			nextJob
		);

		const result = await service.enqueueManualDatabaseBackup(
			'reporting',
			adminId,
			newKey
		);

		expect(result.jobId).toBe(nextJob.id);
		expect(result.jobId).not.toBe(previousJob.id);
		expect(result.created).toBe(true);
		expect(scheduledJobs.enqueueUniqueInTransaction).toHaveBeenCalledTimes(
			1
		);
	});

	it('returns only the latest active manual backup owned by the current admin', async () => {
		const adminId = randomUUID();
		const job = createManualBackupJob(
			adminId,
			`manual:${adminId}:${randomUUID()}`
		);
		const prisma = {
			scheduledJobRun: {
				findFirst: jest.fn().mockResolvedValue(job)
			}
		} as unknown as PrismaService;
		const service = new ScheduledTasksService(
			prisma,
			{} as ScheduledJobsService,
			{} as ConfigService
		);

		const result = await service.getLatestActiveManualDatabaseBackup(
			'reporting',
			adminId
		);

		expect(result?.jobId).toBe(job.id);
		expect(prisma.scheduledJobRun.findFirst).toHaveBeenCalledWith({
			where: expect.objectContaining({
				jobType: 'REPORTING_DATABASE_BACKUP',
				trigger: ScheduledJobRunTrigger.MANUAL,
				status: {
					in: [
						ScheduledJobRunStatus.QUEUED,
						ScheduledJobRunStatus.PROCESSING
					]
				},
				input: {
					path: ['requestedByAdminId'],
					equals: adminId
				}
			}),
			orderBy: { createdAt: 'desc' }
		});
	});

	it('redacts private backup result and infrastructure errors from polling', async () => {
		const adminId = randomUUID();
		const job = createManualBackupJob(
			adminId,
			`manual:${adminId}:${randomUUID()}`,
			{
				status: ScheduledJobRunStatus.FAILED,
				lastError: 'pg_dump failed at /private/backup.dump',
				result: {
					fileSize: 4096,
					fileName: '/private/backup.dump',
					telegramReceipt: { chatId: '-100-secret' }
				}
			}
		);
		const scheduledJobs = {
			getJob: jest.fn().mockResolvedValue({
				...job,
				scheduledFor: job.scheduledFor.toISOString(),
				periodStart: null,
				periodEnd: null,
				availableAt: job.availableAt.toISOString(),
				leaseExpiresAt: null,
				startedAt: null,
				finishedAt: null,
				createdAt: job.createdAt.toISOString(),
				updatedAt: job.updatedAt.toISOString()
			})
		} as unknown as ScheduledJobsService;
		const service = new ScheduledTasksService(
			{} as PrismaService,
			scheduledJobs,
			{} as ConfigService
		);

		const result = await service.getDatabaseBackupJob(
			'reporting',
			job.id,
			adminId
		);

		expect(result).toEqual(
			expect.objectContaining({
				fileSize: 4096,
				hasError: true
			})
		);
		expect(Object.keys(result || {}).sort()).toEqual(
			[
				'completedAt',
				'fileSize',
				'hasError',
				'jobId',
				'queuedAt',
				'startedAt',
				'status',
				'target'
			].sort()
		);
		expect(JSON.stringify(result)).not.toContain('/private/backup.dump');
		expect(JSON.stringify(result)).not.toContain('-100-secret');
		expect(JSON.stringify(result)).not.toContain('pg_dump failed');
	});

	it('does not expose a manual backup owned by another admin', async () => {
		const currentAdminId = randomUUID();
		const otherAdminId = randomUUID();
		const job = createManualBackupJob(
			otherAdminId,
			`manual:${otherAdminId}:${randomUUID()}`
		);
		const scheduledJobs = {
			getJob: jest.fn().mockResolvedValue({
				...job,
				scheduledFor: job.scheduledFor.toISOString(),
				periodStart: null,
				periodEnd: null,
				availableAt: job.availableAt.toISOString(),
				leaseExpiresAt: null,
				startedAt: null,
				finishedAt: null,
				createdAt: job.createdAt.toISOString(),
				updatedAt: job.updatedAt.toISOString()
			})
		} as unknown as ScheduledJobsService;
		const service = new ScheduledTasksService(
			{} as PrismaService,
			scheduledJobs,
			{} as ConfigService
		);

		await expect(
			service.getDatabaseBackupJob('reporting', job.id, currentAdminId)
		).resolves.toBeNull();
	});

	it('returns a redacted overview for every active database backup target', async () => {
		const now = new Date();
		const jobTypes = [
			'NOTIFICATION_DELIVERY_DATABASE_BACKUP',
			'CAMPAIGNS_DATABASE_BACKUP',
			'REPORTING_DATABASE_BACKUP',
			'WIDGETS_DATABASE_BACKUP',
			'BILLING_DATABASE_BACKUP',
			'IDENTITY_DATABASE_BACKUP',
			'PLATFORM_DATABASE_BACKUP'
		];
		const jobs = new Map(
			jobTypes.map((jobType, index) => [
				jobType,
				createManualBackupJob(randomUUID(), `overview:${jobType}`, {
					jobType,
					trigger: ScheduledJobRunTrigger.SCHEDULED,
					status: ScheduledJobRunStatus.SUCCEEDED,
					finishedAt: new Date(now.getTime() - index * 60_000),
					result: {
						fileSize: 1024 + index,
						fileName: '/private/backup.dump',
						telegramReceipt: { chatId: '-100-secret' }
					}
				})
			])
		);
		const prisma = {
			telegramBotSettings: {
				upsert: jest.fn().mockResolvedValue({
					databaseBackupEnabled: true
				})
			},
			scheduledJobRun: {
				findFirst: jest.fn(({ where }) => {
					const job = jobs.get(where.jobType) ?? null;
					if (where.trigger && job?.trigger !== where.trigger) {
						return Promise.resolve(null);
					}
					if (where.status && job?.status !== where.status) {
						return Promise.resolve(null);
					}
					return Promise.resolve(job);
				})
			}
		} as unknown as PrismaService;
		const service = new ScheduledTasksService(
			prisma,
			{} as ScheduledJobsService,
			{} as ConfigService
		);

		const result = await service.getDatabaseBackupOverview();

		expect(result.items).toHaveLength(7);
		expect(result.items.map(item => item.target)).toEqual([
			'notification-delivery',
			'campaigns',
			'reporting',
			'widgets',
			'billing',
			'identity',
			'platform'
		]);
		expect(result.items[0]).toEqual(
			expect.objectContaining({
				freshness: 'FRESH',
				latestSuccessful: expect.objectContaining({
					target: 'notification-delivery',
					fileSize: 1024,
					hasError: false
				})
			})
		);
		expect(JSON.stringify(result)).not.toContain('/private/backup.dump');
		expect(JSON.stringify(result)).not.toContain('-100-secret');
		expect(prisma.scheduledJobRun.findFirst).toHaveBeenCalledTimes(28);
	});

	it('marks the exact freshness boundary stale and distinguishes missing and disabled backups', async () => {
		jest.useFakeTimers();
		const now = new Date('2026-08-15T12:00:00.000Z');
		jest.setSystemTime(now);
		try {
			const reportingJob = createManualBackupJob(
				randomUUID(),
				'freshness:reporting',
				{
					trigger: ScheduledJobRunTrigger.SCHEDULED,
					status: ScheduledJobRunStatus.SUCCEEDED,
					finishedAt: new Date(now.getTime() - 36 * 60 * 60 * 1000)
				}
			);
			const settingsUpsert = jest
				.fn()
				.mockResolvedValueOnce({ databaseBackupEnabled: true })
				.mockResolvedValueOnce({ databaseBackupEnabled: false });
			const findFirst = jest.fn(({ where }) => {
				if (where.jobType !== 'REPORTING_DATABASE_BACKUP') {
					return Promise.resolve(null);
				}
				if (
					where.trigger &&
					where.trigger !== ScheduledJobRunTrigger.SCHEDULED
				) {
					return Promise.resolve(null);
				}
				return Promise.resolve(reportingJob);
			});
			const prisma = {
				telegramBotSettings: { upsert: settingsUpsert },
				scheduledJobRun: { findFirst }
			} as unknown as PrismaService;
			const service = new ScheduledTasksService(
				prisma,
				{} as ScheduledJobsService,
				{} as ConfigService
			);

			const enabled = await service.getDatabaseBackupOverview();
			const disabled = await service.getDatabaseBackupOverview();

			expect(
				enabled.items.find(item => item.target === 'reporting')?.freshness
			).toBe('STALE');
			expect(
				enabled.items.find(item => item.target === 'notification-delivery')
					?.freshness
			).toBe('MISSING');
			expect(
				disabled.items.every(item => item.freshness === 'DISABLED')
			).toBe(true);
		} finally {
			jest.useRealTimers();
		}
	});

	it('returns a redacted and stably paginated database backup history', async () => {
		const job = createManualBackupJob(
			randomUUID(),
			'manual:reporting:history',
			{
				jobType: 'REPORTING_DATABASE_BACKUP',
				status: ScheduledJobRunStatus.FAILED,
				attempts: 3,
				lastError: 'pg_dump failed at /private/path',
				result: { fileSize: 2048, fileName: '/private/path' }
			}
		);
		const prisma = {
			scheduledJobRun: {
				findMany: jest.fn().mockResolvedValue([job]),
				count: jest.fn().mockResolvedValue(21)
			}
		} as unknown as PrismaService;
		const service = new ScheduledTasksService(
			prisma,
			{} as ScheduledJobsService,
			{} as ConfigService
		);

		const result = await service.getDatabaseBackupJobs({
			target: 'reporting',
			trigger: ScheduledJobRunTrigger.MANUAL,
			status: ScheduledJobRunStatus.FAILED,
			page: 2,
			limit: 10
		});

		expect(prisma.scheduledJobRun.findMany).toHaveBeenCalledWith({
			where: {
				jobType: 'REPORTING_DATABASE_BACKUP',
				trigger: ScheduledJobRunTrigger.MANUAL,
				status: ScheduledJobRunStatus.FAILED
			},
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			skip: 10,
			take: 10
		});
		expect(result).toEqual(
			expect.objectContaining({
				page: 2,
				limit: 10,
				total: 21,
				totalPages: 3
			})
		);
		expect(result.items[0]).toEqual(
			expect.objectContaining({
				target: 'reporting',
				status: ScheduledJobRunStatus.FAILED,
				attempts: 3,
				fileSize: 2048,
				hasError: true
			})
		);
		expect(JSON.stringify(result)).not.toContain('/private/path');
		expect(JSON.stringify(result)).not.toContain('pg_dump failed');
	});
});
