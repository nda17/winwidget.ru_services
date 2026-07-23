import { IntegrationDeliveryService } from '@/messaging/integration-delivery.service';
import type { LeadIntegrationEventPayload } from '@/messaging/lead-integration-event';
import type { EmailService } from '@/email/email.service';
import type { SafeOutboundHttpService } from '@/safe-outbound-http/safe-outbound-http.service';
import type { ConfigService } from '@nestjs/config';

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
			sendLeadNotification: jest.fn().mockResolvedValue(undefined)
		} as unknown as EmailService;
		const safeOutboundHttpService = {
			postJson: jest.fn().mockResolvedValue(undefined),
			getAmoCrmApiUrl: jest.fn()
		} as unknown as SafeOutboundHttpService;
		const configService = {
			get: jest.fn()
		} as unknown as ConfigService;

		return {
			service: new IntegrationDeliveryService(
				emailService,
				safeOutboundHttpService,
				configService
			),
			safeOutboundHttpService
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

	it('rejects a message routed to the wrong integration consumer', async () => {
		const { service } = createService();

		await expect(
			service.deliver('email', createEvent(), 'event-1')
		).rejects.toThrow(
			'Integration mismatch: queue=email, payload=webhook'
		);
	});
});
