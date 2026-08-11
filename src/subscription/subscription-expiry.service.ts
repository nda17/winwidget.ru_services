import { BillingCoreStateService } from '@/billing-boundary/billing-core-state.service';
import {
	MESSAGING_ROUTING_KEYS,
	SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE,
	SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE
} from '@/messaging/messaging.constants';
import { createMessagingHeaders } from '@/messaging/messaging-context';
import {
	serializeNotificationDeliveryEvent,
	SubscriptionExpiryEmailNotificationRequestedEventPayload,
	SubscriptionExpiryTelegramNotificationRequestedEventPayload
} from '@/messaging/notification-delivery-event';
import { PrismaService } from '@/prisma.service';
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
	dispatchedCount: number;
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
	private readonly REMINDER_BATCH_SIZE = 500;
	private readonly logger = new Logger(SubscriptionExpiryService.name);
	private readonly workerId = `subscription-expiry:${hostname()}:${process.pid}:${randomUUID()}`;
	private expiryTimeout: NodeJS.Timeout | null = null;
	private destroyed = false;

	constructor(
		private prisma: PrismaService,
		private readonly billingState: BillingCoreStateService
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
		await this.billingState.assertSchedulerEnabled();
		const expired = await this.expireSubscriptions();
		this.logger.log(
			`Manual check complete: deactivated ${expired} expired subscription(s).`
		);

		return expired;
	}

	private async runSubscriptionMaintenance() {
		if (!(await this.billingState.isSchedulerEnabled())) {
			return {
				expiredCount: 0,
				reminders: { dispatchedCount: 0, failedCount: 0 }
			};
		}
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
				`Startup check: deactivated ${result.expiredCount} expired subscription(s), queued ${result.reminders.dispatchedCount} expiry reminder(s), failed ${result.reminders.failedCount}.`
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

		let dispatchedCount = 0;
		let failedCount = 0;
		const reminders = await this.findClaimableReminders();

		for (const reminder of reminders) {
			const state = await this.dispatchReminder(reminder.id);
			if (state === 'dispatched') dispatchedCount += 1;
			if (state === 'failed') failedCount += 1;
		}

		return {
			dispatchedCount,
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

		return this.prisma.subscriptionExpiryReminder.findMany({
			where: {
				status: SubscriptionExpiryReminderStatus.PENDING,
				availableAt: { lte: now }
			},
			select: EXPIRY_REMINDER_SELECT,
			orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
			take: this.REMINDER_BATCH_SIZE
		});
	}

	private async dispatchReminder(
		reminderId: string
	): Promise<'dispatched' | 'failed' | 'skipped'> {
		const now = new Date();
		const eventId = randomUUID();

		return this.prisma.$transaction(async transaction => {
			const claimed =
				await transaction.subscriptionExpiryReminder.updateMany({
					where: {
						id: reminderId,
						status: SubscriptionExpiryReminderStatus.PENDING,
						availableAt: { lte: now }
					},
					data: {
						status: SubscriptionExpiryReminderStatus.PROCESSING,
						lockedAt: now,
						lockedBy: this.workerId,
						attempts: { increment: 1 }
					}
				});
			if (claimed.count !== 1) return 'skipped';

			const reminder =
				await transaction.subscriptionExpiryReminder.findFirst({
					where: {
						id: reminderId,
						status: SubscriptionExpiryReminderStatus.PROCESSING,
						lockedBy: this.workerId,
						lockedAt: now
					},
					select: EXPIRY_REMINDER_SELECT
				});
			if (!reminder) {
				throw new Error(
					`Claimed subscription expiry reminder disappeared: ${reminderId}`
				);
			}

			const recipient = this.getStoredReminderRecipient(reminder.sentTo);
			const invalidReason = this.getInvalidReminderReason(
				reminder,
				recipient
			);
			if (invalidReason) {
				await transaction.subscriptionExpiryReminder.update({
					where: { id: reminder.id },
					data: {
						status: SubscriptionExpiryReminderStatus.FAILED,
						lockedAt: null,
						lockedBy: null,
						lastError: invalidReason.slice(0, 1000)
					}
				});
				return 'failed';
			}

			const content = {
				daysBeforeExpiry: reminder.daysBeforeExpiry,
				planLabel: this.getPlanLabel(reminder.subscription.plan),
				expiresAtLabel: this.formatMoscowDateTime(reminder.expiresAt)
			};
			const notificationKind =
				recipient.channel === 'email'
					? ('subscription-expiry-email' as const)
					: ('subscription-expiry-telegram' as const);
			const payload:
				| SubscriptionExpiryEmailNotificationRequestedEventPayload
				| SubscriptionExpiryTelegramNotificationRequestedEventPayload =
				recipient.channel === 'email'
					? {
							schemaVersion: 1,
							eventType: SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE,
							reference: {
								type: 'subscription-expiry-reminder',
								id: reminder.id
							},
							destination: { email: recipient.value },
							content
						}
					: {
							schemaVersion: 1,
							eventType:
								SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE,
							reference: {
								type: 'subscription-expiry-reminder',
								id: reminder.id
							},
							destination: {
								telegramChatId: recipient.value
							},
							content
						};

			await transaction.outboxEvent.create({
				data: {
					messageId: eventId,
					deduplicationKey: `notification-dispatch:subscription-expiry:${reminder.id}:v1`,
					eventType: payload.eventType,
					routingKey: MESSAGING_ROUTING_KEYS[notificationKind],
					payload: serializeNotificationDeliveryEvent(payload),
					headers: createMessagingHeaders({
						messageId: eventId
					})
				}
			});
			const released =
				await transaction.subscriptionExpiryReminder.updateMany({
					where: {
						id: reminder.id,
						status: SubscriptionExpiryReminderStatus.PROCESSING,
						lockedBy: this.workerId,
						lockedAt: now
					},
					data: {
						lockedAt: null,
						lockedBy: null,
						lastError: null
					}
				});
			if (released.count !== 1) {
				throw new Error(
					`Lost subscription expiry reminder before dispatch: ${reminder.id}`
				);
			}
			return 'dispatched';
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

	private async scheduleNext(): Promise<void> {
		if (this.destroyed) return;

		let nextRun = this.getNextRunDate();
		try {
			const pending =
				await this.prisma.subscriptionExpiryReminder.aggregate({
					where: {
						status: SubscriptionExpiryReminderStatus.PENDING
					},
					_min: {
						availableAt: true
					}
				});
			if (pending._min.availableAt && pending._min.availableAt < nextRun) {
				nextRun = pending._min.availableAt;
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
					`Scheduled check complete: deactivated ${result.expiredCount} expired subscription(s), queued ${result.reminders.dispatchedCount} expiry reminder(s), failed ${result.reminders.failedCount}.`
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
