import { PrismaService } from '@/prisma.service';
import { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import {
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
			const [failedOutbox, unresolvedDlq, publisher, worker] =
				await Promise.all([
					this.prisma.outboxEvent.count({
						where: { status: 'FAILED' }
					}),
					this.prisma.integrationDeliveryFailure.count({
						where: { resolvedAt: null }
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
					})
				]);
			const signature = [
				failedOutbox,
				unresolvedDlq,
				publisher > 0 ? 1 : 0,
				worker > 0 ? 1 : 0
			].join(':');
			const hasProblem =
				failedOutbox > 0 ||
				unresolvedDlq > 0 ||
				publisher === 0 ||
				worker === 0;

			if (!hasProblem) {
				if (this.lastProblemSignature) {
					await this.telegramBot.sendMessagingOperationalAlert(
						'<b>Очереди интеграций восстановлены</b>\nOutbox publisher и integration worker работают, необработанных ошибок нет.'
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
					`DLQ не обработано: <b>${unresolvedDlq}</b>`,
					`Outbox publisher: <b>${publisher > 0 ? 'работает' : 'нет heartbeat'}</b>`,
					`Integration worker: <b>${worker > 0 ? 'работает' : 'нет heartbeat'}</b>`
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
