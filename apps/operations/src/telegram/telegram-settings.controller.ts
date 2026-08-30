import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Headers,
	HttpCode,
	NotFoundException,
	Param,
	Patch,
	Post,
	Query,
	Req,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import {
	ScheduledJobRunStatus,
	ScheduledJobRunTrigger
} from '@prisma/operations-client';
import type { Request } from 'express';
import { AdminEventLogService } from '../admin-event-log/admin-event-log.service';
import { CurrentOperationsActor } from '../auth/current-operations-actor.decorator';
import {
	OperationsAuth,
	OperationsAuthGuard
} from '../auth/operations-auth.guard';
import type { OperationsActor } from '../auth/operations-request';
import {
	getOperationsClientContext,
	OPERATIONS_SCALAR_QUERY_PIPE
} from '../common/operations-request-context';
import {
	DATABASE_BACKUP_JOB_TYPES,
	DATABASE_BACKUP_TARGETS,
	DatabaseBackupTarget,
	databaseBackupJobType,
	ScheduledJobView
} from '../scheduled-jobs/scheduled-jobs.types';
import { ScheduledJobsService } from '../scheduled-jobs/scheduled-jobs.service';
import { UpdateTelegramSettingsDto } from './telegram-settings.dto';
import { TelegramSettingsService } from './telegram-settings.service';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATABASE_BACKUP_FRESHNESS_HOURS = 36;

@Controller('telegram-bot')
@OperationsAuth(['ADMIN'])
@UseGuards(OperationsAuthGuard)
export class TelegramSettingsController {
	constructor(
		private readonly settings: TelegramSettingsService,
		private readonly jobs: ScheduledJobsService,
		private readonly audit: AdminEventLogService
	) {}

	@Get('admin/settings')
	@HttpCode(200)
	getSettings() {
		return this.settings.getSettings();
	}

