import { DatabaseBackupInput } from '@/maintenance/database-backup.service';
import {
	DAILY_SUMMARY_EVENT_TYPE,
	DATABASE_BACKUP_EVENT_TYPE,
	MESSAGING_ROUTING_KEYS
} from '@/messaging/messaging.constants';
import { PrismaService } from '@/prisma.service';
import { ScheduledJobsService } from '@/scheduled-jobs/scheduled-jobs.service';
import {
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
		adminId: string,
		idempotencyKey: string
	) {
		const normalizedIdempotencyKey = idempotencyKey.trim().toLowerCase();
		const scheduleKey = `manual:${adminId}:${normalizedIdempotencyKey}`;
		const result = await this.prisma.$transaction(
			async transaction => {
				await transaction.$executeRaw(
					Prisma.sql`
						SELECT pg_advisory_xact_lock(
							hashtextextended(
								CAST(${`database-backup:${adminId}`} AS text),
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
								jobType: SCHEDULED_JOB_TYPES.DATABASE_BACKUP,
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
					where: this.getActiveManualBackupWhere(adminId),
					orderBy: { createdAt: 'desc' }
				});
				if (activeJob) {
					await transaction.scheduledJobIdempotencyKey.create({
						data: {
							adminId,
							jobType: SCHEDULED_JOB_TYPES.DATABASE_BACKUP,
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
							jobType: SCHEDULED_JOB_TYPES.DATABASE_BACKUP,
							scheduleKey,
							trigger: ScheduledJobRunTrigger.MANUAL,
							scheduledFor: queuedAt,
							input: {
								...input,
								requestedByAdminId: adminId
							} as Prisma.InputJsonObject
						},
						this.getEventForType(SCHEDULED_JOB_TYPES.DATABASE_BACKUP)
					);
				await transaction.scheduledJobIdempotencyKey.create({
					data: {
						adminId,
						jobType: SCHEDULED_JOB_TYPES.DATABASE_BACKUP,
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

	async enqueueDailyDatabaseBackup(
		period: MoscowDayPeriod,
		scheduledFor: Date
	): Promise<{ created: boolean; job: ScheduledJobRunView } | null> {
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

		return this.scheduledJobs.enqueueUnique(
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
		);
	}

	getEventForType(jobType: string): ScheduledJobOutboxEvent {
		if (jobType === SCHEDULED_JOB_TYPES.DAILY_TELEGRAM_SUMMARY) {
			return {
				eventType: DAILY_SUMMARY_EVENT_TYPE,
				routingKey: MESSAGING_ROUTING_KEYS['daily-summary-telegram'],
				payload: {
					schemaVersion: 1,
					eventType: DAILY_SUMMARY_EVENT_TYPE
				}
			};
		}
		if (jobType === SCHEDULED_JOB_TYPES.DATABASE_BACKUP) {
			return {
				eventType: DATABASE_BACKUP_EVENT_TYPE,
				routingKey: MESSAGING_ROUTING_KEYS['database-backup'],
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

	async getDatabaseBackupJob(id: string, adminId: string) {
		const job = await this.getJob(id);
		if (
			!job ||
			job.jobType !== SCHEDULED_JOB_TYPES.DATABASE_BACKUP ||
			job.trigger !== ScheduledJobRunTrigger.MANUAL ||
			this.getRequestedByAdminId(job.input) !== adminId
		) {
			return null;
		}
		return this.toDatabaseBackupJob(job);
	}

	async getLatestActiveManualDatabaseBackup(adminId: string) {
		const job = await this.prisma.scheduledJobRun.findFirst({
			where: this.getActiveManualBackupWhere(adminId),
			orderBy: { createdAt: 'desc' }
		});
		return job
			? this.toDatabaseBackupJob(serializeScheduledJobRun(job))
			: null;
	}

	private toDatabaseBackupJob(job: ScheduledJobRunView) {
		return {
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
		adminId: string
	): Prisma.ScheduledJobRunWhereInput {
		return {
			jobType: SCHEDULED_JOB_TYPES.DATABASE_BACKUP,
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
