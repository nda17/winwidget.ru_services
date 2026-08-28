import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertMessagingEventContract } from './messaging-event-contract';
import type { NotificationDeliveryKind } from './messaging.constants';

const onlineConsultantCleanupMigration = readFileSync(
	resolve(
		__dirname,
		'../../prisma/migrations/20260828000000_remove_online_consultant_delivery_data/migration.sql'
	),
	'utf8'
);

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
			'notification.campaign.email.requested.v2',
			{
				destination: { email: 'owner@example.com' }
			}
		],
		[
			'campaign-telegram',
			'notification.campaign.telegram.requested.v2',
			{
				destination: { telegramChatId: '12345' }
			}
		]
	])('accepts the strict %s request contract', (kind, eventType, data) => {
		const campaignId = '33333333-3333-4333-8333-333333333333';
		const deliveryId = '22222222-2222-4222-8222-222222222222';
		expect(() =>
			assertMessagingEventContract(
				{
					schemaVersion: 2,
					eventType,
					eventId: messageId,
					occurredAt: '2026-07-30T10:00:00.000Z',
					correlationId: '44444444-4444-4444-8444-444444444444',
					campaignId,
					deliveryId,
					dispatchGeneration: 2,
					reference: {
						type: 'campaign-delivery',
						id: deliveryId,
						aggregateId: campaignId,
						dispatchGeneration: 2
					},
					...data,
					content: { subject: 'Новости', message: 'Текст' }
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

	it.each([
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

	it('separates Core and Reporting delivery outcome routes', () => {
		const corePayload = {
			schemaVersion: 1,
			eventType: 'notification.delivery.outcome.v1',
			sourceEventId: messageId,
			sourceKind: 'subscription-expiry-email',
			reference: {
				type: 'subscription-expiry-reminder',
				id: 'subscription-reminder-1'
			},
			status: 'DELIVERED',
			failure: null,
			occurredAt: '2026-08-04T00:00:00.000Z'
		};
		const reportingPayload = {
			schemaVersion: 1,
			eventType: 'reporting.notification.delivery.outcome.v1',
			sourceEventId: messageId,
			sourceKind: 'daily-summary-delivery-telegram',
			reference: { type: 'daily-summary-job', id: messageId },
			status: 'DELIVERED',
			failure: null,
			occurredAt: '2026-08-04T00:00:00.000Z'
		};

		expect(() =>
			assertMessagingEventContract(corePayload, {
				eventType: corePayload.eventType,
				routingKey: corePayload.eventType,
				messageId: '22222222-2222-4222-8222-222222222222'
			})
		).not.toThrow();
		expect(() =>
			assertMessagingEventContract(reportingPayload, {
				eventType: reportingPayload.eventType,
				routingKey: reportingPayload.eventType,
				messageId: '22222222-2222-4222-8222-222222222222'
			})
		).not.toThrow();
		expect(() =>
			assertMessagingEventContract(
				{
					...corePayload,
					sourceKind: 'daily-summary-delivery-telegram',
					reference: { type: 'daily-summary-job', id: messageId }
				},
				{
					eventType: corePayload.eventType,
					routingKey: corePayload.eventType,
					messageId: '22222222-2222-4222-8222-222222222222'
				}
			)
		).toThrow('payload.sourceKind is invalid');
		expect(() =>
			assertMessagingEventContract(reportingPayload, {
				eventType: reportingPayload.eventType,
				routingKey: 'notification.delivery.outcome.v1',
				messageId: '22222222-2222-4222-8222-222222222222'
			})
		).toThrow();
	});

	it('accepts only the exact outbound campaign delivery outcome route', () => {
		const payload = {
			schemaVersion: 2,
			eventType: 'notification.delivery.outcome.v2',
			eventId: messageId,
			occurredAt: '2026-07-28T10:00:00.000Z',
			correlationId: '44444444-4444-4444-8444-444444444444',
			sourceEventId: messageId,
			sourceKind: 'campaign-email',
			campaignId: '33333333-3333-4333-8333-333333333333',
			deliveryId: '22222222-2222-4222-8222-222222222222',
			dispatchGeneration: 2,
			status: 'DELIVERED',
			failure: null
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

	it('removes only provably linked retired lead delivery state in FK-safe order', () => {
		const collectEvents = onlineConsultantCleanupMigration.indexOf(
			'INSERT INTO "notification_delivery"."retired_online_consultant_delivery_events"'
		);
		const deleteOutbox = onlineConsultantCleanupMigration.indexOf(
			'DELETE FROM "notification_delivery"."outbox_events"'
		);
		const deleteActions = onlineConsultantCleanupMigration.indexOf(
			'DELETE FROM "notification_delivery"."control_actions"'
		);
		const deleteFailures = onlineConsultantCleanupMigration.indexOf(
			'DELETE FROM "notification_delivery"."delivery_failures"'
		);
		const deleteReceipts = onlineConsultantCleanupMigration.indexOf(
			'DELETE FROM "notification_delivery"."delivery_receipts"'
		);

		expect(onlineConsultantCleanupMigration.trimStart()).toMatch(
			/^--[\s\S]*BEGIN;/
		);
		expect(onlineConsultantCleanupMigration.trimEnd()).toMatch(/COMMIT;$/);
		expect(onlineConsultantCleanupMigration).not.toMatch(
			/\bCREATE\s+(?:LOCAL\s+|GLOBAL\s+)?TEMP(?:ORARY)?\s+TABLE\b/i
		);
		expect(onlineConsultantCleanupMigration).toContain(
			'CREATE TABLE "notification_delivery"."retired_online_consultant_delivery_events"'
		);
		expect(onlineConsultantCleanupMigration).toContain(
			"\"payload\" ->> 'source' = 'online-consultant'"
		);
		expect(onlineConsultantCleanupMigration).toContain(
			'"payload" ->> \'sourceEventId\''
		);
		expect(onlineConsultantCleanupMigration).toContain(
			'"headers" ->> \'x-causation-id\''
		);
		expect(onlineConsultantCleanupMigration).toContain(
			'A DELIVERED receipt has no source payload'
		);
		expect(collectEvents).toBeGreaterThan(-1);
		expect(collectEvents).toBeLessThan(deleteOutbox);
		expect(deleteOutbox).toBeLessThan(deleteActions);
		expect(deleteActions).toBeLessThan(deleteFailures);
		expect(deleteFailures).toBeLessThan(deleteReceipts);
		expect(
			onlineConsultantCleanupMigration.indexOf(
				'DROP TABLE "notification_delivery"."retired_online_consultant_delivery_events"'
			)
		).toBeGreaterThan(deleteReceipts);
	});
});
