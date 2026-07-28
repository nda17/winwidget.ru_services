import { assertMessagingEventContract } from './messaging-event-contract';

describe('notification delivery messaging contracts', () => {
	const messageId = '11111111-1111-4111-8111-111111111111';
	const paymentTelegramPayload = {
		schemaVersion: 1,
		eventType: 'payment.notification.telegram.requested.v1',
		payment: {
			id: 'payment-1',
			yookassaId: 'yookassa-1',
			amount: '1000',
			plan: 'EASY',
			billingPeriod: 'MONTHLY',
			succeededAt: '2026-07-28T10:00:00.000Z'
		},
		user: {
			id: 'user-1',
			name: null,
			email: 'owner@example.com',
			phone: null
		},
		destination: {
			telegramChatId: '-1001234567890',
			messageThreadId: 42
		}
	};

	it('accepts the exact prepared payment Telegram contract', () => {
		expect(() =>
			assertMessagingEventContract(paymentTelegramPayload, {
				eventType: 'payment.notification.telegram.requested.v1',
				routingKey: 'payment.notification.telegram.requested.v1',
				messageId,
				kind: 'payment-telegram'
			})
		).not.toThrow();
	});

	it('accepts explicit null payment Telegram destination fields', () => {
		expect(() =>
			assertMessagingEventContract(
				{
					...paymentTelegramPayload,
					destination: {
						telegramChatId: null,
						messageThreadId: null
					}
				},
				{
					eventType: 'payment.notification.telegram.requested.v1',
					routingKey: 'payment.notification.telegram.requested.v1',
					messageId,
					kind: 'payment-telegram'
				}
			)
		).not.toThrow();
	});

	it.each([
		{
			label: 'missing destination field',
			payload: {
				...paymentTelegramPayload,
				destination: { telegramChatId: '-1001234567890' }
			}
		},
		{
			label: 'unexpected field',
			payload: { ...paymentTelegramPayload, subscription: {} }
		},
		{
			label: 'invalid thread id',
			payload: {
				...paymentTelegramPayload,
				destination: {
					telegramChatId: '-1001234567890',
					messageThreadId: 0
				}
			}
		}
	])('rejects a payment Telegram payload with $label', ({ payload }) => {
		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: 'payment.notification.telegram.requested.v1',
				routingKey: 'payment.notification.telegram.requested.v1',
				messageId,
				kind: 'payment-telegram'
			})
		).toThrow();
	});

	it('accepts the existing limit Telegram contract for the new owner', () => {
		expect(() =>
			assertMessagingEventContract(
				{
					schemaVersion: 2,
					eventType: 'lead.limit.reached.telegram.v2',
					entity: {
						id: 'widget-1',
						name: 'Колесо',
						type: 'widget'
					},
					limit: 10,
					destination: { telegramChatId: '12345' }
				},
				{
					eventType: 'lead.limit.reached.telegram.v2',
					routingKey: 'lead.limit.reached.telegram.v2',
					messageId,
					kind: 'limit-telegram'
				}
			)
		).not.toThrow();
	});

	it('accepts only the exact outbound destination-unavailable route', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'notification.telegram.destination-unavailable.v1',
			sourceEventId: messageId,
			sourceKind: 'telegram',
			destination: { telegramChatId: '12345' },
			normalizedCode: 'TELEGRAM_CHAT_NOT_FOUND',
			occurredAt: '2026-07-28T10:00:00.000Z'
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: '22222222-2222-4222-8222-222222222222'
			})
		).not.toThrow();
		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'manual.telegram',
				messageId: '22222222-2222-4222-8222-222222222222'
			})
		).toThrow();
		expect(() =>
			assertMessagingEventContract(
				{ ...payload, sourceKind: 'payment-telegram' },
				{
					eventType: payload.eventType,
					routingKey: payload.eventType,
					messageId: '22222222-2222-4222-8222-222222222222'
				}
			)
		).toThrow();
	});
});
