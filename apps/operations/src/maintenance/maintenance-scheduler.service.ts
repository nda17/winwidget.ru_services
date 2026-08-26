import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import {
	OperationalAlertSeverity,
	ScheduledJobRunTrigger
} from '@prisma/operations-client';
import { OperationalAlertService } from '../monitoring/operational-alert.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { OperationsRuntimeService } from '../runtime/operations-runtime.service';
import {
	DATABASE_BACKUP_DELAY_MINUTES,
	DATABASE_BACKUP_TARGETS,
	databaseBackupJobType
} from '../scheduled-jobs/scheduled-jobs.types';
import { ScheduledJobsService } from '../scheduled-jobs/scheduled-jobs.service';

const MOSCOW_UTC_OFFSET_MINUTES = 180;

@Injectable()
export class MaintenanceSchedulerService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(MaintenanceSchedulerService.name);
	private timer: NodeJS.Timeout | null = null;
	private running = false;

	constructor(
		private readonly runtime: OperationsRuntimeService,
		private readonly prisma: OperationsPrismaService,
		private readonly jobs: ScheduledJobsService,
		private readonly alerts: OperationalAlertService
	) {}

	onModuleInit(): void {
		if (!this.runtime.workerEnabled) return;
		this.timer = setInterval(() => void this.tick(), 30_000);
		this.timer.unref();
		void this.tick();
	}

	onApplicationShutdown(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	async tick(now = new Date()): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			const settings = await this.prisma.telegramBotSettings.upsert({
				where: { id: 'singleton' },
				update: {},
				create: { id: 'singleton' }
			});
			if (
				!settings.databaseBackupEnabled ||
				!settings.dailySummaryChatId.trim() ||
				!settings.databaseBackupThreadId
			) {
				await this.alerts.resolve('database-backup-scheduler');
				return;
			}
			const period = this.moscowPeriod(now);
			const [hour, minute] = settings.databaseBackupTime
				.split(':')
				.map(Number);
			if (
				!Number.isInteger(hour) ||
				!Number.isInteger(minute) ||
				hour < 0 ||
				hour > 23 ||
				minute < 0 ||
				minute > 59
			) {
				throw new Error('Database backup schedule is invalid');
			}
			for (const target of DATABASE_BACKUP_TARGETS) {
				const scheduledFor = new Date(
					period.start.getTime() +
						(hour * 60 + minute + DATABASE_BACKUP_DELAY_MINUTES[target]) *
							60_000
				);
				if (scheduledFor.getTime() > now.getTime()) continue;
				await this.jobs.enqueueUnique({
					jobType: databaseBackupJobType(target),
					scheduleKey: `daily:${target}:${period.key}`,
					trigger: ScheduledJobRunTrigger.SCHEDULED,
					scheduledFor,
					periodStart: period.start,
					periodEnd: period.end,
					input: {
						schemaVersion: 1,
						target,
						chatId: settings.dailySummaryChatId,
						messageThreadId: settings.databaseBackupThreadId,
						trigger: 'SCHEDULED',
						periodStart: period.start.toISOString()
					},
					availableAt: scheduledFor
				});
			}
			await this.alerts.resolve('database-backup-scheduler');
		} catch (error) {
			await this.alerts
				.record({
					deduplicationKey: 'database-backup-scheduler',
					type: 'INTEGRATION_PROBLEM',
					severity: OperationalAlertSeverity.HIGH,
					source: 'operations',
					referenceId: 'database-backup-scheduler',
					title: 'Планировщик backup требует внимания',
					message:
						error instanceof Error && error.message.includes('schedule')
							? 'Некорректная конфигурация расписания database backup'
							: 'Планировщик не смог создать durable backup jobs'
				})
				.catch(() => undefined);
			this.logger.error('Operations maintenance scheduler tick failed');
		} finally {
			this.running = false;
		}
	}

	private moscowPeriod(now: Date) {
		const moscow = new Date(
			now.getTime() + MOSCOW_UTC_OFFSET_MINUTES * 60_000
		);
		const year = moscow.getUTCFullYear();
		const month = moscow.getUTCMonth();
		const date = moscow.getUTCDate();
		const start = new Date(
			Date.UTC(year, month, date) - MOSCOW_UTC_OFFSET_MINUTES * 60_000
		);
		return {
			key: `${year}-${String(month + 1).padStart(2, '0')}-${String(date).padStart(2, '0')}`,
			start,
			end: new Date(start.getTime() + 24 * 60 * 60_000)
		};
	}
}
