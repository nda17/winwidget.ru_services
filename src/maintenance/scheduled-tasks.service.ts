import {
	CAMPAIGNS_DATABASE_BACKUP_DELAY_MINUTES,
	DatabaseBackupInput,
	DatabaseBackupTarget,
	NOTIFICATION_DELIVERY_DATABASE_BACKUP_DELAY_MINUTES
} from '@/maintenance/database-backup.types';
import {
	DAILY_SUMMARY_EVENT_TYPE,
	DATABASE_BACKUP_EVENT_TYPE,
	getDeadLetterRoutingKey,
	MESSAGING_ROUTING_KEYS
} from '@/messaging/messaging.constants';
import { PrismaService } from '@/prisma.service';
import { ScheduledJobsService } from '@/scheduled-jobs/scheduled-jobs.service';
import {
	isDatabaseBackupJobType,
	SCHEDULED_JOB_TYPES,
	ScheduledJobOutboxEvent,
	ScheduledJobRunView,
	serializeScheduledJobRun
} from '@/scheduled-jobs/scheduled-jobs.types';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	Prisma,
	ScheduledJobRunStatus,
	ScheduledJobRunTrigger
} from '@prisma/client';

export interface MoscowDayPeriod {
	start: Date;
	end: Date;
	key: string;
}

