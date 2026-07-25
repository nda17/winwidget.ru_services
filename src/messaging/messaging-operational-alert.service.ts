import { PrismaService } from '@/prisma.service';
import { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import {
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxEventStatus } from '@prisma/client';

@Injectable()
export class MessagingOperationalAlertService
	implements OnModuleInit, OnModuleDestroy
{
	private readonly logger = new Logger(
		MessagingOperationalAlertService.name
	);
	private timer?: NodeJS.Timeout;
	private lastProblemSignature: string | null = null;

	constructor(
		private readonly prisma: PrismaService,
		private readonly telegramBot: TelegramBotService,
		private readonly configService: ConfigService
	) {}

	onModuleInit(): void {
		if (!this.isEnabled()) return;
		this.timer = setInterval(() => void this.check(), 5 * 60 * 1000);
		this.timer.unref();
		setTimeout(() => void this.check(), 30_000).unref();
	}

	onModuleDestroy(): void {
		if (this.timer) clearInterval(this.timer);
	}

	private async check(): Promise<void> {
		try {
			const staleBefore = new Date(Date.now() - 30_000);
			const oldPendingBefore = new Date(Date.now() - 15 * 60 * 1000);
			const [
				failedOutbox,
				stalePendingOutbox,
				unresolvedDlq,
				dlqByCategory,
				failedScheduledJobs,
				staleScheduledJobs,
				publisher,
				worker,
				maintenanceWorker
			] = await Promise.all([
				this.prisma.outboxEvent.count({
					where: { status: OutboxEventStatus.FAILED }
				}),
				this.prisma.outboxEvent.count({
					where: {
						status: {
							in: [OutboxEventStatus.PENDING, OutboxEventStatus.PUBLISHING]
						},
						createdAt: { lt: oldPendingBefore }
					}
				}),
				this.prisma.integrationDeliveryFailure.count({
					where: { resolvedAt: null }
				}),
				this.prisma.integrationDeliveryFailure.groupBy({
					by: ['category', 'normalizedCode'],
					where: { resolvedAt: null },
					_count: { _all: true }
				}),
				this.prisma.scheduledJobRun.count({
					where: { status: 'FAILED' }
				}),
				this.prisma.scheduledJobRun.count({
					where: {
						OR: [
							{
								status: 'QUEUED',
								availableAt: { lt: oldPendingBefore }
							},
							{
								status: 'PROCESSING',
								leaseExpiresAt: { lt: new Date() }
							}
						]
					}
				}),
				this.prisma.messagingHeartbeat.count({
					where: {
						service: 'outbox-publisher',
						lastSeenAt: { gte: staleBefore }
					}
				}),
				this.prisma.messagingHeartbeat.count({
					where: {
						service: 'integration-worker',
						lastSeenAt: { gte: staleBefore }
					}
				}),
				this.prisma.messagingHeartbeat.count({
					where: {
						service: 'maintenance-worker',
						lastSeenAt: { gte: staleBefore }
					}
				})
			]);
			const categoryCounts: Record<string, number> = {};
			for (const item of dlqByCategory) {
				const key =
					!item.category || item.normalizedCode === 'UNCLASSIFIED'
						? 'UNCLASSIFIED'
						: item.category;
				categoryCounts[key] =
					(categoryCounts[key] || 0) + item._count._all;
			}
			const signature = [
				failedOutbox,
				stalePendingOutbox,
				unresolvedDlq,
				categoryCounts.TRANSIENT || 0,
				categoryCounts.RATE_LIMIT || 0,
				categoryCounts.PERMANENT || 0,
				categoryCounts.AUTH_CONFIGURATION || 0,
				categoryCounts.UNCLASSIFIED || 0,
				failedScheduledJobs,
				staleScheduledJobs,
				publisher > 0 ? 1 : 0,
				worker > 0 ? 1 : 0,
				maintenanceWorker > 0 ? 1 : 0
			].join(':');
			const hasProblem =
				failedOutbox > 0 ||
				stalePendingOutbox > 0 ||
				unresolvedDlq > 0 ||
				failedScheduledJobs > 0 ||
				staleScheduledJobs > 0 ||
				publisher === 0 ||
				worker === 0 ||
				maintenanceWorker === 0;

			if (!hasProblem) {
				if (this.lastProblemSignature) {
					await this.telegramBot.sendMessagingOperationalAlert(
						'<b>Очереди интеграций восстановлены</b>\nOutbox publisher, integration worker и maintenance worker работают, необработанных ошибок нет.'
					);
				}
				this.lastProblemSignature = null;
				return;
			}
			if (signature === this.lastProblemSignature) return;

			await this.telegramBot.sendMessagingOperationalAlert(
				[
					'<b>Проблема в очередях интеграций</b>',
					`Outbox FAILED: <b>${failedOutbox}</b>`,
					`Outbox PENDING/PUBLISHING старше 15 минут: <b>${stalePendingOutbox}</b>`,
					`DLQ не обработано: <b>${unresolvedDlq}</b>`,
					`— временные: <b>${categoryCounts.TRANSIENT || 0}</b>`,
					`— rate limit: <b>${categoryCounts.RATE_LIMIT || 0}</b>`,
					`— постоянные: <b>${categoryCounts.PERMANENT || 0}</b>`,
					`— авторизация/настройка: <b>${categoryCounts.AUTH_CONFIGURATION || 0}</b>`,
					`— без классификации: <b>${categoryCounts.UNCLASSIFIED || 0}</b>`,
					`Scheduled jobs FAILED: <b>${failedScheduledJobs}</b>`,
					`Scheduled jobs с задержкой/просроченным lease: <b>${staleScheduledJobs}</b>`,
					`Outbox publisher: <b>${publisher > 0 ? 'работает' : 'нет heartbeat'}</b>`,
					`Integration worker: <b>${worker > 0 ? 'работает' : 'нет heartbeat'}</b>`,
					`Maintenance worker: <b>${maintenanceWorker > 0 ? 'работает' : 'нет heartbeat'}</b>`
				].join('\n')
			);
			this.lastProblemSignature = signature;
		} catch (error) {
			this.logger.error(
				`Messaging alert check failed: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	private isEnabled(): boolean {
		const configured = this.configService.get<string>(
			'MESSAGING_ALERTS_ENABLED'
		);
		if (configured !== undefined) return configured === 'true';
		return this.configService.get<string>('MODE') === 'production';
	}
}
