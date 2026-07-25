import { EmailService } from '@/email/email.service';
import { PrismaService } from '@/prisma.service';
import { SubscriptionExpiryService } from '@/subscription/subscription-expiry.service';
import { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import {
	TelegramApiError,
	TelegramInfoTransportService
} from '@/telegram-bot/telegram-info-transport.service';
import {
	AuthIdentityType,
	Plan,
	SubscriptionExpiryReminderStatus,
	SubscriptionStatus,
	UserStatus
} from '@prisma/client';

const NOW = new Date('2026-07-25T09:00:00.000Z');
const EXPIRES_AT = new Date('2026-07-28T09:00:00.000Z');

const createReminder = (overrides: Record<string, any> = {}) => {
	const reminder = {
		id: 'reminder-1',
		subscriptionId: 'subscription-1',
		userId: 'user-1',
		daysBeforeExpiry: 3,
		expiresAt: EXPIRES_AT,
		sentTo: 'owner@example.com',
		attempts: 0,
		subscription: {
			plan: Plan.EASY,
			status: SubscriptionStatus.ACTIVE,
			expiresAt: EXPIRES_AT
		},
		user: {
			status: UserStatus.ACTIVE,
			authIdentities: [
				{
					type: AuthIdentityType.EMAIL,
					value: 'owner@example.com'
				}
			],
			telegramNotificationChannel: null
		}
	};

	return {
		...reminder,
		...overrides,
		subscription: {
			...reminder.subscription,
			...overrides.subscription
		},
		user: {
			...reminder.user,
			...overrides.user
		}
	};
};

describe('SubscriptionExpiryService durable delivery', () => {
	let prisma: {
		subscription: {
			findMany: jest.Mock;
			updateMany: jest.Mock;
		};
		subscriptionExpiryReminder: {
			createMany: jest.Mock;
			findMany: jest.Mock;
			findFirst: jest.Mock;
			updateMany: jest.Mock;
			aggregate: jest.Mock;
		};
	};
	let emailService: {
		sendSubscriptionExpiryReminder: jest.Mock;
	};
	let telegramBotService: {
		deactivateNotificationChannelByChatId: jest.Mock;
	};
	let telegramInfoTransport: {
		sendMessage: jest.Mock;
	};
	let service: SubscriptionExpiryService;

	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(NOW);

		prisma = {
			subscription: {
				findMany: jest.fn().mockResolvedValue([]),
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			subscriptionExpiryReminder: {
				createMany: jest.fn().mockResolvedValue({ count: 0 }),
				findMany: jest.fn().mockResolvedValue([]),
				findFirst: jest.fn().mockResolvedValue(null),
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
				aggregate: jest.fn().mockResolvedValue({
					_min: { availableAt: null, lockedAt: null }
				})
			}
		};
		emailService = {
			sendSubscriptionExpiryReminder: jest
				.fn()
				.mockResolvedValue(undefined)
		};
		telegramBotService = {
			deactivateNotificationChannelByChatId: jest
				.fn()
				.mockResolvedValue(undefined)
		};
		telegramInfoTransport = {
			sendMessage: jest.fn().mockResolvedValue(undefined)
		};
		service = new SubscriptionExpiryService(
			prisma as unknown as PrismaService,
			emailService as unknown as EmailService,
			telegramBotService as unknown as TelegramBotService,
			telegramInfoTransport as unknown as TelegramInfoTransportService
		);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	const sendExpiryReminders = () =>
		(service as any).sendExpiryReminders() as Promise<{
			sentCount: number;
			failedCount: number;
		}>;

	it('does not block application bootstrap on startup deliveries', async () => {
		const maintenance = jest
			.spyOn(service as any, 'runSubscriptionMaintenance')
			.mockResolvedValue({
				expiredCount: 0,
				reminders: { sentCount: 0, failedCount: 0 }
			});
		const scheduleNext = jest
			.spyOn(service as any, 'scheduleNext')
			.mockResolvedValue(undefined);

		service.onModuleInit();

		expect(maintenance).not.toHaveBeenCalled();
		await jest.runOnlyPendingTimersAsync();
		expect(maintenance).toHaveBeenCalledTimes(1);
		expect(scheduleNext).toHaveBeenCalledTimes(1);
	});

	it('seeds a reminder, claims it with CAS, sends deterministic email and marks it SENT', async () => {
		const reminder = createReminder();
		prisma.subscription.findMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{
					id: reminder.subscriptionId,
					userId: reminder.userId,
					plan: reminder.subscription.plan,
					expiresAt: reminder.expiresAt,
					user: {
						authIdentities: reminder.user.authIdentities,
						telegramNotificationChannel: null
					}
				}
			])
			.mockResolvedValueOnce([]);
		prisma.subscriptionExpiryReminder.findMany.mockResolvedValue([
			reminder
		]);
		prisma.subscriptionExpiryReminder.findFirst.mockResolvedValue({
			...reminder,
			attempts: 1
		});
		prisma.subscriptionExpiryReminder.updateMany
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 1 });

		await expect(sendExpiryReminders()).resolves.toEqual({
			sentCount: 1,
			failedCount: 0
		});

		expect(
			prisma.subscriptionExpiryReminder.createMany
		).toHaveBeenCalledWith({
			data: [
				{
					subscriptionId: reminder.subscriptionId,
					userId: reminder.userId,
					daysBeforeExpiry: 3,
					expiresAt: reminder.expiresAt,
					sentTo: reminder.sentTo,
					status: SubscriptionExpiryReminderStatus.PENDING
				}
			],
			skipDuplicates: true
		});
		expect(
			prisma.subscriptionExpiryReminder.updateMany
		).toHaveBeenNthCalledWith(1, {
			where: {
				id: reminder.id,
				OR: expect.any(Array)
			},
			data: {
				status: SubscriptionExpiryReminderStatus.PROCESSING,
				lockedAt: NOW,
				lockedBy: expect.any(String),
				attempts: { increment: 1 }
			}
		});
		expect(
			emailService.sendSubscriptionExpiryReminder
		).toHaveBeenCalledWith(
			reminder.sentTo,
			expect.objectContaining({
				daysBeforeExpiry: reminder.daysBeforeExpiry,
				planLabel: 'Easy'
			}),
			{
				messageId: `<${reminder.id}.subscription-expiry@winwidget.ru>`
			}
		);
		expect(
			prisma.subscriptionExpiryReminder.updateMany
		).toHaveBeenNthCalledWith(2, {
			where: {
				id: reminder.id,
				status: SubscriptionExpiryReminderStatus.PROCESSING,
				lockedBy: expect.any(String)
			},
			data: {
				status: SubscriptionExpiryReminderStatus.SENT,
				sentAt: NOW,
				lockedAt: null,
				lockedBy: null,
				lastError: null
			}
		});
	});

	it('does not send when another replica wins the claim race', async () => {
		const reminder = createReminder();
		prisma.subscriptionExpiryReminder.findMany.mockResolvedValue([
			reminder
		]);
		prisma.subscriptionExpiryReminder.updateMany.mockResolvedValue({
			count: 0
		});

		await expect(sendExpiryReminders()).resolves.toEqual({
			sentCount: 0,
			failedCount: 0
		});

		expect(
			prisma.subscriptionExpiryReminder.updateMany
		).toHaveBeenCalledTimes(1);
		expect(
			emailService.sendSubscriptionExpiryReminder
		).not.toHaveBeenCalled();
		expect(telegramInfoTransport.sendMessage).not.toHaveBeenCalled();
	});

	it('returns a transient SMTP failure to PENDING with backoff and cleared locks', async () => {
		const reminder = createReminder();
		const smtpError = Object.assign(
			new Error('SMTP connection timed out'),
			{
				code: 'ETIMEDOUT'
			}
		);
		prisma.subscriptionExpiryReminder.findMany.mockResolvedValue([
			reminder
		]);
		prisma.subscriptionExpiryReminder.findFirst.mockResolvedValue({
			...reminder,
			attempts: 1
		});
		prisma.subscriptionExpiryReminder.updateMany
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 1 });
		emailService.sendSubscriptionExpiryReminder.mockRejectedValue(
			smtpError
		);

		await expect(sendExpiryReminders()).resolves.toEqual({
			sentCount: 0,
			failedCount: 1
		});

		expect(
			prisma.subscriptionExpiryReminder.updateMany
		).toHaveBeenNthCalledWith(2, {
			where: {
				id: reminder.id,
				status: SubscriptionExpiryReminderStatus.PROCESSING,
				lockedBy: expect.any(String)
			},
			data: {
				status: SubscriptionExpiryReminderStatus.PENDING,
				availableAt: new Date(NOW.getTime() + 30_000),
				lockedAt: null,
				lockedBy: null,
				lastError: 'SMTP_ETIMEDOUT: SMTP delivery failed temporarily'
			}
		});
	});

	it('uses the attempts value reloaded after the claim to enforce the retry budget', async () => {
		const candidate = createReminder({ attempts: 0 });
		const claimed = createReminder({ attempts: 4 });
		prisma.subscriptionExpiryReminder.findMany.mockResolvedValue([
			candidate
		]);
		prisma.subscriptionExpiryReminder.findFirst.mockResolvedValue(claimed);
		prisma.subscriptionExpiryReminder.updateMany
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 1 });
		emailService.sendSubscriptionExpiryReminder.mockRejectedValue(
			Object.assign(new Error('SMTP connection timed out'), {
				code: 'ETIMEDOUT'
			})
		);

		await expect(sendExpiryReminders()).resolves.toEqual({
			sentCount: 0,
			failedCount: 1
		});

		expect(
			prisma.subscriptionExpiryReminder.updateMany
		).toHaveBeenNthCalledWith(2, {
			where: {
				id: claimed.id,
				status: SubscriptionExpiryReminderStatus.PROCESSING,
				lockedBy: expect.any(String)
			},
			data: {
				status: SubscriptionExpiryReminderStatus.FAILED,
				availableAt: NOW,
				lockedAt: null,
				lockedBy: null,
				lastError: 'SMTP_ETIMEDOUT: SMTP delivery failed temporarily'
			}
		});
	});

	it('marks an unavailable Telegram destination FAILED and deactivates it', async () => {
		const reminder = createReminder({
			sentTo: 'telegram:123456789',
			user: {
				authIdentities: [],
				telegramNotificationChannel: {
					chatId: '123456789',
					isActive: true
				}
			}
		});
		prisma.subscriptionExpiryReminder.findMany.mockResolvedValue([
			reminder
		]);
		prisma.subscriptionExpiryReminder.findFirst.mockResolvedValue({
			...reminder,
			attempts: 1
		});
		prisma.subscriptionExpiryReminder.updateMany
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 1 });
		telegramInfoTransport.sendMessage.mockRejectedValue(
			new TelegramApiError({
				httpStatus: 403,
				description: 'Forbidden: bot was blocked by the user'
			})
		);

		await expect(sendExpiryReminders()).resolves.toEqual({
			sentCount: 0,
			failedCount: 1
		});

		expect(telegramInfoTransport.sendMessage).toHaveBeenCalledWith(
			'123456789',
			expect.any(String)
		);
		expect(
			telegramBotService.deactivateNotificationChannelByChatId
		).toHaveBeenCalledWith('123456789');
		expect(
			prisma.subscriptionExpiryReminder.updateMany
		).toHaveBeenNthCalledWith(2, {
			where: {
				id: reminder.id,
				status: SubscriptionExpiryReminderStatus.PROCESSING,
				lockedBy: expect.any(String)
			},
			data: {
				status: SubscriptionExpiryReminderStatus.FAILED,
				availableAt: NOW,
				lockedAt: null,
				lockedBy: null,
				lastError:
					'TELEGRAM_BOT_BLOCKED: Telegram destination is no longer available'
			}
		});
	});

	it.each([
		[
			'stale email destination',
			{
				user: {
					authIdentities: [
						{
							type: AuthIdentityType.EMAIL,
							value: 'new-owner@example.com'
						}
					]
				}
			},
			'DESTINATION_CHANGED: Email reminder destination is no longer active'
		],
		[
			'changed subscription',
			{
				subscription: {
					status: SubscriptionStatus.CANCELLED
				}
			},
			'SUBSCRIPTION_CHANGED: Reminder no longer matches the active subscription'
		]
	])(
		'marks %s FAILED without an external call',
		async (_caseName, overrides, expectedReason) => {
			const reminder = createReminder(overrides);
			prisma.subscriptionExpiryReminder.findMany.mockResolvedValue([
				reminder
			]);
			prisma.subscriptionExpiryReminder.findFirst.mockResolvedValue({
				...reminder,
				attempts: 1
			});
			prisma.subscriptionExpiryReminder.updateMany
				.mockResolvedValueOnce({ count: 1 })
				.mockResolvedValueOnce({ count: 1 });

			await expect(sendExpiryReminders()).resolves.toEqual({
				sentCount: 0,
				failedCount: 1
			});

			expect(
				emailService.sendSubscriptionExpiryReminder
			).not.toHaveBeenCalled();
			expect(telegramInfoTransport.sendMessage).not.toHaveBeenCalled();
			expect(
				prisma.subscriptionExpiryReminder.updateMany
			).toHaveBeenNthCalledWith(2, {
				where: {
					id: reminder.id,
					status: SubscriptionExpiryReminderStatus.PROCESSING,
					lockedBy: expect.any(String)
				},
				data: {
					status: SubscriptionExpiryReminderStatus.FAILED,
					lockedAt: null,
					lockedBy: null,
					lastError: expectedReason
				}
			});
		}
	);
});
