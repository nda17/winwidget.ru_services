import { IntegrationDeliveryService } from '@/messaging/integration-delivery.service';
import type { LeadIntegrationEventPayload } from '@/messaging/lead-integration-event';
import type { EmailService } from '@/email/email.service';
import type { SafeOutboundHttpService } from '@/safe-outbound-http/safe-outbound-http.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '@/prisma.service';

const createEvent = (
	overrides: Partial<LeadIntegrationEventPayload> = {}
): LeadIntegrationEventPayload => ({
	schemaVersion: 1,
	integration: 'webhook',
	source: 'widget',
	entity: { id: 'widget-1', name: 'Колесо' },
	lead: {
		id: 'lead-1',
		contact: '+79990000000',
		phone: '+79990000000',
		createdAt: '2026-07-23T12:00:00.000Z'
	},
	destination: {
		webhookUrl: 'https://example.com/webhook'
	},
	...overrides
});

describe('IntegrationDeliveryService', () => {
	const createService = () => {
		const emailService = {
			sendLeadNotification: jest.fn().mockResolvedValue(undefined),
			sendPaymentSucceededNotification: jest
				.fn()
				.mockResolvedValue(undefined)
		} as unknown as EmailService;
		const safeOutboundHttpService = {
			postJson: jest.fn().mockResolvedValue(undefined),
			getAmoCrmApiUrl: jest.fn()
		} as unknown as SafeOutboundHttpService;
		const configService = {
			get: jest.fn()
		} as unknown as ConfigService;
		const prisma = {
			telegramBotSettings: {
				findUnique: jest.fn()
			}
		} as unknown as PrismaService;

		return {
			service: new IntegrationDeliveryService(
				emailService,
				safeOutboundHttpService,
				configService,
				prisma
			),
			safeOutboundHttpService,
			emailService
		};
	};

	it('sends a versioned webhook with a stable event id', async () => {
		const { service, safeOutboundHttpService } = createService();

		await service.deliver('webhook', createEvent(), 'event-1');

		expect(safeOutboundHttpService.postJson).toHaveBeenCalledWith(
			'https://example.com/webhook',
			expect.objectContaining({
				eventId: 'event-1',
				eventType: 'lead.created.v1',
				source: 'widget',
				lead: expect.objectContaining({ id: 'lead-1' })
			}),
			{
				policy: 'webhook',
				headers: { 'X-WinWidget-Event-Id': 'event-1' }
			}
		);
	});

	it('sends a payment email from the payment consumer', async () => {
		const { service, emailService } = createService();

		await service.deliver(
			'payment-email',
			{
				schemaVersion: 1,
				eventType: 'payment.succeeded.v1',
				payment: {
					id: 'payment-1',
					yookassaId: 'yookassa-1',
					amount: '990.00',
					plan: 'EASY',
					billingPeriod: 'MONTHLY',
					succeededAt: '2026-07-23T12:00:00.000Z'
				},
				user: {
					id: 'user-1',
					name: 'Иван',
					email: 'user@example.com',
					phone: null
				},
				subscription: {
					expiresAt: '2026-08-23T12:00:00.000Z'
				}
			},
			'event-1'
		);

		expect(
			emailService.sendPaymentSucceededNotification
		).toHaveBeenCalledWith(
			'user@example.com',
			expect.objectContaining({
				amount: '990.00',
				planLabel: 'Easy',
				billingPeriodLabel: 'месяц'
			}),
			'event-1'
		);
	});

	it('rejects a message routed to the wrong integration consumer', async () => {
		const { service } = createService();

		await expect(
			service.deliver('email', createEvent(), 'event-1')
		).rejects.toThrow(
			'Integration mismatch: queue=email, payload=webhook'
		);
	});
});
