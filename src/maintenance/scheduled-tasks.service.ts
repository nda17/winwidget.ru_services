import {
	BILLING_DATABASE_BACKUP_DELAY_MINUTES,
	CAMPAIGNS_DATABASE_BACKUP_DELAY_MINUTES,
	DatabaseBackupAdminJobSummary,
	DATABASE_BACKUP_FRESHNESS_HOURS,
	DATABASE_BACKUP_TARGETS,
	DatabaseBackupInput,
	DatabaseBackupJobsPage,
	DatabaseBackupJobsQuery,
	DatabaseBackupOverview,
	DatabaseBackupOverviewItem,
	DatabaseBackupTarget,
	IDENTITY_DATABASE_BACKUP_DELAY_MINUTES,
	NOTIFICATION_DELIVERY_DATABASE_BACKUP_DELAY_MINUTES,
	PLATFORM_DATABASE_BACKUP_DELAY_MINUTES,
	REPORTING_DATABASE_BACKUP_DELAY_MINUTES,
	SUPPORT_DATABASE_BACKUP_DELAY_MINUTES,
	WIDGETS_DATABASE_BACKUP_DELAY_MINUTES
} from '@/maintenance/database-backup.types';
import {
	DATABASE_BACKUP_EVENT_TYPE,
	getDeadLetterRoutingKey,
	MESSAGING_ROUTING_KEYS
} from '@/messaging/messaging.constants';
import { PrismaService } from '@/prisma.service';
import { ScheduledJobsService } from '@/scheduled-jobs/scheduled-jobs.service';
import {
	DATABASE_BACKUP_JOB_TYPES,
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

	async enqueueDailyDatabaseBackups(
		period: MoscowDayPeriod,
		scheduledFor: Date
	): Promise<{
		notificationDelivery: {
			created: boolean;
			job: ScheduledJobRunView;
		};
		campaigns: {
			created: boolean;
			job: ScheduledJobRunView;
		};
		reporting: {
			created: boolean;
			job: ScheduledJobRunView;
		};
		widgets: {
			created: boolean;
			job: ScheduledJobRunView;
		};
		billing: {
			created: boolean;
			job: ScheduledJobRunView;
		};
		identity: {
			created: boolean;
			job: ScheduledJobRunView;
		};
		platform: {
			created: boolean;
			job: ScheduledJobRunView;
		};
		support: {
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
		const reportingScheduledFor = new Date(
			scheduledFor.getTime() +
				REPORTING_DATABASE_BACKUP_DELAY_MINUTES * 60_000
		);
		const widgetsScheduledFor = new Date(
			scheduledFor.getTime() +
				WIDGETS_DATABASE_BACKUP_DELAY_MINUTES * 60_000
		);
		const billingScheduledFor = new Date(
			scheduledFor.getTime() +
				BILLING_DATABASE_BACKUP_DELAY_MINUTES * 60_000
		);
		const identityScheduledFor = new Date(
			scheduledFor.getTime() +
				IDENTITY_DATABASE_BACKUP_DELAY_MINUTES * 60_000
		);
		const platformScheduledFor = new Date(
			scheduledFor.getTime() +
				PLATFORM_DATABASE_BACKUP_DELAY_MINUTES * 60_000
		);
		const supportScheduledFor = new Date(
			scheduledFor.getTime() +
				SUPPORT_DATABASE_BACKUP_DELAY_MINUTES * 60_000
		);

		return this.prisma.$transaction(
			async transaction => ({
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
				),
				reporting: await this.scheduledJobs.enqueueUniqueInTransaction(
					transaction,
					{
						jobType: SCHEDULED_JOB_TYPES.REPORTING_DATABASE_BACKUP,
						scheduleKey: period.key,
						trigger: ScheduledJobRunTrigger.SCHEDULED,
						scheduledFor: reportingScheduledFor,
						periodStart: period.start,
						periodEnd: period.end,
						input: input as unknown as Prisma.InputJsonObject,
						availableAt: reportingScheduledFor
					},
					this.getEventForType(
						SCHEDULED_JOB_TYPES.REPORTING_DATABASE_BACKUP
					)
				),
				widgets: await this.scheduledJobs.enqueueUniqueInTransaction(
					transaction,
					{
						jobType: SCHEDULED_JOB_TYPES.WIDGETS_DATABASE_BACKUP,
						scheduleKey: period.key,
						trigger: ScheduledJobRunTrigger.SCHEDULED,
						scheduledFor: widgetsScheduledFor,
						periodStart: period.start,
						periodEnd: period.end,
						input: input as unknown as Prisma.InputJsonObject,
						availableAt: widgetsScheduledFor
					},
					this.getEventForType(SCHEDULED_JOB_TYPES.WIDGETS_DATABASE_BACKUP)
				),
				billing: await this.scheduledJobs.enqueueUniqueInTransaction(
					transaction,
					{
						jobType: SCHEDULED_JOB_TYPES.BILLING_DATABASE_BACKUP,
						scheduleKey: period.key,
						trigger: ScheduledJobRunTrigger.SCHEDULED,
						scheduledFor: billingScheduledFor,
						periodStart: period.start,
						periodEnd: period.end,
						input: input as unknown as Prisma.InputJsonObject,
						availableAt: billingScheduledFor
					},
					this.getEventForType(SCHEDULED_JOB_TYPES.BILLING_DATABASE_BACKUP)
				),
				identity: await this.scheduledJobs.enqueueUniqueInTransaction(
					transaction,
					{
						jobType: SCHEDULED_JOB_TYPES.IDENTITY_DATABASE_BACKUP,
						scheduleKey: period.key,
						trigger: ScheduledJobRunTrigger.SCHEDULED,
						scheduledFor: identityScheduledFor,
						periodStart: period.start,
						periodEnd: period.end,
						input: input as unknown as Prisma.InputJsonObject,
						availableAt: identityScheduledFor
					},
					this.getEventForType(
						SCHEDULED_JOB_TYPES.IDENTITY_DATABASE_BACKUP
					)
				),
				platform: await this.scheduledJobs.enqueueUniqueInTransaction(
					transaction,
					{
						jobType: SCHEDULED_JOB_TYPES.PLATFORM_DATABASE_BACKUP,
						scheduleKey: period.key,
						trigger: ScheduledJobRunTrigger.SCHEDULED,
						scheduledFor: platformScheduledFor,
						periodStart: period.start,
						periodEnd: period.end,
						input: input as unknown as Prisma.InputJsonObject,
						availableAt: platformScheduledFor
					},
					this.getEventForType(
						SCHEDULED_JOB_TYPES.PLATFORM_DATABASE_BACKUP
					)
				),
				support: await this.scheduledJobs.enqueueUniqueInTransaction(
					transaction,
					{
						jobType: SCHEDULED_JOB_TYPES.SUPPORT_DATABASE_BACKUP,
						scheduleKey: period.key,
						trigger: ScheduledJobRunTrigger.SCHEDULED,
						scheduledFor: supportScheduledFor,
						periodStart: period.start,
						periodEnd: period.end,
						input: input as unknown as Prisma.InputJsonObject,
						availableAt: supportScheduledFor
					},
					this.getEventForType(SCHEDULED_JOB_TYPES.SUPPORT_DATABASE_BACKUP)
				)
			}),
			{ timeout: 10_000 }
		);
	}

	getEventForType(jobType: string): ScheduledJobOutboxEvent {
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

	async getDatabaseBackupOverview(): Promise<DatabaseBackupOverview> {
		const generatedAt = new Date();
		const settings = await this.getSettings();
		const targets = Object.values(DATABASE_BACKUP_TARGETS);
		const items = await Promise.all(
			targets.map(target =>
				this.getDatabaseBackupOverviewItem(
					target,
					settings.databaseBackupEnabled,
					generatedAt
				)
			)
		);

		return {
			databaseBackupEnabled: settings.databaseBackupEnabled,
			generatedAt: generatedAt.toISOString(),
			staleAfterHours: DATABASE_BACKUP_FRESHNESS_HOURS,
			items
		};
	}

	async getDatabaseBackupJobs(
		query: DatabaseBackupJobsQuery
	): Promise<DatabaseBackupJobsPage> {
		const where: Prisma.ScheduledJobRunWhereInput = {
			jobType: query.target
				? this.getDatabaseBackupJobType(query.target)
				: { in: [...DATABASE_BACKUP_JOB_TYPES] },
			...(query.trigger ? { trigger: query.trigger } : {}),
			...(query.status ? { status: query.status } : {})
		};
		const [jobs, total] = await Promise.all([
			this.prisma.scheduledJobRun.findMany({
				where,
				orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
				skip: (query.page - 1) * query.limit,
				take: query.limit
			}),
			this.prisma.scheduledJobRun.count({ where })
		]);

		return {
			items: jobs.map(job =>
				this.toDatabaseBackupAdminJobSummary(
					this.getDatabaseBackupTarget(job.jobType),
					job
				)
			),
			page: query.page,
			limit: query.limit,
			total,
			totalPages: Math.max(1, Math.ceil(total / query.limit))
		};
	}

	private async getDatabaseBackupOverviewItem(
		target: DatabaseBackupTarget,
		databaseBackupEnabled: boolean,
		generatedAt: Date
	): Promise<DatabaseBackupOverviewItem> {
		const jobType = this.getDatabaseBackupJobType(target);
		const baseWhere: Prisma.ScheduledJobRunWhereInput = { jobType };
		const [latest, latestScheduled, latestManual, latestSuccessful] =
			await Promise.all([
				this.prisma.scheduledJobRun.findFirst({
					where: baseWhere,
					orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
				}),
				this.prisma.scheduledJobRun.findFirst({
					where: {
						...baseWhere,
						trigger: ScheduledJobRunTrigger.SCHEDULED
					},
					orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
				}),
				this.prisma.scheduledJobRun.findFirst({
					where: {
						...baseWhere,
						trigger: ScheduledJobRunTrigger.MANUAL
					},
					orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
				}),
				this.prisma.scheduledJobRun.findFirst({
					where: {
						...baseWhere,
						status: ScheduledJobRunStatus.SUCCEEDED
					},
					orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }]
				})
			]);
		const successfulAt = latestSuccessful?.finishedAt ?? null;
		const staleAfter = successfulAt
			? new Date(
					successfulAt.getTime() +
						DATABASE_BACKUP_FRESHNESS_HOURS * 60 * 60 * 1000
				)
			: null;
		const freshness = !databaseBackupEnabled
			? 'DISABLED'
			: !successfulAt
				? 'MISSING'
				: staleAfter && staleAfter.getTime() <= generatedAt.getTime()
					? 'STALE'
					: 'FRESH';

		return {
			target,
			freshness,
			staleAfter: staleAfter?.toISOString() ?? null,
			latest: latest
				? this.toDatabaseBackupAdminJobSummary(target, latest)
				: null,
			latestScheduled: latestScheduled
				? this.toDatabaseBackupAdminJobSummary(target, latestScheduled)
				: null,
			latestManual: latestManual
				? this.toDatabaseBackupAdminJobSummary(target, latestManual)
				: null,
			latestSuccessful: latestSuccessful
				? this.toDatabaseBackupAdminJobSummary(target, latestSuccessful)
				: null
		};
	}

	private toDatabaseBackupAdminJobSummary(
		target: DatabaseBackupTarget,
		job: {
			id: string;
			trigger: ScheduledJobRunTrigger;
			status: ScheduledJobRunStatus;
			createdAt: Date;
			startedAt: Date | null;
			finishedAt: Date | null;
			attempts: number;
			maxAttempts: number;
			result: Prisma.JsonValue | null;
			lastError: string | null;
		}
	): DatabaseBackupAdminJobSummary {
		return {
			target,
			jobId: job.id,
			trigger: job.trigger,
			status: job.status,
			queuedAt: job.createdAt.toISOString(),
			startedAt: job.startedAt?.toISOString() ?? null,
			completedAt: job.finishedAt?.toISOString() ?? null,
			attempts: job.attempts,
			maxAttempts: job.maxAttempts,
			fileSize: this.getDatabaseBackupFileSize(job.result),
			hasError:
				job.status === ScheduledJobRunStatus.FAILED ||
				Boolean(job.lastError)
		};
	}

	private getDatabaseBackupFileSize(result: Prisma.JsonValue | null) {
		if (!result || typeof result !== 'object' || Array.isArray(result)) {
			return null;
		}
		const fileSize = result.fileSize;
		return typeof fileSize === 'number' &&
			Number.isSafeInteger(fileSize) &&
			fileSize >= 0
			? fileSize
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
			fileSize: this.getDatabaseBackupFileSize(job.result),
			hasError:
				job.status === ScheduledJobRunStatus.FAILED ||
				Boolean(job.lastError)
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
			case 'notification-delivery':
				return SCHEDULED_JOB_TYPES.NOTIFICATION_DELIVERY_DATABASE_BACKUP;
			case 'campaigns':
				return SCHEDULED_JOB_TYPES.CAMPAIGNS_DATABASE_BACKUP;
			case 'reporting':
				return SCHEDULED_JOB_TYPES.REPORTING_DATABASE_BACKUP;
			case 'widgets':
				return SCHEDULED_JOB_TYPES.WIDGETS_DATABASE_BACKUP;
			case 'billing':
				return SCHEDULED_JOB_TYPES.BILLING_DATABASE_BACKUP;
			case 'identity':
				return SCHEDULED_JOB_TYPES.IDENTITY_DATABASE_BACKUP;
			case 'platform':
				return SCHEDULED_JOB_TYPES.PLATFORM_DATABASE_BACKUP;
			case 'support':
				return SCHEDULED_JOB_TYPES.SUPPORT_DATABASE_BACKUP;
		}
	}

	private getDatabaseBackupTarget(jobType: string): DatabaseBackupTarget {
		switch (jobType) {
			case SCHEDULED_JOB_TYPES.NOTIFICATION_DELIVERY_DATABASE_BACKUP:
				return DATABASE_BACKUP_TARGETS.NOTIFICATION_DELIVERY;
			case SCHEDULED_JOB_TYPES.CAMPAIGNS_DATABASE_BACKUP:
				return DATABASE_BACKUP_TARGETS.CAMPAIGNS;
			case SCHEDULED_JOB_TYPES.REPORTING_DATABASE_BACKUP:
				return DATABASE_BACKUP_TARGETS.REPORTING;
			case SCHEDULED_JOB_TYPES.WIDGETS_DATABASE_BACKUP:
				return DATABASE_BACKUP_TARGETS.WIDGETS;
			case SCHEDULED_JOB_TYPES.BILLING_DATABASE_BACKUP:
				return DATABASE_BACKUP_TARGETS.BILLING;
			case SCHEDULED_JOB_TYPES.IDENTITY_DATABASE_BACKUP:
				return DATABASE_BACKUP_TARGETS.IDENTITY;
			case SCHEDULED_JOB_TYPES.PLATFORM_DATABASE_BACKUP:
				return DATABASE_BACKUP_TARGETS.PLATFORM;
			case SCHEDULED_JOB_TYPES.SUPPORT_DATABASE_BACKUP:
				return DATABASE_BACKUP_TARGETS.SUPPORT;
			default:
				throw new Error(
					`Unsupported database backup job type: ${jobType}`
				);
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