	@Patch('admin/settings')
	@HttpCode(200)
	@UsePipes(
		new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })
	)
	updateSettings(
		@Body() dto: UpdateTelegramSettingsDto,
		@CurrentOperationsActor() actor: OperationsActor,
		@Req() request: Request
	) {
		const context = getOperationsClientContext(request);
		return this.settings.updateSettings(dto, (transaction, next) =>
			this.audit.recordInTransaction(transaction, {
				adminId: actor.subject,
				section: 'TELEGRAM_BOT',
				action: 'TELEGRAM_BOT_SETTINGS_UPDATE',
				description: 'Обновлены настройки Telegram-ботов',
				entityType: 'telegram_bot_settings',
				entityId: 'singleton',
				entityLabel: 'Telegram-боты',
				metadata: {
					databaseBackupEnabled: next.databaseBackupEnabled,
					databaseBackupTime: next.databaseBackupTime
				},
				ip: context.ip,
				userAgent: context.userAgent
			})
		);
	}

	@Post('admin/database-backups/:target/send')
	@HttpCode(202)
	async sendBackup(
		@Param('target') rawTarget: string,
		@Headers('idempotency-key') idempotencyKey: string | undefined,
		@CurrentOperationsActor() actor: OperationsActor,
		@Req() request: Request
	) {
		const target = this.target(rawTarget);
		if (!idempotencyKey || !UUID_PATTERN.test(idempotencyKey)) {
			throw new BadRequestException(
				'Заголовок Idempotency-Key должен содержать UUID'
			);
		}
		const settings = await this.settings.getSettings();
		if (
			!settings.databaseBackupEnabled ||
			!settings.dailySummaryChatId.trim() ||
			!settings.databaseBackupThreadId
		) {
			throw new BadRequestException(
				'Отправка database backup не настроена'
			);
		}
		const jobType = databaseBackupJobType(target);
		const result = await this.jobs.enqueueManual(
			actor.subject,
			idempotencyKey,
			{
				jobType,
				scheduleKey: `manual:${actor.subject}:${idempotencyKey}`,
				scheduledFor: new Date(),
				input: {
					schemaVersion: 1,
					target,
					requestedByAdminId: actor.subject,
					chatId: settings.dailySummaryChatId,
					messageThreadId: settings.databaseBackupThreadId,
					trigger: 'MANUAL'
				}
			}
		);
		const context = getOperationsClientContext(request);
		await this.audit.record({
			adminId: actor.subject,
			section: 'TELEGRAM_BOT',
			action: 'TELEGRAM_DATABASE_BACKUP_CREATE',
			description: `Backup ${target} поставлен в очередь`,
			entityType: 'scheduled_job',
			entityId: result.job.id,
			entityLabel: `Backup PostgreSQL: ${target}`,
			metadata: {
				target,
				jobId: result.job.id,
				status: result.job.status,
				created: result.created
			},
			ip: context.ip,
			userAgent: context.userAgent
		});
		return {
			target,
			jobId: result.job.id,
			status: result.job.status,
			queuedAt: result.job.createdAt,
			created: result.created
		};
	}

	@Get('admin/database-backups/overview')
	@HttpCode(200)
	async getBackupOverview() {
		const settings = await this.settings.getSettings();
		const generatedAt = new Date();
		const items = await Promise.all(
			DATABASE_BACKUP_TARGETS.map(async target => {
				const jobType = databaseBackupJobType(target);
				const [latest, latestScheduled, latestManual, latestSuccessful] =
					await Promise.all([
						this.jobs.getLatest(jobType),
						this.jobs.getLatest(jobType, {
							trigger: ScheduledJobRunTrigger.SCHEDULED
						}),
						this.jobs.getLatest(jobType, {
							trigger: ScheduledJobRunTrigger.MANUAL
						}),
						this.jobs.getLatest(jobType, {
							status: ScheduledJobRunStatus.SUCCEEDED
						})
					]);
				const staleAfter = latestSuccessful?.finishedAt
					? new Date(
							Date.parse(latestSuccessful.finishedAt) +
								DATABASE_BACKUP_FRESHNESS_HOURS * 60 * 60_000
						).toISOString()
					: null;
				const freshness = !settings.databaseBackupEnabled
					? 'DISABLED'
					: !staleAfter
						? 'MISSING'
						: Date.parse(staleAfter) >= generatedAt.getTime()
							? 'FRESH'
							: 'STALE';
				return {
					target,
					freshness,
					staleAfter,
					latest: latest ? this.backupJobSummary(target, latest) : null,
					latestScheduled: latestScheduled
						? this.backupJobSummary(target, latestScheduled)
						: null,
					latestManual: latestManual
						? this.backupJobSummary(target, latestManual)
						: null,
					latestSuccessful: latestSuccessful
						? this.backupJobSummary(target, latestSuccessful)
						: null
				};
			})
		);
		return {
			databaseBackupEnabled: settings.databaseBackupEnabled,
			generatedAt: generatedAt.toISOString(),
			staleAfterHours: DATABASE_BACKUP_FRESHNESS_HOURS,
			items
		};
	}

	@Get('admin/database-backups/jobs')
	@HttpCode(200)
	async getBackupJobs(
		@Query('page', OPERATIONS_SCALAR_QUERY_PIPE) page?: string,
		@Query('limit', OPERATIONS_SCALAR_QUERY_PIPE) limit?: string,
		@Query('target', OPERATIONS_SCALAR_QUERY_PIPE) rawTarget?: string,
		@Query('trigger', OPERATIONS_SCALAR_QUERY_PIPE) rawTrigger?: string,
		@Query('status', OPERATIONS_SCALAR_QUERY_PIPE) rawStatus?: string
	) {
		const target = rawTarget ? this.target(rawTarget) : undefined;
		const trigger = rawTrigger
			? this.enumValue(ScheduledJobRunTrigger, rawTrigger, 'trigger')
			: undefined;
		const status = rawStatus
			? this.enumValue(ScheduledJobRunStatus, rawStatus, 'status')
			: undefined;
		const result = await this.jobs.list({
			jobTypes: target
				? [databaseBackupJobType(target)]
				: DATABASE_BACKUP_JOB_TYPES,
			trigger,
			status,
			page: this.integer(page, 1, 'page'),
			limit: this.integer(limit, 20, 'limit')
		});
		return {
			...result,
			items: result.items.map(job => {
				const matchedTarget = DATABASE_BACKUP_TARGETS.find(
					item => databaseBackupJobType(item) === job.jobType
				);
				if (!matchedTarget) {
					throw new Error('Unsupported database backup job type');
				}
				return this.backupJobSummary(matchedTarget, job);
			})
		};
	}

	@Get('admin/database-backups/:target/jobs/active')
	@HttpCode(200)
	async getLatestActiveManualBackup(
		@Param('target') rawTarget: string,
		@CurrentOperationsActor() actor: OperationsActor
	) {
		const target = this.target(rawTarget);
		const job = await this.jobs.getLatestActiveManual(
			databaseBackupJobType(target),
			actor.subject
		);
		return job ? this.backupJob(target, job) : null;
	}

	@Get('admin/database-backups/:target/jobs/:jobId')
	@HttpCode(200)
	async getBackupJob(
		@Param('target') rawTarget: string,
		@Param('jobId') jobId: string,
		@CurrentOperationsActor() actor: OperationsActor
	) {
		const target = this.target(rawTarget);
		if (!UUID_PATTERN.test(jobId))
			throw new BadRequestException('Invalid job id');
		const job = await this.jobs.getManualForAdmin(
			jobId,
			databaseBackupJobType(target),
			actor.subject
		);
		if (!job) {
			throw new NotFoundException('Задание backup не найдено');
		}
		return this.backupJob(target, job);
	}

	private target(value: string): DatabaseBackupTarget {
		if (!DATABASE_BACKUP_TARGETS.includes(value as DatabaseBackupTarget)) {
			throw new BadRequestException('Некорректная цель database backup');
		}
		return value as DatabaseBackupTarget;
	}

	private enumValue<T extends Record<string, string>>(
		type: T,
		value: string,
		label: string
	): T[keyof T] {
		if (!Object.values(type).includes(value)) {
			throw new BadRequestException(`Некорректный ${label}`);
		}
		return value as T[keyof T];
	}

	private integer(
		raw: string | undefined,
		fallback: number,
		label: string
	) {
		if (!raw) return fallback;
		const value = Number(raw);
		if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
			throw new BadRequestException(`Некорректный ${label}`);
		}
		return value;
	}

	private backupJob(target: DatabaseBackupTarget, job: ScheduledJobView) {
		const summary = this.backupJobSummary(target, job);
		return {
			target: summary.target,
			jobId: summary.jobId,
			status: summary.status,
			queuedAt: summary.queuedAt,
			startedAt: summary.startedAt,
			completedAt: summary.completedAt,
			fileSize: summary.fileSize,
			hasError: summary.hasError
		};
	}

	private backupJobSummary(
		target: DatabaseBackupTarget,
		job: ScheduledJobView
	) {
		const result =
			job.result &&
			typeof job.result === 'object' &&
			!Array.isArray(job.result)
				? job.result
				: null;
		const fileSize = result?.fileSize;
		return {
			target,
			jobId: job.id,
			trigger: job.trigger,
			status: job.status,
			queuedAt: job.createdAt,
			startedAt: job.startedAt,
			completedAt: job.finishedAt,
			attempts: job.attempts,
			maxAttempts: job.maxAttempts,
			fileSize:
				typeof fileSize === 'number' && fileSize >= 0 ? fileSize : null,
			hasError:
				job.status === ScheduledJobRunStatus.FAILED ||
				Boolean(job.lastError)
		};
	}
}
