import { IntegrationDeliveryService } from './integration-delivery.service';

describe('IntegrationDeliveryService', () => {
	it('has no fallback writer for service-owned integrations', async () => {
		const service = new IntegrationDeliveryService();

		await expect(
			service.deliver('campaign-admin-audit', {
				schemaVersion: 1,
				eventType: 'admin.audit.event.v1',
				eventId: '33333333-3333-4333-8333-333333333333',
				occurredAt: '2026-07-23T12:00:00.000Z',
				correlationId: '44444444-4444-4444-8444-444444444444',
				actorId: 'admin-id',
				action: 'CAMPAIGN_CREATE',
				target: { campaignId: 'campaign-id' },
				metadata: {}
			})
		).rejects.toThrow(
			'Core integration delivery is unsupported for kind=campaign-admin-audit'
		);
	});
});
