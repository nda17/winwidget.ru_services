import { assertMessagingEventContract } from '@/messaging/messaging-event-contract';

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';

describe('messaging event contract', () => {
	it('accepts a complete lead integration event', () => {
		expect(() =>
			assertMessagingEventContract(
				{
					schemaVersion: 2,
					eventType: 'lead.integration.requested.v2',
					integration: 'webhook',
					source: 'widget',
					entity: { id: 'widget-1', name: 'Колесо' },
					lead: {
						id: 'lead-1',
						createdAt: '2026-07-25T00:00:00.000Z',
						phone: '+79990000000'
					},
					destination: {
						credentialRef: '22222222-2222-4222-8222-222222222222'
					}
				},
				{
					eventType: 'lead.integration.requested.v2',
					routingKey: 'lead.integration.webhook.v2',
					messageId: MESSAGE_ID,
					kind: 'webhook'
				}
			)
		).not.toThrow();
	});

	it('rejects a routing key for another consumer', () => {
		expect(() =>
			assertMessagingEventContract(
				{
					schemaVersion: 2,
					eventType: 'lead.limit.reached.email.v2',
					entity: { id: 'widget-1', name: 'Колесо', type: 'widget' },
					limit: 100,
					destination: { email: 'owner@example.com' }
				},
				{
					eventType: 'lead.limit.reached.email.v2',
					routingKey: 'lead.limit.reached.telegram.v2',
					messageId: MESSAGE_ID
				}
			)
		).toThrow('Routing key');
	});

	it('rejects event type mismatches', () => {
		expect(() =>
			assertMessagingEventContract(
				{
					schemaVersion: 1,
					eventType: 'mailing.delivery.requested.v1',
					campaignId: '22222222-2222-4222-8222-222222222222',
					deliveryId: '33333333-3333-4333-8333-333333333333',
					channel: 'EMAIL'
				},
				{
					eventType: 'payment.succeeded.v1',
					routingKey: 'mailing.delivery.email.v1',
					messageId: MESSAGE_ID
				}
			)
		).toThrow('does not match');
	});

	it('rejects server credentials anywhere in a payload', () => {
		expect(() =>
			assertMessagingEventContract(
				{
					schemaVersion: 2,
					eventType: 'lead.integration.requested.v2',
					integration: 'webhook',
					source: 'widget',
					entity: { id: 'widget-1', name: 'Колесо' },
					lead: {
						id: 'lead-1',
						createdAt: '2026-07-25T00:00:00.000Z'
					},
					destination: {
						credentialRef: '22222222-2222-4222-8222-222222222222'
					},
					webhookUrl: 'https://example.com/secret'
				},
				{
					eventType: 'lead.integration.requested.v2',
					routingKey: 'lead.integration.webhook.v2',
					messageId: MESSAGE_ID
				}
			)
		).toThrow('forbidden');
	});

	it('rejects a scheduled event whose jobId differs from messageId', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'database.backup.requested.v1',
			jobId: MESSAGE_ID,
			jobType: 'DATABASE_BACKUP',
			scheduleKey: 'manual:test',
			periodStart: null,
			periodEnd: null
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: '22222222-2222-4222-8222-222222222222',
				kind: 'database-backup'
			})
		).toThrow('jobId must match');
	});

	it('rejects a backup period with only one boundary', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'database.backup.requested.v1',
			jobId: MESSAGE_ID,
			jobType: 'DATABASE_BACKUP',
			scheduleKey: 'scheduled:test',
			periodStart: '2026-07-25T00:00:00.000Z',
			periodEnd: null
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'database-backup'
			})
		).toThrow('must be null or dates together');
	});
});
