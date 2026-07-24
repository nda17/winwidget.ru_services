import {
	MoscowDayPeriod,
	ScheduledTasksService
} from '@/maintenance/scheduled-tasks.service';
import { PrismaService } from '@/prisma.service';
import { ScheduledJobsService } from '@/scheduled-jobs/scheduled-jobs.service';
import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MaintenanceSchedulerService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(MaintenanceSchedulerService.name);
	private readonly moscowOffsetMs = 3 * 60 * 60 * 1000;
	private timer: NodeJS.Timeout | null = null;
	private running = false;

	constructor(
		private readonly configService: ConfigService,
		private readonly scheduledJobs: ScheduledJobsService,
		private readonly tasks: ScheduledTasksService,
		private readonly prisma: PrismaService
	) {}

	onModuleInit(): void {
		void this.tick();
		this.timer = setInterval(
			() => void this.tick(),
			this.getPollInterval()
		);
		this.timer.unref();
	}

	onApplicationShutdown(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	private async tick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			const recovered = await this.scheduledJobs.recoverExpired(
				job => this.tasks.getEventForType(job.jobType),
				{ retryDelayMs: 30_000 }
			);
			if (recovered.requeued || recovered.failed) {
				this.logger.warn(
					`Recovered expired scheduled jobs requeued=${recovered.requeued} failed=${recovered.failed}`
				);
			}

			const settings = await this.getSettings();
			const now = new Date();
			const period = this.getPreviousMoscowDay(now);

			if (this.isDue(now, settings.dailySummaryTime, '01:50')) {
				const summary = await this.tasks.enqueueDailySummary(
					period,
					this.getScheduledFor(now, settings.dailySummaryTime, '01:50')
				);
				if (summary?.created) {
					this.logger.log(
						`Daily Telegram summary scheduled period=${period.key} jobId=${summary.job.id}`
					);
				}
			}

			if (this.isDue(now, settings.databaseBackupTime, '01:45')) {
				const backup = await this.tasks.enqueueDailyDatabaseBackup(
					period,
					this.getScheduledFor(now, settings.databaseBackupTime, '01:45')
				);
				if (backup?.created) {
					this.logger.log(
						`Daily database backup scheduled period=${period.key} jobId=${backup.job.id}`
					);
				}
			}
		} catch (error) {
			this.logger.error(
				`Maintenance scheduler tick failed: ${
					error instanceof Error ? error.stack : String(error)
				}`
			);
		} finally {
			this.running = false;
		}
	}

	private getPreviousMoscowDay(now: Date): MoscowDayPeriod {
		const shiftedNow = new Date(now.getTime() + this.moscowOffsetMs);
		const shiftedTodayStart = new Date(shiftedNow);
		shiftedTodayStart.setUTCHours(0, 0, 0, 0);
		const shiftedStart = new Date(shiftedTodayStart);
		shiftedStart.setUTCDate(shiftedStart.getUTCDate() - 1);
		const start = new Date(shiftedStart.getTime() - this.moscowOffsetMs);
		const end = new Date(
			shiftedTodayStart.getTime() - this.moscowOffsetMs
		);
		const key = shiftedStart.toISOString().slice(0, 10);
		return { start, end, key };
	}

	private isDue(now: Date, value: string, fallback: string): boolean {
		return (
			now.getTime() >= this.getScheduledFor(now, value, fallback).getTime()
		);
	}

	private getScheduledFor(
		now: Date,
		value: string,
		fallback: string
	): Date {
		const [hour, minute] = this.normalizeTime(value, fallback)
			.split(':')
			.map(Number);
		const shifted = new Date(now.getTime() + this.moscowOffsetMs);
		shifted.setUTCHours(hour, minute, 0, 0);
		return new Date(shifted.getTime() - this.moscowOffsetMs);
	}

	private normalizeTime(value: string, fallback: string): string {
		const normalized = value?.trim();
		return /^([01]\d|2[0-3]):[0-5]\d$/.test(normalized)
			? normalized
			: fallback;
	}

	private getSettings() {
		return this.prisma.telegramBotSettings.upsert({
			where: { id: 'singleton' },
			update: {},
			create: { id: 'singleton' }
		});
	}

	private getPollInterval(): number {
		const value = Number(
			this.configService.get<string>('SCHEDULED_JOB_POLL_INTERVAL_MS') ||
				30_000
		);
		return Number.isInteger(value) && value >= 5_000
			? Math.min(value, 5 * 60 * 1000)
			: 30_000;
	}
}
