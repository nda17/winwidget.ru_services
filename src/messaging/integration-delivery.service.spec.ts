import { IntegrationDeliveryService } from '@/messaging/integration-delivery.service';
import type { LeadIntegrationDestinationService } from '@/messaging/lead-integration-destination.service';
import type { LeadIntegrationEventPayloadV2 } from '@/messaging/lead-integration-event';
import type { PrismaService } from '@/prisma.service';
import type { SafeOutboundHttpService } from '@/safe-outbound-http/safe-outbound-http.service';
import { SubscriptionExpiryReminderStatus } from '@prisma/client';

const createLeadEvent = (): LeadIntegrationEventPayloadV2 => ({
	schemaVersion: 2,
	eventType: 'lead.integration.requested.v2',
	integration: 'webhook',
	source: 'widget',
	entity: { id: 'widget-1', name: 'Колесо' },
	lead: {
		id: 'lead-1',
		contact: '+79990000000',
		createdAt: '2026-07-23T12:00:00.000Z'
	},
	destination: {
		credentialRef: '11111111-1111-4111-8111-111111111111'
	}
});

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
		const safeOutboundHttpService = {
			postJson: jest.fn().mockResolvedValue(undefined),
			getAmoCrmApiUrl: jest.fn()
		} as unknown as SafeOutboundHttpService;
		const leadDestination = {
			resolve: jest.fn(async (_sourceEventId, event) => ({
				...event,
				destination: {
					webhookUrl: 'https://example.com/webhook'
				}
			}))
		} as unknown as LeadIntegrationDestinationService;
		const paymentService = {
			executeRecurringCharge: jest.fn().mockResolvedValue(undefined),
			handleRecurringDeliveryTerminalFailure: jest
				.fn()
				.mockResolvedValue(undefined)
		};
		const service = new IntegrationDeliveryService(
			safeOutboundHttpService,
			prisma,
			leadDestination,
			paymentService as never
		);

		return {
			service,
			prisma,
			safeOutboundHttpService,
			paymentService
		};
	};

	it('executes an auto-renewal charge by local payment reference', async () => {
		const { service, paymentService } = createService();

		await service.deliver(
			'auto-renewal',
			{
				schemaVersion: 1,
				eventType: 'payment.auto-renewal.charge.requested.v1',
				paymentId: 'payment-1',
				autoRenewalId: 'renewal-1',
				cycleKey: 'renewal-1:2026-08-28T09:00:00.000Z',
				scheduledFor: '2026-08-28T09:00:00.000Z'
			},
			eventId
		);

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

	it('sends a versioned webhook with a stable event id', async () => {
		const { service, safeOutboundHttpService } = createService();

		await service.deliver('webhook', createLeadEvent(), eventId);

		expect(safeOutboundHttpService.postJson).toHaveBeenCalledWith(
			'https://example.com/webhook',
			expect.objectContaining({
				eventId,
				eventType: 'lead.created.v1',
				lead: expect.objectContaining({ id: 'lead-1' })
			}),
			{
				policy: 'webhook',
				headers: { 'X-WinWidget-Event-Id': eventId }
			}
		);
	});

	it('applies a destination-unavailable outcome with a stale-safe CAS', async () => {
		const { service, prisma } = createService();
		const occurredAt = '2026-07-23T12:00:00.000Z';

		await service.deliver(
			'telegram-destination-unavailable',
			{
				schemaVersion: 1,
				eventType: 'notification.telegram.destination-unavailable.v1',
				sourceEventId: eventId,
				sourceKind: 'campaign-telegram',
				destination: { telegramChatId: '123456789' },
				normalizedCode: 'TELEGRAM_CHAT_NOT_FOUND',
				occurredAt
			},
			'outcome-1'
		);

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

		await service.deliver(
			'notification-delivery-outcome',
			{
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
			},
			'outcome-4'
		);

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

	it('ignores a delivery outcome owned by another service', async () => {
		const { service, prisma } = createService();

		await service.deliver(
			'notification-delivery-outcome',
			{
				schemaVersion: 1,
				eventType: 'notification.delivery.outcome.v1',
				sourceEventId: eventId,
				sourceKind: 'external-notification',
				reference: {
					type: 'external-job',
					id: '44444444-4444-4444-8444-444444444444'
				},
				status: 'DELIVERED',
				failure: null,
				occurredAt: '2026-08-03T22:50:14.915Z'
			},
			'outcome-5'
		);

		expect(
			prisma.subscriptionExpiryReminder.updateMany
		).not.toHaveBeenCalled();
	});
});
