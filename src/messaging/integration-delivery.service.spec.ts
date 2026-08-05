import { IntegrationDeliveryService } from '@/messaging/integration-delivery.service';
import type { PrismaService } from '@/prisma.service';
import { SubscriptionExpiryReminderStatus } from '@prisma/client';

describe('IntegrationDeliveryService', () => {
	const eventId = '33333333-3333-4333-8333-333333333333';

	const createService = () => {
		const prisma = {
			telegramNotificationChannel: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			subscriptionExpiryReminder: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		} as unknown as PrismaService;
		const paymentService = {
			executeRecurringCharge: jest.fn().mockResolvedValue(undefined),
			handleRecurringDeliveryTerminalFailure: jest
				.fn()
				.mockResolvedValue(undefined)
		};
		const service = new IntegrationDeliveryService(
			prisma,
			paymentService as never
		);

		return {
			service,
			prisma,
			paymentService
		};
	};

	it('executes an auto-renewal charge by local payment reference', async () => {
		const { service, paymentService } = createService();

		await service.deliver('auto-renewal', {
			schemaVersion: 1,
			eventType: 'payment.auto-renewal.charge.requested.v1',
			paymentId: 'payment-1',
			autoRenewalId: 'renewal-1',
			cycleKey: 'renewal-1:2026-08-28T09:00:00.000Z',
			scheduledFor: '2026-08-28T09:00:00.000Z'
		});

		expect(paymentService.executeRecurringCharge).toHaveBeenCalledWith(
			'payment-1'
		);
	});

	it('pauses auto-renewal after a terminal worker failure', async () => {
		const { service, paymentService } = createService();
		const event = {
			schemaVersion: 1 as const,
			eventType: 'payment.auto-renewal.charge.requested.v1' as const,
			paymentId: 'payment-1',
			autoRenewalId: 'renewal-1',
			cycleKey: 'renewal-1:2026-08-28T09:00:00.000Z',
			scheduledFor: '2026-08-28T09:00:00.000Z'
		};

		await service.handleTerminalFailure('auto-renewal', event, {
			category: 'PERMANENT',
			normalizedCode: 'YOOKASSA_HTTP_402',
			retryable: false,
			retryDelayMs: null,
			safeReason: 'ЮKassa отклонила запрос автопродления',
			recognized: true,
			mayDisableDestination: false,
			classificationVersion: 1
		});

		expect(
			paymentService.handleRecurringDeliveryTerminalFailure
		).toHaveBeenCalledWith(
			'payment-1',
			'YOOKASSA_HTTP_402',
			'ЮKassa отклонила запрос автопродления'
		);
	});

	it('applies a destination-unavailable outcome with a stale-safe CAS', async () => {
		const { service, prisma } = createService();
		const occurredAt = '2026-07-23T12:00:00.000Z';

		await service.deliver('telegram-destination-unavailable', {
			schemaVersion: 1,
			eventType: 'notification.telegram.destination-unavailable.v1',
			sourceEventId: eventId,
			sourceKind: 'campaign-telegram',
			destination: { telegramChatId: '123456789' },
			normalizedCode: 'TELEGRAM_CHAT_NOT_FOUND',
			occurredAt
		});

		expect(
			prisma.telegramNotificationChannel.updateMany
		).toHaveBeenCalledWith({
			where: {
				chatId: '123456789',
				isActive: true,
				updatedAt: { lte: new Date(occurredAt) }
			},
			data: {
				isActive: false,
				disabledAt: new Date(occurredAt)
			}
		});
	});

	it('marks a subscription reminder from a terminal delivery outcome', async () => {
		const { service, prisma } = createService();

		await service.deliver('notification-delivery-outcome', {
			schemaVersion: 1,
			eventType: 'notification.delivery.outcome.v1',
			sourceEventId: eventId,
			sourceKind: 'subscription-expiry-email',
			reference: {
				type: 'subscription-expiry-reminder',
				id: 'reminder-1'
			},
			status: 'FAILED',
			failure: {
				normalizedCode: 'SMTP_REJECTED',
				safeReason: 'Mailbox rejected the message'
			},
			occurredAt: '2026-07-28T08:00:00.000Z'
		});

		expect(
			prisma.subscriptionExpiryReminder.updateMany
		).toHaveBeenCalledWith({
			where: {
				id: 'reminder-1',
				status: SubscriptionExpiryReminderStatus.PROCESSING
			},
			data: {
				status: SubscriptionExpiryReminderStatus.FAILED,
				lockedAt: null,
				lockedBy: null,
				lastError: 'SMTP_REJECTED: Mailbox rejected the message'
			}
		});
	});
});
