import { EmailService } from '@/email/email.service';
import { classifyIntegrationError } from '@/messaging/integration-error-classifier';
import { PrismaService } from '@/prisma.service';
import { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import { TelegramInfoTransportService } from '@/telegram-bot/telegram-info-transport.service';
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
	SubscriptionExpiryReminderStatus,
	SubscriptionStatus,
	UserStatus
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

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

const EXPIRY_REMINDER_SELECT = {
	id: true,
	subscriptionId: true,
	userId: true,
	daysBeforeExpiry: true,
	expiresAt: true,
	sentTo: true,
	attempts: true,
	subscription: {
		select: {
			plan: true,
			status: true,
			expiresAt: true
		}
	},
	user: {
		select: {
			status: true,
			authIdentities: {
				where: {
					type: AuthIdentityType.EMAIL,
					value: { not: '' }
				},
				select: {
					type: true,
					value: true
				},
				orderBy: {
					createdAt: 'asc' as const
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
} satisfies Prisma.SubscriptionExpiryReminderSelect;

type ExpiryReminderCandidate =
	Prisma.SubscriptionExpiryReminderGetPayload<{
		select: typeof EXPIRY_REMINDER_SELECT;
	}>;

@Injectable()
export class SubscriptionExpiryService
	implements OnModuleInit, OnModuleDestroy
{
	private readonly RUN_HOURS_MOSCOW = [3, 15]; // 03:00 и 15:00 МСК
	private readonly REMINDER_DAYS_BEFORE_EXPIRY = [6, 3, 0] as const;
	private readonly MOSCOW_UTC_OFFSET_HOURS = 3;
	private readonly REMINDER_LEASE_MS = 5 * 60 * 1000;
	private readonly REMINDER_BATCH_SIZE = 500;
	private readonly MAX_RECOGNIZED_ATTEMPTS = 4;
	private readonly MAX_UNCLASSIFIED_ATTEMPTS = 2;
	private readonly logger = new Logger(SubscriptionExpiryService.name);
	private readonly workerId = `subscription-expiry:${hostname()}:${process.pid}:${randomUUID()}`;
	private expiryTimeout: NodeJS.Timeout | null = null;
	private destroyed = false;

	constructor(
		private prisma: PrismaService,
		private readonly emailService: EmailService,
		private readonly telegramBotService: TelegramBotService,
		private readonly telegramInfoTransport: TelegramInfoTransportService
	) {}

	onModuleInit(): void {
		this.expiryTimeout = setTimeout(() => {
			this.expiryTimeout = null;
			void this.runStartupMaintenance();
		}, 0);
		this.expiryTimeout.unref?.();
	}

	onModuleDestroy() {
		this.destroyed = true;
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

	private async runStartupMaintenance(): Promise<void> {
		if (this.destroyed) return;
		try {
			const result = await this.runSubscriptionMaintenance();
			this.logger.log(
				`Startup check: deactivated ${result.expiredCount} expired subscription(s), sent ${result.reminders.sentCount} expiry reminder(s), failed ${result.reminders.failedCount}.`
			);
		} catch (error) {
			this.logger.error(
				`Startup subscription expiry check failed: ${
					error instanceof Error ? error.stack : String(error)
				}`
			);
		} finally {
			await this.scheduleNext();
		}
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
		await this.seedExpiryReminders();

		let sentCount = 0;
		let failedCount = 0;
		const reminders = await this.findClaimableReminders();

		for (const reminder of reminders) {
			const claimedReminder = await this.claimReminder(reminder.id);
			if (!claimedReminder) continue;

			const recipient = this.getStoredReminderRecipient(
				claimedReminder.sentTo
			);
			const invalidReason = this.getInvalidReminderReason(
				claimedReminder,
				recipient
			);
			if (invalidReason) {
				await this.markReminderFailed(claimedReminder.id, invalidReason);
				failedCount += 1;
				continue;
			}

			const payload = {
				daysBeforeExpiry: claimedReminder.daysBeforeExpiry,
				planLabel: this.getPlanLabel(claimedReminder.subscription.plan),
				expiresAtLabel: this.formatMoscowDateTime(
					claimedReminder.expiresAt
				)
			};

			try {
				await this.sendReminder(recipient, payload, claimedReminder.id);
			} catch (error) {
				await this.handleReminderDeliveryFailure(
					claimedReminder.id,
					claimedReminder.userId,
					recipient,
					claimedReminder.attempts,
					error
				);
				failedCount += 1;
				continue;
			}

			await this.markReminderSent(claimedReminder.id);
			sentCount += 1;
		}

		return {
			sentCount,
			failedCount
		};
	}

	private async seedExpiryReminders(): Promise<void> {
		const reminders: Prisma.SubscriptionExpiryReminderCreateManyInput[] =
			[];

		for (const daysBeforeExpiry of this.REMINDER_DAYS_BEFORE_EXPIRY) {
			const subscriptions =
				await this.findSubscriptionsForReminder(daysBeforeExpiry);

			for (const subscription of subscriptions) {
				if (!subscription.expiresAt) continue;

				for (const recipient of this.getReminderRecipients(
					subscription.user
				)) {
					reminders.push({
						subscriptionId: subscription.id,
						userId: subscription.userId,
						daysBeforeExpiry,
						expiresAt: subscription.expiresAt,
						sentTo: recipient.sentTo,
						status: SubscriptionExpiryReminderStatus.PENDING
					});
				}
			}
		}

		if (!reminders.length) return;

		await this.prisma.subscriptionExpiryReminder.createMany({
			data: reminders,
			skipDuplicates: true
		});
	}

	private async findClaimableReminders() {
		const now = new Date();
		const staleBefore = new Date(now.getTime() - this.REMINDER_LEASE_MS);

		return this.prisma.subscriptionExpiryReminder.findMany({
			where: {
				OR: [
					{
						status: SubscriptionExpiryReminderStatus.PENDING,
						availableAt: { lte: now }
					},
					{
						status: SubscriptionExpiryReminderStatus.PROCESSING,
						OR: [
							{ lockedAt: null },
							{
								lockedAt: { lte: staleBefore }
							}
						]
					}
				]
			},
			select: EXPIRY_REMINDER_SELECT,
			orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
			take: this.REMINDER_BATCH_SIZE
		});
	}

	private async claimReminder(
		reminderId: string
	): Promise<ExpiryReminderCandidate | null> {
		const now = new Date();
		const staleBefore = new Date(now.getTime() - this.REMINDER_LEASE_MS);
		const result = await this.prisma.subscriptionExpiryReminder.updateMany(
			{
				where: {
					id: reminderId,
					OR: [
						{
							status: SubscriptionExpiryReminderStatus.PENDING,
							availableAt: { lte: now }
						},
						{
							status: SubscriptionExpiryReminderStatus.PROCESSING,
							OR: [
								{ lockedAt: null },
								{
									lockedAt: { lte: staleBefore }
								}
							]
						}
					]
				},
				data: {
					status: SubscriptionExpiryReminderStatus.PROCESSING,
					lockedAt: now,
					lockedBy: this.workerId,
					attempts: { increment: 1 }
				}
			}
		);

		if (result.count !== 1) return null;

		return this.prisma.subscriptionExpiryReminder.findFirst({
			where: {
				id: reminderId,
				status: SubscriptionExpiryReminderStatus.PROCESSING,
				lockedBy: this.workerId,
				lockedAt: now
			},
			select: EXPIRY_REMINDER_SELECT
		});
	}

	private getStoredReminderRecipient(
		sentTo: string
	): SubscriptionExpiryReminderRecipient {
		const telegramPrefix = 'telegram:';
		if (sentTo.startsWith(telegramPrefix)) {
			const chatId = sentTo.slice(telegramPrefix.length);
			return {
				channel: 'telegram',
				value: chatId,
				sentTo
			};
		}

		return {
			channel: 'email',
			value: sentTo,
			sentTo
		};
	}

	private getInvalidReminderReason(
		reminder: ExpiryReminderCandidate,
		recipient: SubscriptionExpiryReminderRecipient
	): string | null {
		if (reminder.user.status !== UserStatus.ACTIVE) {
			return 'USER_INACTIVE: Reminder recipient is no longer active';
		}
		if (
			reminder.subscription.status !== SubscriptionStatus.ACTIVE ||
			!reminder.subscription.expiresAt ||
			reminder.subscription.expiresAt.getTime() !==
				reminder.expiresAt.getTime()
		) {
			return 'SUBSCRIPTION_CHANGED: Reminder no longer matches the active subscription';
		}

		if (recipient.channel === 'telegram') {
			if (
				!recipient.value ||
				this.getPrimaryTelegramChatId(
					reminder.user.telegramNotificationChannel
				) !== recipient.value
			) {
				return 'DESTINATION_CHANGED: Telegram reminder destination is no longer active';
			}
			return null;
		}

		if (
			!recipient.value ||
			this.getPrimaryEmail(reminder.user.authIdentities) !==
				recipient.value.toLowerCase()
		) {
			return 'DESTINATION_CHANGED: Email reminder destination is no longer active';
		}

		return null;
	}

	private async markReminderSent(reminderId: string): Promise<void> {
		const result = await this.prisma.subscriptionExpiryReminder.updateMany(
			{
				where: {
					id: reminderId,
					status: SubscriptionExpiryReminderStatus.PROCESSING,
					lockedBy: this.workerId
				},
				data: {
					status: SubscriptionExpiryReminderStatus.SENT,
					sentAt: new Date(),
					lockedAt: null,
					lockedBy: null,
					lastError: null
				}
			}
		);

		if (result.count !== 1) {
			throw new Error(
				`Lost subscription expiry reminder lease after delivery: ${reminderId}`
			);
		}
	}

	private async markReminderFailed(
		reminderId: string,
		reason: string
	): Promise<void> {
		await this.updateClaimedReminder(reminderId, {
			status: SubscriptionExpiryReminderStatus.FAILED,
			lockedAt: null,
			lockedBy: null,
			lastError: reason.slice(0, 1000)
		});
	}

	private async handleReminderDeliveryFailure(
		reminderId: string,
		userId: string,
		recipient: SubscriptionExpiryReminderRecipient,
		attempt: number,
		error: unknown
	): Promise<void> {
		const kind =
			recipient.channel === 'email' ? 'mailing-email' : 'mailing-telegram';
		const classification = classifyIntegrationError(kind, error);
		const maxAttempts = classification.recognized
			? this.MAX_RECOGNIZED_ATTEMPTS
			: this.MAX_UNCLASSIFIED_ATTEMPTS;
		const shouldRetry = classification.retryable && attempt < maxAttempts;
		const safeError =
			`${classification.normalizedCode}: ${classification.safeReason}`.slice(
				0,
				1000
			);

		if (
			recipient.channel === 'telegram' &&
			classification.mayDisableDestination
		) {
			try {
				await this.telegramBotService.deactivateNotificationChannelByChatId(
					recipient.value
				);
			} catch (deactivationError) {
				this.logger.error(
					`Failed to deactivate unavailable Telegram reminder destination for user ${userId}: ${
						deactivationError instanceof Error
							? deactivationError.message
							: String(deactivationError)
					}`
				);
			}
		}

		await this.updateClaimedReminder(reminderId, {
			status: shouldRetry
				? SubscriptionExpiryReminderStatus.PENDING
				: SubscriptionExpiryReminderStatus.FAILED,
			availableAt: shouldRetry
				? new Date(
						Date.now() +
							this.getReminderRetryDelayMs(
								classification.retryDelayMs,
								attempt
							)
					)
				: new Date(),
			lockedAt: null,
			lockedBy: null,
			lastError: safeError
		});

		this.logger.warn(
			`Subscription expiry ${recipient.channel} reminder failed for user ${userId}; code=${classification.normalizedCode} attempt=${attempt}/${maxAttempts} retry=${shouldRetry}`
		);
	}

	private async updateClaimedReminder(
		reminderId: string,
		data: Prisma.SubscriptionExpiryReminderUpdateManyMutationInput
	): Promise<void> {
		const result = await this.prisma.subscriptionExpiryReminder.updateMany(
			{
				where: {
					id: reminderId,
					status: SubscriptionExpiryReminderStatus.PROCESSING,
					lockedBy: this.workerId
				},
				data
			}
		);

		if (result.count !== 1) {
			throw new Error(
				`Lost subscription expiry reminder lease: ${reminderId}`
			);
		}
	}

	private getReminderRetryDelayMs(
		providerDelayMs: number | null,
		attempt: number
	): number {
		const baseDelay = Math.max(providerDelayMs || 30_000, 1_000);
		return Math.min(
			baseDelay * 2 ** Math.max(attempt - 1, 0),
			24 * 60 * 60 * 1000
		);
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
		},
		reminderId: string
	) {
		if (recipient.channel === 'email') {
			await this.emailService.sendSubscriptionExpiryReminder(
				recipient.value,
				payload,
				{
					messageId: `<${reminderId}.subscription-expiry@winwidget.ru>`
				}
			);
			return;
		}

		await this.telegramInfoTransport.sendMessage(
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

	private async scheduleNext(): Promise<void> {
		if (this.destroyed) return;

		let nextRun = this.getNextRunDate();
		try {
			const [pending, processing] = await Promise.all([
				this.prisma.subscriptionExpiryReminder.aggregate({
					where: {
						status: SubscriptionExpiryReminderStatus.PENDING
					},
					_min: {
						availableAt: true
					}
				}),
				this.prisma.subscriptionExpiryReminder.aggregate({
					where: {
						status: SubscriptionExpiryReminderStatus.PROCESSING
					},
					_min: {
						lockedAt: true
					}
				})
			]);
			const candidates = [
				pending._min.availableAt,
				processing._min.lockedAt
					? new Date(
							processing._min.lockedAt.getTime() + this.REMINDER_LEASE_MS
						)
					: null
			].filter((value): value is Date => Boolean(value));
			for (const candidate of candidates) {
				if (candidate < nextRun) nextRun = candidate;
			}
		} catch (error) {
			this.logger.warn(
				`Failed to inspect pending subscription expiry reminders: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}

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
				await this.scheduleNext();
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
