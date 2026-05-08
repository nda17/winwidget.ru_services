import { PrismaService } from '@/prisma.service';
import { UpdateTelegramBotSettingsDto } from '@/telegram-bot/dto/update-telegram-bot-settings.dto';
import {
	BadRequestException,
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit
} from '@nestjs/common';
import {
	AuthIdentityType,
	PaymentStatus,
	SubscriptionStatus,
	type TelegramBotSettings
} from '@prisma/client';

interface DailySummaryPeriod {
	start: Date;
	end: Date;
	label: string;
}

interface DailySummaryStats {
	period: DailySummaryPeriod;
	generatedAtLabel: string;
	newUsersCount: number;
	succeededPaymentsCount: number;
	succeededPaymentsAmount: number;
	pendingPaymentsCount: number;
	currentPendingPaymentsCount: number;
	cancelledPaymentsCount: number;
	leads: {
		total: number;
		wheel: number;
		quiz: number;
		callback: number;
		countdownTimer: number;
	};
	expiringSubscriptionsCount: number;
	expiredActiveSubscriptionsCount: number;
	usersWithoutEmailCount: number;
	usersWithoutPhoneCount: number;
	usersWithoutContactsCount: number;
}

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
	private readonly DAILY_SUMMARY_HOUR_MOSCOW = 1;
	private readonly DAILY_SUMMARY_MINUTE_MOSCOW = 50;
	private readonly MOSCOW_UTC_OFFSET_HOURS = 3;
	private readonly logger = new Logger(TelegramBotService.name);
	private summaryTimeout: NodeJS.Timeout | null = null;

	constructor(private readonly prisma: PrismaService) {}

	async onModuleInit() {
		await this.sendMissedDailySummaryIfNeeded();
		this.scheduleDailySummary();
	}

	onModuleDestroy() {
		if (this.summaryTimeout) {
			clearTimeout(this.summaryTimeout);
			this.summaryTimeout = null;
		}
	}

	async getSettings() {
		const settings = await this.getOrCreateSettings();
		return this.serializeSettings(settings);
	}

	async updateSettings(dto: UpdateTelegramBotSettingsDto) {
		const currentSettings = await this.getOrCreateSettings();
		const data = this.getSettingsPatch(dto);
		const nextDailySummaryEnabled =
			data.dailySummaryEnabled ?? currentSettings.dailySummaryEnabled;
		const nextDailySummaryChatId =
			data.dailySummaryChatId ?? currentSettings.dailySummaryChatId;

		if (nextDailySummaryEnabled && !nextDailySummaryChatId.trim()) {
			throw new BadRequestException('Укажите ID группы Telegram');
		}

		const settings = await this.prisma.telegramBotSettings.upsert({
			where: { id: 'singleton' },
			update: data,
			create: {
				id: 'singleton',
				...data
			}
		});

		return this.serializeSettings(settings);
	}

	async sendInfoBotMessage(chatId: string, text: string) {
		const token = process.env.TELEGRAM_BOT_TOKEN?.trim();

		if (!token) {
			throw new Error('Info_bot token is not configured');
		}

		await this.sendTelegramMessage(token, chatId, text);
	}

	private getSettingsPatch(dto: UpdateTelegramBotSettingsDto) {
		return {
			...(typeof dto.dailySummaryEnabled === 'boolean'
				? { dailySummaryEnabled: dto.dailySummaryEnabled }
				: {}),
			...(typeof dto.dailySummaryChatId === 'string'
				? { dailySummaryChatId: dto.dailySummaryChatId.trim() }
				: {})
		};
	}

	private async getOrCreateSettings() {
		return this.prisma.telegramBotSettings.upsert({
			where: { id: 'singleton' },
			update: {},
			create: { id: 'singleton' }
		});
	}

	private serializeSettings(settings: TelegramBotSettings) {
		return {
			dailySummaryEnabled: settings.dailySummaryEnabled,
			dailySummaryChatId: settings.dailySummaryChatId,
			dailySummaryLastSentPeriodStart:
				settings.dailySummaryLastSentPeriodStart?.toISOString() ?? null,
			dailySummaryLastSentAt:
				settings.dailySummaryLastSentAt?.toISOString() ?? null,
			telegramBotTokenConfigured: Boolean(
				process.env.TELEGRAM_BOT_TOKEN?.trim()
			),
			updatedAt: settings.updatedAt.toISOString()
		};
	}

	private scheduleDailySummary() {
		const nextRun = this.getNextDailySummaryDate();
		const delay = Math.max(nextRun.getTime() - Date.now(), 1_000);
		const moscowTime = new Date(
			nextRun.getTime() + this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000
		);

		this.logger.log(
			`Next Telegram daily summary scheduled for ${moscowTime.toISOString().replace('T', ' ').slice(0, 16)} MSK.`
		);

		this.summaryTimeout = setTimeout(async () => {
			try {
				const sent = await this.sendDailySummaryIfEnabled();
				this.logger.log(
					sent
						? 'Telegram daily summary sent.'
						: 'Telegram daily summary skipped.'
				);
			} catch (error) {
				this.logger.error(
					`Telegram daily summary failed: ${
						error instanceof Error ? error.message : String(error)
					}`
				);
			} finally {
				this.scheduleDailySummary();
			}
		}, delay);

		this.summaryTimeout.unref?.();
	}

	private async sendMissedDailySummaryIfNeeded() {
		if (!this.shouldRunStartupDailySummary()) {
			return;
		}

		try {
			const sent = await this.sendDailySummaryIfEnabled();
			this.logger.log(
				sent
					? 'Missed Telegram daily summary sent on startup.'
					: 'No missed Telegram daily summary to send on startup.'
			);
		} catch (error) {
			this.logger.error(
				`Telegram daily summary startup check failed: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	private async sendDailySummaryIfEnabled() {
		const settings = await this.getOrCreateSettings();
		const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
		const chatId = settings.dailySummaryChatId.trim();

		if (!settings.dailySummaryEnabled || !chatId || !token) {
			return false;
		}

		const period = this.getPreviousMoscowDayPeriod();

		if (
			settings.dailySummaryLastSentPeriodStart?.getTime() ===
			period.start.getTime()
		) {
			return false;
		}

		const stats = await this.collectDailySummaryStats(period);
		const text = this.buildDailySummaryMessage(stats);

		await this.sendTelegramMessage(token, chatId, text);

		await this.prisma.telegramBotSettings.update({
			where: { id: 'singleton' },
			data: {
				dailySummaryLastSentPeriodStart: period.start,
				dailySummaryLastSentAt: new Date()
			}
		});

		return true;
	}

	private async collectDailySummaryStats(period: DailySummaryPeriod) {
		const range = {
			gte: period.start,
			lt: period.end
		};
		const now = new Date();
		const soonEndsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

		const [
			newUsersCount,
			succeededPayments,
			pendingPaymentsCount,
			currentPendingPaymentsCount,
			cancelledPaymentsCount,
			wheelLeadsCount,
			quizLeadsCount,
			callbackLeadsCount,
			countdownTimerLeadsCount,
			expiringSubscriptionsCount,
			expiredActiveSubscriptionsCount,
			usersWithoutEmailCount,
			usersWithoutPhoneCount,
			usersWithoutContactsCount
		] = await Promise.all([
			this.prisma.user.count({
				where: { createdAt: range }
			}),
			this.prisma.payment.findMany({
				where: {
					status: PaymentStatus.SUCCEEDED,
					updatedAt: range
				},
				select: { amount: true }
			}),
			this.prisma.payment.count({
				where: {
					status: PaymentStatus.PENDING,
					createdAt: range
				}
			}),
			this.prisma.payment.count({
				where: { status: PaymentStatus.PENDING }
			}),
			this.prisma.payment.count({
				where: {
					status: PaymentStatus.CANCELLED,
					updatedAt: range
				}
			}),
			this.prisma.lead.count({ where: { createdAt: range } }),
			this.prisma.quizLead.count({ where: { createdAt: range } }),
			this.prisma.callbackLead.count({ where: { createdAt: range } }),
			this.prisma.countdownTimerLead.count({
				where: { createdAt: range }
			}),
			this.prisma.subscription.count({
				where: {
					status: SubscriptionStatus.ACTIVE,
					expiresAt: {
						gte: now,
						lt: soonEndsAt
					}
				}
			}),
			this.prisma.subscription.count({
				where: {
					status: SubscriptionStatus.ACTIVE,
					expiresAt: {
						lt: now
					}
				}
			}),
			this.prisma.user.count({
				where: {
					authIdentities: {
						none: { type: AuthIdentityType.EMAIL }
					}
				}
			}),
			this.prisma.user.count({
				where: {
					authIdentities: {
						none: { type: AuthIdentityType.PHONE }
					}
				}
			}),
			this.prisma.user.count({
				where: {
					authIdentities: {
						none: {
							type: {
								in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE]
							}
						}
					}
				}
			})
		]);

		const leadsTotal =
			wheelLeadsCount +
			quizLeadsCount +
			callbackLeadsCount +
			countdownTimerLeadsCount;

		return {
			period,
			generatedAtLabel: this.formatMoscowDateTime(new Date()),
			newUsersCount,
			succeededPaymentsCount: succeededPayments.length,
			succeededPaymentsAmount: this.getPaymentsAmount(succeededPayments),
			pendingPaymentsCount,
			currentPendingPaymentsCount,
			cancelledPaymentsCount,
			leads: {
				total: leadsTotal,
				wheel: wheelLeadsCount,
				quiz: quizLeadsCount,
				callback: callbackLeadsCount,
				countdownTimer: countdownTimerLeadsCount
			},
			expiringSubscriptionsCount,
			expiredActiveSubscriptionsCount,
			usersWithoutEmailCount,
			usersWithoutPhoneCount,
			usersWithoutContactsCount
		};
	}

	private buildDailySummaryMessage(stats: DailySummaryStats) {
		return [
			'<b>Ежедневная сводка WinWidget</b>',
			`Период: ${stats.period.label}`,
			`Сформировано: ${stats.generatedAtLabel} МСК`,
			'',
			'<b>Пользователи</b>',
			`- Новые регистрации: ${stats.newUsersCount}`,
			`- Без email: ${stats.usersWithoutEmailCount}`,
			`- Без телефона: ${stats.usersWithoutPhoneCount}`,
			`- Без email и телефона: ${stats.usersWithoutContactsCount}`,
			'',
			'<b>Платежи</b>',
			`- Успешные оплаты: ${stats.succeededPaymentsCount}`,
			`- Сумма успешных оплат: ${this.formatMoney(stats.succeededPaymentsAmount)}`,
			`- Pending за период: ${stats.pendingPaymentsCount}`,
			`- Pending сейчас: ${stats.currentPendingPaymentsCount}`,
			`- Отменённые за период: ${stats.cancelledPaymentsCount}`,
			'',
			'<b>Лиды</b>',
			`- Всего: ${stats.leads.total}`,
			`- Колесо: ${stats.leads.wheel}`,
			`- Квизы: ${stats.leads.quiz}`,
			`- Обратный звонок: ${stats.leads.callback}`,
			`- Таймеры: ${stats.leads.countdownTimer}`,
			'',
			'<b>Подписки</b>',
			`- Истекают в ближайшие 7 дней: ${stats.expiringSubscriptionsCount}`,
			`- Истекли, но ещё ACTIVE: ${stats.expiredActiveSubscriptionsCount}`
		].join('\n');
	}

	private async sendTelegramMessage(
		token: string,
		chatId: string,
		text: string
	) {
		const response = await fetch(
			`https://api.telegram.org/bot${token}/sendMessage`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chat_id: chatId,
					text,
					parse_mode: 'HTML',
					disable_web_page_preview: true
				})
			}
		);

		const data = (await response.json().catch(() => null)) as {
			ok?: boolean;
			description?: string;
		} | null;

		if (!response.ok || !data?.ok) {
			throw new Error(
				`Telegram sendMessage failed: ${data?.description ?? `HTTP ${response.status}`}`
			);
		}
	}

	private getPaymentsAmount(payments: Array<{ amount: string }>) {
		return payments.reduce(
			(total, payment) => total + this.parsePaymentAmount(payment.amount),
			0
		);
	}

	private parsePaymentAmount(value: string) {
		const amount = Number(value.replace(',', '.'));
		return Number.isFinite(amount) ? amount : 0;
	}

	private formatMoney(value: number) {
		return new Intl.NumberFormat('ru-RU', {
			style: 'currency',
			currency: 'RUB',
			maximumFractionDigits: 2
		}).format(value);
	}

	private getPreviousMoscowDayPeriod(): DailySummaryPeriod {
		const offsetMs = this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000;
		const shiftedNow = new Date(Date.now() + offsetMs);
		const shiftedTodayStart = new Date(shiftedNow);
		shiftedTodayStart.setUTCHours(0, 0, 0, 0);

		const shiftedPeriodStart = new Date(shiftedTodayStart);
		shiftedPeriodStart.setUTCDate(shiftedPeriodStart.getUTCDate() - 1);

		const start = new Date(shiftedPeriodStart.getTime() - offsetMs);
		const end = new Date(shiftedTodayStart.getTime() - offsetMs);
		const labelEnd = new Date(end.getTime() - 60 * 1000);

		return {
			start,
			end,
			label: `${this.formatMoscowDateTime(start)} - ${this.formatMoscowDateTime(labelEnd)} МСК`
		};
	}

	private formatMoscowDateTime(date: Date) {
		return date.toLocaleString('ru-RU', {
			timeZone: 'Europe/Moscow',
			day: '2-digit',
			month: '2-digit',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	private getNextDailySummaryDate() {
		const offsetMs = this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000;
		const shiftedNow = new Date(Date.now() + offsetMs);
		const shiftedNextRun = new Date(shiftedNow);

		shiftedNextRun.setUTCHours(
			this.DAILY_SUMMARY_HOUR_MOSCOW,
			this.DAILY_SUMMARY_MINUTE_MOSCOW,
			0,
			0
		);

		if (shiftedNextRun.getTime() <= shiftedNow.getTime()) {
			shiftedNextRun.setUTCDate(shiftedNextRun.getUTCDate() + 1);
		}

		return new Date(shiftedNextRun.getTime() - offsetMs);
	}

	private shouldRunStartupDailySummary() {
		const offsetMs = this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000;
		const shiftedNow = new Date(Date.now() + offsetMs);
		const shiftedRun = new Date(shiftedNow);

		shiftedRun.setUTCHours(
			this.DAILY_SUMMARY_HOUR_MOSCOW,
			this.DAILY_SUMMARY_MINUTE_MOSCOW,
			0,
			0
		);

		return shiftedNow.getTime() >= shiftedRun.getTime();
	}
}
