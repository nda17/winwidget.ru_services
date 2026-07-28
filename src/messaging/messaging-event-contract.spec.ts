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

	it('accepts a scheduled event routed to its Outbox-backed dead letter', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'database.backup.requested.v1',
			jobId: MESSAGE_ID,
			jobType: 'DATABASE_BACKUP',
			scheduleKey: 'scheduled:test',
			periodStart: null,
			periodEnd: null
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'database-backup.dead-letter',
				messageId: MESSAGE_ID,
				kind: 'database-backup'
			})
		).not.toThrow();
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

	it('keeps payment.succeeded.v1 exclusive to payment email', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'payment.succeeded.v1',
			payment: {
				id: 'payment-1',
				yookassaId: 'yookassa-1',
				amount: '990.00',
				plan: 'EASY',
				billingPeriod: 'MONTHLY',
				succeededAt: '2026-07-25T00:00:00.000Z'
			},
			user: {
				id: 'user-1',
				name: null,
				email: 'owner@example.com',
				phone: null
			},
			subscription: {
				expiresAt: '2026-08-25T00:00:00.000Z'
			}
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'payment.succeeded.v1',
				messageId: MESSAGE_ID,
				kind: 'payment-email'
			})
		).not.toThrow();
		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'payment.succeeded.v1',
				messageId: MESSAGE_ID,
				kind: 'payment-telegram'
			})
		).toThrow('cannot be consumed by payment-telegram');
	});

	it('accepts the prepared payment Telegram contract with a nullable destination', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'payment.notification.telegram.requested.v1',
			payment: {
				id: 'payment-1',
				yookassaId: 'yookassa-1',
				amount: '990.00',
				plan: 'EASY',
				billingPeriod: 'MONTHLY',
				succeededAt: '2026-07-25T00:00:00.000Z'
			},
			user: {
				id: 'user-1',
				name: null,
				email: 'owner@example.com',
				phone: null
			},
			destination: {
				telegramChatId: null,
				messageThreadId: null
			}
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'payment.notification.telegram.requested.v1',
				messageId: MESSAGE_ID,
				kind: 'payment-telegram'
			})
		).not.toThrow();
	});

	it('rejects non-positive payment Telegram topic IDs', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'payment.notification.telegram.requested.v1',
			payment: {
				id: 'payment-1',
				yookassaId: 'yookassa-1',
				amount: '990.00',
				plan: 'EASY',
				billingPeriod: 'MONTHLY',
				succeededAt: '2026-07-25T00:00:00.000Z'
			},
			user: {
				id: 'user-1',
				name: null,
				email: null,
				phone: null
			},
			destination: {
				telegramChatId: '-100123',
				messageThreadId: 0
			}
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'payment-telegram'
			})
		).toThrow('positive integer or null');
	});

	it('accepts the strict Telegram destination-unavailable outcome', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'notification.telegram.destination-unavailable.v1',
			sourceEventId: '22222222-2222-4222-8222-222222222222',
			sourceKind: 'limit-telegram',
			destination: { telegramChatId: '123456789' },
			normalizedCode: 'TELEGRAM_BOT_BLOCKED',
			occurredAt: '2026-07-25T00:00:00.000Z'
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'notification.telegram.destination-unavailable.v1',
				messageId: MESSAGE_ID,
				kind: 'telegram-destination-unavailable'
			})
		).not.toThrow();
	});

	it('accepts campaign Telegram as a destination-unavailable source', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'notification.telegram.destination-unavailable.v1',
			sourceEventId: '22222222-2222-4222-8222-222222222222',
			sourceKind: 'campaign-telegram',
			destination: { telegramChatId: '123456789' },
			normalizedCode: 'TELEGRAM_CHAT_NOT_FOUND',
			occurredAt: '2026-07-25T00:00:00.000Z'
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'telegram-destination-unavailable'
			})
		).not.toThrow();
	});

	it('accepts a strict Notification Delivery outcome', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'notification.delivery.outcome.v1',
			sourceEventId: '22222222-2222-4222-8222-222222222222',
			sourceKind: 'subscription-expiry-email',
			reference: {
				type: 'subscription-expiry-reminder',
				id: '33333333-3333-4333-8333-333333333333'
			},
			status: 'FAILED',
			failure: {
				normalizedCode: 'SMTP_REJECTED',
				safeReason: 'Mailbox rejected the message'
			},
			occurredAt: '2026-07-25T00:00:00.000Z'
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'notification-delivery-outcome'
			})
		).not.toThrow();
	});

	it('rejects unsupported source kinds in destination outcomes', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'notification.telegram.destination-unavailable.v1',
			sourceEventId: '22222222-2222-4222-8222-222222222222',
			sourceKind: 'payment-telegram',
			destination: { telegramChatId: '123456789' },
			normalizedCode: 'TELEGRAM_CHAT_NOT_FOUND',
			occurredAt: '2026-07-25T00:00:00.000Z'
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: MESSAGE_ID,
				kind: 'telegram-destination-unavailable'
			})
		).toThrow('sourceKind is invalid');
	});
});
