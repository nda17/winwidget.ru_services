import { PrismaService } from '@/prisma.service';
import { SubscriptionExpiryService } from '@/subscription/subscription-expiry.service';
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

describe('SubscriptionExpiryService durable dispatch', () => {
	let transaction: {
		subscriptionExpiryReminder: {
			updateMany: jest.Mock;
			findFirst: jest.Mock;
			update: jest.Mock;
		};
		outboxEvent: {
			create: jest.Mock;
		};
	};
	let prisma: {
		subscription: {
			findMany: jest.Mock;
			updateMany: jest.Mock;
		};
		subscriptionExpiryReminder: {
			createMany: jest.Mock;
			findMany: jest.Mock;
			aggregate: jest.Mock;
		};
		$transaction: jest.Mock;
	};
	let service: SubscriptionExpiryService;

	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(NOW);

		transaction = {
			subscriptionExpiryReminder: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
				findFirst: jest.fn().mockResolvedValue(null),
				update: jest.fn().mockResolvedValue({})
			},
			outboxEvent: {
				create: jest.fn().mockResolvedValue({})
			}
		};
		prisma = {
			subscription: {
				findMany: jest.fn().mockResolvedValue([]),
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			subscriptionExpiryReminder: {
				createMany: jest.fn().mockResolvedValue({ count: 0 }),
				findMany: jest.fn().mockResolvedValue([]),
				aggregate: jest.fn().mockResolvedValue({
					_min: { availableAt: null }
				})
			},
			$transaction: jest.fn(callback => callback(transaction))
		};
		service = new SubscriptionExpiryService(
			prisma as unknown as PrismaService,
			{
				isSchedulerEnabled: jest.fn().mockResolvedValue(true),
				assertSchedulerEnabled: jest.fn().mockResolvedValue(undefined)
			} as never
		);
	});

	afterEach(() => {
		service.onModuleDestroy();
		jest.useRealTimers();
	});

	const sendExpiryReminders = () =>
		(service as any).sendExpiryReminders() as Promise<{
			dispatchedCount: number;
			failedCount: number;
		}>;

	it('does not block application bootstrap on startup maintenance', async () => {
		const maintenance = jest
			.spyOn(service as any, 'runSubscriptionMaintenance')
			.mockResolvedValue({
				expiredCount: 0,
				reminders: { dispatchedCount: 0, failedCount: 0 }
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

	it('seeds, claims and transactionally dispatches an email reminder', async () => {
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
		transaction.subscriptionExpiryReminder.findFirst.mockResolvedValue({
			...reminder,
			attempts: 1
		});

		await expect(sendExpiryReminders()).resolves.toEqual({
			dispatchedCount: 1,
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
			transaction.subscriptionExpiryReminder.updateMany
		).toHaveBeenNthCalledWith(1, {
			where: {
				id: reminder.id,
				status: SubscriptionExpiryReminderStatus.PENDING,
				availableAt: { lte: NOW }
			},
			data: {
				status: SubscriptionExpiryReminderStatus.PROCESSING,
				lockedAt: NOW,
				lockedBy: expect.stringMatching(/^subscription-expiry:/),
				attempts: { increment: 1 }
			}
		});
		const outbox = transaction.outboxEvent.create.mock.calls[0][0].data;
		expect(outbox).toEqual(
			expect.objectContaining({
				eventType: 'notification.subscription-expiry.email.requested.v1',
				routingKey: 'notification.subscription-expiry.email.requested.v1',
				deduplicationKey:
					'notification-dispatch:subscription-expiry:reminder-1:v1'
			})
		);
		expect(outbox.payload).toEqual({
			schemaVersion: 1,
			eventType: 'notification.subscription-expiry.email.requested.v1',
			reference: {
				type: 'subscription-expiry-reminder',
				id: reminder.id
			},
			destination: { email: reminder.sentTo },
			content: {
				daysBeforeExpiry: 3,
				planLabel: 'Easy',
				expiresAtLabel: expect.any(String)
			}
		});
		expect(
			transaction.subscriptionExpiryReminder.updateMany
		).toHaveBeenNthCalledWith(2, {
			where: {
				id: reminder.id,
				status: SubscriptionExpiryReminderStatus.PROCESSING,
				lockedBy: expect.stringMatching(/^subscription-expiry:/),
				lockedAt: NOW
			},
			data: {
				lockedAt: null,
				lockedBy: null,
				lastError: null
			}
		});
	});

	it('dispatches a Telegram reminder without calling Telegram from the monolith', async () => {
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
		transaction.subscriptionExpiryReminder.findFirst.mockResolvedValue(
			reminder
		);

		await expect(sendExpiryReminders()).resolves.toEqual({
			dispatchedCount: 1,
			failedCount: 0
		});

		const outbox = transaction.outboxEvent.create.mock.calls[0][0].data;
		expect(outbox.eventType).toBe(
			'notification.subscription-expiry.telegram.requested.v1'
		);
		expect(outbox.payload).toEqual(
			expect.objectContaining({
				destination: { telegramChatId: '123456789' }
			})
		);
	});

	it('does not dispatch when another replica wins the claim race', async () => {
		prisma.subscriptionExpiryReminder.findMany.mockResolvedValue([
			createReminder()
		]);
		transaction.subscriptionExpiryReminder.updateMany.mockResolvedValue({
			count: 0
		});

		await expect(sendExpiryReminders()).resolves.toEqual({
			dispatchedCount: 0,
			failedCount: 0
		});
		expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
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
		'marks %s failed before creating an external delivery event',
		async (_caseName, overrides, expectedReason) => {
			const reminder = createReminder(overrides);
			prisma.subscriptionExpiryReminder.findMany.mockResolvedValue([
				reminder
			]);
			transaction.subscriptionExpiryReminder.findFirst.mockResolvedValue(
				reminder
			);

			await expect(sendExpiryReminders()).resolves.toEqual({
				dispatchedCount: 0,
				failedCount: 1
			});
			expect(
				transaction.subscriptionExpiryReminder.update
			).toHaveBeenCalledWith({
				where: { id: reminder.id },
				data: {
					status: SubscriptionExpiryReminderStatus.FAILED,
					lockedAt: null,
					lockedBy: null,
					lastError: expectedReason
				}
			});
			expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
		}
	);
});
