import { assertMessagingEventContract } from './messaging-event-contract';
import type { NotificationDeliveryKind } from './messaging.constants';

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

	it.each([
		[
			'campaign-email',
			'notification.campaign.email.requested.v1',
			{
				reference: {
					type: 'mailing-delivery',
					id: '22222222-2222-4222-8222-222222222222',
					aggregateId: '33333333-3333-4333-8333-333333333333'
				},
				destination: { email: 'owner@example.com' },
				content: { subject: 'Новости', message: 'Текст' }
			}
		],
		[
			'campaign-telegram',
			'notification.campaign.telegram.requested.v1',
			{
				reference: {
					type: 'mailing-delivery',
					id: '22222222-2222-4222-8222-222222222222',
					aggregateId: '33333333-3333-4333-8333-333333333333'
				},
				destination: { telegramChatId: '12345' },
				content: { subject: 'Новости', message: 'Текст' }
			}
		],
		[
			'daily-summary-delivery-telegram',
			'notification.daily-summary.telegram.requested.v1',
			{
				reference: {
					type: 'daily-summary-job',
					id: '22222222-2222-4222-8222-222222222222'
				},
				destination: {
					telegramChatId: '-100123',
					messageThreadId: 42
				},
				content: { text: '<b>Итоги</b>' }
			}
		],
		[
			'subscription-expiry-email',
			'notification.subscription-expiry.email.requested.v1',
			{
				reference: {
					type: 'subscription-expiry-reminder',
					id: '22222222-2222-4222-8222-222222222222'
				},
				destination: { email: 'owner@example.com' },
				content: {
					daysBeforeExpiry: 3,
					planLabel: 'Easy',
					expiresAtLabel: '31.07.2026, 12:00'
				}
			}
		],
		[
			'subscription-expiry-telegram',
			'notification.subscription-expiry.telegram.requested.v1',
			{
				reference: {
					type: 'subscription-expiry-reminder',
					id: '22222222-2222-4222-8222-222222222222'
				},
				destination: { telegramChatId: '12345' },
				content: {
					daysBeforeExpiry: 3,
					planLabel: 'Easy',
					expiresAtLabel: '31.07.2026, 12:00'
				}
			}
		]
	])('accepts the strict %s request contract', (kind, eventType, data) => {
		expect(() =>
			assertMessagingEventContract(
				{
					schemaVersion: 1,
					eventType,
					...data
				},
				{
					eventType,
					routingKey: eventType,
					messageId,
					kind: kind as NotificationDeliveryKind
				}
			)
		).not.toThrow();
	});

	it('accepts only the exact outbound delivery outcome route', () => {
		const payload = {
			schemaVersion: 1,
			eventType: 'notification.delivery.outcome.v1',
			sourceEventId: messageId,
			sourceKind: 'campaign-email',
			reference: {
				type: 'mailing-delivery',
				id: '22222222-2222-4222-8222-222222222222',
				aggregateId: '33333333-3333-4333-8333-333333333333'
			},
			status: 'DELIVERED',
			failure: null,
			occurredAt: '2026-07-28T10:00:00.000Z'
		};

		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId
			})
		).not.toThrow();
		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: 'manual.campaign-email',
				messageId
			})
		).toThrow();
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
