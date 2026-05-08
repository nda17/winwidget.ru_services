import { EmailService } from '@/email/email.service';
import { PrismaService } from '@/prisma.service';
import { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import {
	Injectable,
	Logger,
	OnModuleDestroy,
	OnModuleInit
} from '@nestjs/common';
import {
	AuthIdentityType,
	Plan,
	Prisma,
	SubscriptionStatus,
	UserStatus
} from '@prisma/client';

interface SubscriptionExpiryReminderResult {
	sentCount: number;
	failedCount: number;
}

type SubscriptionExpiryReminderChannel = 'email' | 'telegram';

interface SubscriptionExpiryReminderRecipient {
	channel: SubscriptionExpiryReminderChannel;
	value: string;
	sentTo: string;
}

interface SubscriptionExpiryReminderUser {
	authIdentities: Array<{
		type: AuthIdentityType;
		value: string;
	}>;
	telegramNotificationChannel: {
		chatId: string;
		isActive: boolean;
	} | null;
}

@Injectable()
export class SubscriptionExpiryService
	implements OnModuleInit, OnModuleDestroy
{
	private readonly RUN_HOURS_MOSCOW = [3, 15]; // 03:00 и 15:00 МСК
	private readonly REMINDER_DAYS_BEFORE_EXPIRY = [6, 3, 0] as const;
	private readonly MOSCOW_UTC_OFFSET_HOURS = 3;
	private readonly logger = new Logger(SubscriptionExpiryService.name);
	private expiryTimeout: NodeJS.Timeout | null = null;

	constructor(
		private prisma: PrismaService,
		private readonly emailService: EmailService,
		private readonly telegramBotService: TelegramBotService
	) {}

	async onModuleInit() {
		const result = await this.runSubscriptionMaintenance();
		this.logger.log(
			`Startup check: deactivated ${result.expiredCount} expired subscription(s), sent ${result.reminders.sentCount} expiry reminder(s), failed ${result.reminders.failedCount}.`
		);
		this.scheduleNext();
	}

	onModuleDestroy() {
		if (this.expiryTimeout) {
			clearTimeout(this.expiryTimeout);
			this.expiryTimeout = null;
		}
	}

	async runManualCheck(): Promise<number> {
		const expired = await this.expireSubscriptions();
		this.logger.log(
			`Manual check complete: deactivated ${expired} expired subscription(s).`
		);

		return expired;
	}

	private async runSubscriptionMaintenance() {
		const expiredCount = await this.expireSubscriptions();
		const reminders = await this.sendExpiryReminders();

		return {
			expiredCount,
			reminders
		};
	}

	private async expireSubscriptions(): Promise<number> {
		const result = await this.prisma.subscription.updateMany({
			where: {
				status: SubscriptionStatus.ACTIVE,
				expiresAt: { lt: new Date() }
			},
			data: { status: SubscriptionStatus.EXPIRED }
		});
		return result.count;
	}

	private async sendExpiryReminders(): Promise<SubscriptionExpiryReminderResult> {
		let sentCount = 0;
		let failedCount = 0;

		for (const daysBeforeExpiry of this.REMINDER_DAYS_BEFORE_EXPIRY) {
			const subscriptions =
				await this.findSubscriptionsForReminder(daysBeforeExpiry);
			const sentReminderKeys = await this.getSentReminderKeys(
				subscriptions,
				daysBeforeExpiry
			);

			for (const subscription of subscriptions) {
				if (!subscription.expiresAt) continue;

				const recipients = this.getReminderRecipients(subscription.user);
				if (!recipients.length) continue;

				const reminderPayload = {
					daysBeforeExpiry,
					planLabel: this.getPlanLabel(subscription.plan),
					expiresAtLabel: this.formatMoscowDateTime(subscription.expiresAt)
				};

				for (const recipient of recipients) {
					const reminderKey = this.getReminderKey(
						subscription.id,
						subscription.expiresAt,
						recipient.sentTo
					);
					if (sentReminderKeys.has(reminderKey)) continue;

					try {
						await this.sendReminder(recipient, reminderPayload);

						await this.prisma.subscriptionExpiryReminder.create({
							data: {
								subscriptionId: subscription.id,
								userId: subscription.userId,
								daysBeforeExpiry,
								expiresAt: subscription.expiresAt,
								sentTo: recipient.sentTo
							}
						});

						sentReminderKeys.add(reminderKey);
						sentCount += 1;
					} catch (error) {
						if (this.isUniqueConstraintError(error)) {
							sentReminderKeys.add(reminderKey);
							continue;
						}

						if (
							recipient.channel === 'telegram' &&
							this.telegramBotService.isRecipientUnavailableError(error)
						) {
							await this.telegramBotService.deactivateNotificationChannelByChatId(
								recipient.value
							);
						}

						failedCount += 1;
						this.logger.warn(
							`Subscription expiry ${recipient.channel} reminder failed for user ${subscription.userId}: ${
								error instanceof Error ? error.message : String(error)
							}`
						);
					}
				}
			}
		}

		return {
			sentCount,
			failedCount
		};
	}

	private async findSubscriptionsForReminder(daysBeforeExpiry: number) {
		const { start, end } = this.getMoscowDayRange(daysBeforeExpiry);

		return this.prisma.subscription.findMany({
			where: {
				status: SubscriptionStatus.ACTIVE,
				expiresAt: {
					gte: start,
					lt: end
				},
				user: {
					status: UserStatus.ACTIVE,
					OR: [
						{
							authIdentities: {
								some: {
									type: AuthIdentityType.EMAIL,
									value: {
										not: ''
									}
								}
							}
						},
						{
							telegramNotificationChannel: {
								is: {
									isActive: true,
									chatId: {
										not: ''
									}
								}
							}
						}
					]
				}
			},
			select: {
				id: true,
				userId: true,
				plan: true,
				expiresAt: true,
				user: {
					select: {
						authIdentities: {
							where: {
								type: AuthIdentityType.EMAIL,
								value: {
									not: ''
								}
							},
							select: {
								type: true,
								value: true
							},
							orderBy: {
								createdAt: 'asc'
							}
						},
						telegramNotificationChannel: {
							select: {
								chatId: true,
								isActive: true
							}
						}
					}
				}
			},
			orderBy: {
				expiresAt: 'asc'
			}
		});
	}

	private async getSentReminderKeys(
		subscriptions: Awaited<
			ReturnType<SubscriptionExpiryService['findSubscriptionsForReminder']>
		>,
		daysBeforeExpiry: number
	) {
		const subscriptionIds = subscriptions.map(
			subscription => subscription.id
		);

		if (!subscriptionIds.length) {
			return new Set<string>();
		}

		const reminders =
			await this.prisma.subscriptionExpiryReminder.findMany({
				where: {
					subscriptionId: {
						in: subscriptionIds
					},
					daysBeforeExpiry
				},
				select: {
					subscriptionId: true,
					expiresAt: true,
					sentTo: true
				}
			});

		return new Set(
			reminders.map(reminder =>
				this.getReminderKey(
					reminder.subscriptionId,
					reminder.expiresAt,
					reminder.sentTo
				)
			)
		);
	}

	private getMoscowDayRange(daysFromToday: number) {
		const offsetMs = this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000;
		const nowMsk = new Date(Date.now() + offsetMs);
		const startMsk = new Date(nowMsk);
		startMsk.setUTCHours(0, 0, 0, 0);
		startMsk.setUTCDate(startMsk.getUTCDate() + daysFromToday);

		const endMsk = new Date(startMsk);
		endMsk.setUTCDate(endMsk.getUTCDate() + 1);

		return {
			start: new Date(startMsk.getTime() - offsetMs),
			end: new Date(endMsk.getTime() - offsetMs)
		};
	}

	private getReminderRecipients(user: SubscriptionExpiryReminderUser) {
		const recipients: SubscriptionExpiryReminderRecipient[] = [];
		const email = this.getPrimaryEmail(user.authIdentities);
		const telegramChatId = this.getPrimaryTelegramChatId(
			user.telegramNotificationChannel
		);

		if (email) {
			recipients.push({
				channel: 'email',
				value: email,
				sentTo: email
			});
		}

		if (telegramChatId) {
			recipients.push({
				channel: 'telegram',
				value: telegramChatId,
				sentTo: `telegram:${telegramChatId}`
			});
		}

		return recipients;
	}

	private getPrimaryEmail(
		identities: Array<{
			type: AuthIdentityType;
			value: string;
		}>
	) {
		return (
			identities
				.find(identity => identity.type === AuthIdentityType.EMAIL)
				?.value.trim()
				.toLowerCase() || null
		);
	}

	private getPrimaryTelegramChatId(
		channel: SubscriptionExpiryReminderUser['telegramNotificationChannel']
	) {
		if (!channel?.isActive) return null;
		return channel.chatId.trim() || null;
	}

	private async sendReminder(
		recipient: SubscriptionExpiryReminderRecipient,
		payload: {
			daysBeforeExpiry: number;
			planLabel: string;
			expiresAtLabel: string;
		}
	) {
		if (recipient.channel === 'email') {
			await this.emailService.sendSubscriptionExpiryReminder(
				recipient.value,
				payload
			);
			return;
		}

		await this.telegramBotService.sendInfoBotMessage(
			recipient.value,
			this.buildTelegramExpiryReminderMessage(payload)
		);
	}

	private getPlanLabel(plan: Plan) {
		switch (plan) {
			case Plan.TRIAL:
				return 'Тест-драйв';
			case Plan.EASY:
				return 'Easy';
			case Plan.HARD:
				return 'Hard';
			default:
				return plan;
		}
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

	private buildTelegramExpiryReminderMessage(payload: {
		daysBeforeExpiry: number;
		planLabel: string;
		expiresAtLabel: string;
	}) {
		const statusText =
			payload.daysBeforeExpiry === 0
				? 'Сегодня последний день подписки.'
				: `До окончания подписки осталось ${payload.daysBeforeExpiry} ${this.getDayWord(payload.daysBeforeExpiry)}.`;

		return [
			'<b>Подписка winwidget.ru</b>',
			`Тариф: ${payload.planLabel}`,
			`Дата окончания: ${payload.expiresAtLabel} МСК`,
			'',
			statusText,
			'',
			'Продлить доступ можно в личном кабинете.'
		].join('\n');
	}

	private getDayWord(value: number) {
		const mod10 = value % 10;
		const mod100 = value % 100;

		if (mod10 === 1 && mod100 !== 11) return 'день';
		if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) {
			return 'дня';
		}

		return 'дней';
	}

	private getReminderKey(
		subscriptionId: string,
		expiresAt: Date,
		sentTo: string
	) {
		return `${subscriptionId}:${expiresAt.getTime()}:${sentTo}`;
	}

	private isUniqueConstraintError(error: unknown) {
		return (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === 'P2002'
		);
	}

	private scheduleNext() {
		const nextRun = this.getNextRunDate();
		const delay = Math.max(nextRun.getTime() - Date.now(), 1_000);

		const mskTime = new Date(
			nextRun.getTime() + this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000
		);
		this.logger.log(
			`Next subscription expiry check scheduled for ${mskTime.toISOString().replace('T', ' ').slice(0, 16)} MSK.`
		);

		this.expiryTimeout = setTimeout(async () => {
			try {
				const result = await this.runSubscriptionMaintenance();
				this.logger.log(
					`Scheduled check complete: deactivated ${result.expiredCount} expired subscription(s), sent ${result.reminders.sentCount} expiry reminder(s), failed ${result.reminders.failedCount}.`
				);
			} catch (err) {
				this.logger.error('Subscription expiry check failed:', err);
			} finally {
				this.scheduleNext();
			}
		}, delay);

		this.expiryTimeout.unref?.();
	}

	/** Возвращает ближайший из слотов 03:00 / 15:00 МСК в UTC */
	private getNextRunDate(): Date {
		const offsetMs = this.MOSCOW_UTC_OFFSET_HOURS * 60 * 60 * 1000;
		const nowMsk = new Date(Date.now() + offsetMs);

		const candidates: Date[] = [];

		for (const hour of this.RUN_HOURS_MOSCOW) {
			// Сегодня в <hour>:00 МСК
			const candidate = new Date(nowMsk);
			candidate.setUTCHours(hour, 0, 0, 0);
			if (candidate.getTime() > nowMsk.getTime()) {
				candidates.push(new Date(candidate.getTime() - offsetMs));
			}
			// Завтра в <hour>:00 МСК
			const tomorrow = new Date(candidate);
			tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
			candidates.push(new Date(tomorrow.getTime() - offsetMs));
		}

		return candidates.reduce((min, d) => (d < min ? d : min));
	}
}