@Injectable()
export class ScheduledTasksService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly scheduledJobs: ScheduledJobsService,
		private readonly configService: ConfigService
	) {}

	async enqueueManualDatabaseBackup(
		target: DatabaseBackupTarget,
		adminId: string,
		idempotencyKey: string
	) {
		const jobType = this.getDatabaseBackupJobType(target);
		const normalizedIdempotencyKey = idempotencyKey.trim().toLowerCase();
		const scheduleKey = `manual:${target}:${adminId}:${normalizedIdempotencyKey}`;
		const result = await this.prisma.$transaction(
			async transaction => {
				await transaction.$executeRaw(
					Prisma.sql`
						SELECT pg_advisory_xact_lock(
							hashtextextended(
								CAST(${`database-backup:${target}:${adminId}`} AS text),
								0::bigint
							)
						)
					`
				);

				const repeatedRequest =
					await transaction.scheduledJobIdempotencyKey.findUnique({
						where: {
							adminId_jobType_idempotencyKey: {
								adminId,
								jobType,
								idempotencyKey: normalizedIdempotencyKey
							}
						},
						include: { job: true }
					});
				if (repeatedRequest) {
					return {
						created: false,
						job: serializeScheduledJobRun(repeatedRequest.job)
					};
				}

				const activeJob = await transaction.scheduledJobRun.findFirst({
					where: this.getActiveManualBackupWhere(target, adminId),
					orderBy: { createdAt: 'desc' }
				});
				if (activeJob) {
					await transaction.scheduledJobIdempotencyKey.create({
						data: {
							adminId,
							jobType,
							idempotencyKey: normalizedIdempotencyKey,
							jobId: activeJob.id
						}
					});
					return {
						created: false,
						job: serializeScheduledJobRun(activeJob)
					};
				}

				const input = await this.getDatabaseBackupInput(
					'MANUAL',
					null,
					transaction
				);
				const queuedAt = new Date();
				const enqueued =
					await this.scheduledJobs.enqueueUniqueInTransaction(
						transaction,
						{
							jobType,
							scheduleKey,
							trigger: ScheduledJobRunTrigger.MANUAL,
							scheduledFor: queuedAt,
							input: {
								...input,
								requestedByAdminId: adminId
							} as Prisma.InputJsonObject
						},
						this.getEventForType(jobType)
					);
				await transaction.scheduledJobIdempotencyKey.create({
					data: {
						adminId,
						jobType,
						idempotencyKey: normalizedIdempotencyKey,
						jobId: enqueued.job.id
					}
				});
				return enqueued;
			},
			{
				timeout: 10_000
			}
		);

		return {
			target,
			jobId: result.job.id,
			status: result.job.status,
			queuedAt: result.job.createdAt,
			created: result.created
		};
	}

	async enqueueDailySummary(
		period: MoscowDayPeriod,
		scheduledFor: Date
	): Promise<{ created: boolean; job: ScheduledJobRunView } | null> {
		const settings = await this.getSettings();
		if (
			!settings.dailySummaryEnabled ||
			!settings.dailySummaryChatId.trim() ||
			!settings.reportsThreadId
		) {
			return null;
		}
		if (
			settings.dailySummaryLastSentPeriodStart?.getTime() ===
			period.start.getTime()
		) {
			return null;
		}

		return this.scheduledJobs.enqueueUnique(
			{
				jobType: SCHEDULED_JOB_TYPES.DAILY_TELEGRAM_SUMMARY,
				scheduleKey: period.key,
				trigger: ScheduledJobRunTrigger.SCHEDULED,
				scheduledFor,
				periodStart: period.start,
				periodEnd: period.end,
				input: {
					chatId: settings.dailySummaryChatId.trim(),
					messageThreadId: settings.reportsThreadId
				}
			},
			this.getEventForType(SCHEDULED_JOB_TYPES.DAILY_TELEGRAM_SUMMARY)
		);
	}

	async enqueueDailyDatabaseBackups(
		period: MoscowDayPeriod,
		scheduledFor: Date
	): Promise<{
		core: { created: boolean; job: ScheduledJobRunView };
		notificationDelivery: {
			created: boolean;
			job: ScheduledJobRunView;
		};
		campaigns: {
			created: boolean;
			job: ScheduledJobRunView;
		};
	} | null> {
		const settings = await this.getSettings();
		if (!settings.databaseBackupEnabled) return null;
		if (
			settings.databaseBackupLastSentPeriodStart?.getTime() ===
			period.start.getTime()
		) {
			return null;
		}
		const input = await this.getDatabaseBackupInput(
			'SCHEDULED',
			period.start
		);
		const notificationDeliveryScheduledFor = new Date(
			scheduledFor.getTime() +
				NOTIFICATION_DELIVERY_DATABASE_BACKUP_DELAY_MINUTES * 60_000
		);
		const campaignsScheduledFor = new Date(
			scheduledFor.getTime() +
				CAMPAIGNS_DATABASE_BACKUP_DELAY_MINUTES * 60_000
		);

		return this.prisma.$transaction(
			async transaction => ({
				core: await this.scheduledJobs.enqueueUniqueInTransaction(
					transaction,
					{
						jobType: SCHEDULED_JOB_TYPES.DATABASE_BACKUP,
						scheduleKey: period.key,
						trigger: ScheduledJobRunTrigger.SCHEDULED,
						scheduledFor,
						periodStart: period.start,
						periodEnd: period.end,
						input: input as unknown as Prisma.InputJsonObject
					},
					this.getEventForType(SCHEDULED_JOB_TYPES.DATABASE_BACKUP)
				),
				notificationDelivery:
					await this.scheduledJobs.enqueueUniqueInTransaction(
						transaction,
						{
							jobType:
								SCHEDULED_JOB_TYPES.NOTIFICATION_DELIVERY_DATABASE_BACKUP,
							scheduleKey: period.key,
							trigger: ScheduledJobRunTrigger.SCHEDULED,
							scheduledFor: notificationDeliveryScheduledFor,
							periodStart: period.start,
							periodEnd: period.end,
							input: input as unknown as Prisma.InputJsonObject,
							availableAt: notificationDeliveryScheduledFor
						},
						this.getEventForType(
							SCHEDULED_JOB_TYPES.NOTIFICATION_DELIVERY_DATABASE_BACKUP
						)
					),
				campaigns: await this.scheduledJobs.enqueueUniqueInTransaction(
					transaction,
					{
						jobType: SCHEDULED_JOB_TYPES.CAMPAIGNS_DATABASE_BACKUP,
						scheduleKey: period.key,
						trigger: ScheduledJobRunTrigger.SCHEDULED,
						scheduledFor: campaignsScheduledFor,
						periodStart: period.start,
						periodEnd: period.end,
						input: input as unknown as Prisma.InputJsonObject,
						availableAt: campaignsScheduledFor
					},
					this.getEventForType(
						SCHEDULED_JOB_TYPES.CAMPAIGNS_DATABASE_BACKUP
					)
				)
			}),
			{ timeout: 10_000 }
		);
	}

	getEventForType(jobType: string): ScheduledJobOutboxEvent {
		if (jobType === SCHEDULED_JOB_TYPES.DAILY_TELEGRAM_SUMMARY) {
			return {
				eventType: DAILY_SUMMARY_EVENT_TYPE,
				routingKey: MESSAGING_ROUTING_KEYS['daily-summary-telegram'],
				deadLetterRoutingKey: getDeadLetterRoutingKey(
					'daily-summary-telegram'
				),
				payload: {
					schemaVersion: 1,
					eventType: DAILY_SUMMARY_EVENT_TYPE
				}
			};
		}
		if (isDatabaseBackupJobType(jobType)) {
			return {
				eventType: DATABASE_BACKUP_EVENT_TYPE,
				routingKey: MESSAGING_ROUTING_KEYS['database-backup'],
				deadLetterRoutingKey: getDeadLetterRoutingKey('database-backup'),
				payload: {
					schemaVersion: 1,
					eventType: DATABASE_BACKUP_EVENT_TYPE
				}
			};
		}
		throw new Error(`Unsupported scheduled job type: ${jobType}`);
	}

	async getJob(id: string): Promise<ScheduledJobRunView | null> {
		return this.scheduledJobs.getJob(id);
	}

	async getDatabaseBackupJob(
		target: DatabaseBackupTarget,
		id: string,
		adminId: string
	) {
		const jobType = this.getDatabaseBackupJobType(target);
		const job = await this.getJob(id);
		if (
			!job ||
			job.jobType !== jobType ||
			job.trigger !== ScheduledJobRunTrigger.MANUAL ||
			this.getRequestedByAdminId(job.input) !== adminId
		) {
			return null;
		}
		return this.toDatabaseBackupJob(target, job);
	}

	async getLatestActiveManualDatabaseBackup(
		target: DatabaseBackupTarget,
		adminId: string
	) {
		const job = await this.prisma.scheduledJobRun.findFirst({
			where: this.getActiveManualBackupWhere(target, adminId),
			orderBy: { createdAt: 'desc' }
		});
		return job
			? this.toDatabaseBackupJob(target, serializeScheduledJobRun(job))
			: null;
	}

	private toDatabaseBackupJob(
		target: DatabaseBackupTarget,
		job: ScheduledJobRunView
	) {
		return {
			target,
			jobId: job.id,
			status: job.status,
			queuedAt: job.createdAt,
			startedAt: job.startedAt,
			completedAt: job.finishedAt,
			lastError: job.lastError,
			result: job.result
		};
	}

	private getActiveManualBackupWhere(
		target: DatabaseBackupTarget,
		adminId: string
	): Prisma.ScheduledJobRunWhereInput {
		return {
			jobType: this.getDatabaseBackupJobType(target),
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
		};
	}

	private getDatabaseBackupJobType(target: DatabaseBackupTarget) {
		switch (target) {
			case 'core':
				return SCHEDULED_JOB_TYPES.DATABASE_BACKUP;
			case 'notification-delivery':
				return SCHEDULED_JOB_TYPES.NOTIFICATION_DELIVERY_DATABASE_BACKUP;
			case 'campaigns':
				return SCHEDULED_JOB_TYPES.CAMPAIGNS_DATABASE_BACKUP;
		}
	}

	private getRequestedByAdminId(input: Prisma.JsonValue) {
		if (!input || typeof input !== 'object' || Array.isArray(input)) {
			return null;
		}
		const requestedByAdminId = input.requestedByAdminId;
		return typeof requestedByAdminId === 'string'
			? requestedByAdminId
			: null;
	}

	private async getDatabaseBackupInput(
		trigger: DatabaseBackupInput['trigger'],
		periodStart: Date | null,
		transaction?: Prisma.TransactionClient
	): Promise<DatabaseBackupInput> {
		const settings = await this.getSettings(transaction);
		const chatId = settings.dailySummaryChatId.trim();
		const messageThreadId = settings.databaseBackupThreadId;
		if (!chatId) {
			throw new BadRequestException(
				'Не настроен ID Telegram-группы для отправки backup'
			);
		}
		if (!messageThreadId) {
			throw new BadRequestException('Не настроен ID топика Backups');
		}
		if (
			!this.configService.get<string>('TELEGRAM_INFO_BOT_TOKEN')?.trim()
		) {
			throw new BadRequestException('Не настроен TELEGRAM_INFO_BOT_TOKEN');
		}

		return {
			chatId,
			messageThreadId,
			trigger,
			periodStart: periodStart?.toISOString() || null
		};
	}

	private getSettings(transaction?: Prisma.TransactionClient) {
		const database = transaction ?? this.prisma;
		return database.telegramBotSettings.upsert({
			where: { id: 'singleton' },
			update: {},
			create: { id: 'singleton' }
		});
	}
}
