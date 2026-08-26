import { ReportingMetricsService } from '../metrics/reporting-metrics.service';
import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import { ReportingRuntimeService } from '../runtime/reporting-runtime.service';
import {
	DailySummarySettingsService,
	validateDailySummarySettingsConfig
} from '../settings/daily-summary-settings.service';
import { DailySummaryRunService } from './daily-summary-run.service';
import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

const POLL_INTERVAL_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 20_000;

@Injectable()
export class DailySummarySchedulerService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(DailySummarySchedulerService.name);
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;
	private stopping = false;
	private firstTickCompleted = false;

	constructor(
		private readonly prisma: ReportingPrismaService,
		private readonly runs: DailySummaryRunService,
		private readonly runtime: ReportingRuntimeService,
		private readonly metrics: ReportingMetricsService,
		private readonly settingsService: DailySummarySettingsService
	) {}

	onModuleInit(): void {
		if (!this.runtime.schedulerEnabled) return;
		void this.scheduleTick();
		this.timer = setInterval(
			() => void this.scheduleTick(),
			POLL_INTERVAL_MS
		);
		this.timer.unref();
	}

	isReady(): boolean {
		return !this.runtime.schedulerEnabled || this.firstTickCompleted;
	}

	async beforeApplicationShutdown(): Promise<void> {
		this.stopping = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		if (!this.running) return;
		await Promise.race([
			this.running.catch(() => undefined),
			new Promise<void>(resolve =>
				setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref()
			)
		]);
	}

	private async scheduleTick(): Promise<void> {
		if (this.stopping || this.running) return;
		this.running = this.tick();
		try {
			await this.running;
			this.firstTickCompleted = true;
			this.metrics.setGauge('scheduler_ready', 1);
		} catch (error) {
			this.logger.error(
				`Daily Summary scheduler tick failed: ${this.error(error)}`
			);
			this.metrics.increment('scheduler_tick_failures_total');
		} finally {
			this.running = null;
		}
	}

	private async tick(): Promise<void> {
		await this.runs.recoverExpiredRuns();
		const settings = await this.settingsService.getSchedulerSettings();
		if (settings.enabled) {
			validateDailySummarySettingsConfig({
				enabled: settings.enabled,
				destinationChatId: settings.destinationChatId,
				messageThreadId: settings.messageThreadId,
				operationalAlertsThreadId: settings.operationalAlertsThreadId,
				scheduleTime: settings.scheduleTime,
				timezone: settings.timezone
			});
			await this.enqueueCurrentPeriod(settings);
		}
		await this.runs.processNextPendingRun();
	}

	private async enqueueCurrentPeriod(settings: {
		destinationChatId: string | null;
		messageThreadId: number | null;
		scheduleTime: string;
		timezone: string;
		lastSuccessfulPeriodStart: Date | null;
	}): Promise<void> {
		if (!settings.destinationChatId || !settings.messageThreadId) return;
		const now = dayjs();
		const zonedNow = now.tz(settings.timezone);
		const [hour, minute] = settings.scheduleTime.split(':').map(Number);
		const scheduledFor = zonedNow
			.startOf('day')
			.hour(hour)
			.minute(minute)
			.second(0)
			.millisecond(0);
		if (zonedNow.isBefore(scheduledFor)) return;
		const periodEnd = zonedNow.startOf('day');
		const periodStart = periodEnd.subtract(1, 'day');
		if (
			settings.lastSuccessfulPeriodStart &&
			settings.lastSuccessfulPeriodStart.getTime() >=
				periodStart.toDate().getTime()
		) {
			return;
		}
		const periodKey = `${settings.timezone}:${periodStart.format('YYYY-MM-DD')}`;
		const created = await this.prisma.reportRun.createMany({
			data: {
				periodKey,
				periodStart: periodStart.toDate(),
				periodEnd: periodEnd.toDate(),
				timezone: settings.timezone,
				destinationChatId: settings.destinationChatId,
				messageThreadId: settings.messageThreadId
			},
			skipDuplicates: true
		});
		if (created.count) {
			this.metrics.increment('report_runs_created_total');
			this.logger.log(`Daily Summary run created period=${periodKey}`);
		}
	}

	private error(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
