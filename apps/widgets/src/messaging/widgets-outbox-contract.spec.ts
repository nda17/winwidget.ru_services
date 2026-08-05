import {
	WidgetsOutboxEvent,
	WidgetsOutboxExchange
} from '@prisma/widgets-client';
import { assertWidgetsOutboxContract } from './widgets-outbox-contract';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const CREDENTIAL_ID = '22222222-2222-4222-8222-222222222222';
const OCCURRED_AT = '2026-08-04T12:00:00.000Z';

const outbox = (
	eventType: string,
	routingKey: string,
	payload: Record<string, unknown>,
	exchange: WidgetsOutboxExchange = WidgetsOutboxExchange.EVENTS
): WidgetsOutboxEvent =>
	({
		messageId: EVENT_ID,
		eventType,
		routingKey,
		payload,
		headers: { 'x-correlation-id': 'correlation-1' },
		exchange
	}) as unknown as WidgetsOutboxEvent;

const identityPayload = () => ({
	schemaVersion: 1,
	eventType: 'identity.user.changed.v1',
	eventId: EVENT_ID,
	aggregateId: 'user-1',
	aggregateVersion: '1',
	sourceSequence: '1',
	occurredAt: OCCURRED_AT,
	tombstone: false,
	state: {
		id: 'user-1',
		createdAt: OCCURRED_AT,
		updatedAt: OCCURRED_AT,
		deletedAt: null,
		status: 'ACTIVE',
		roles: ['USER'],
		hasEmailIdentity: true,
		hasPhoneIdentity: false,
		hasTelegramIdentity: false,
		loginMethodCount: 1
	}
});

const leadPayload = (integration: 'email' | 'webhook') => ({
	schemaVersion: 2,
	eventType: 'lead.integration.requested.v2',
	integration,
	source: 'widget',
	entity: { id: 'widget-1', name: 'Колесо' },
	lead: {
		id: 'lead-1',
		contact: '+79990000000',
		createdAt: OCCURRED_AT
	},
	destination:
		integration === 'email'
			? { email: 'owner@example.com' }
			: { credentialRef: CREDENTIAL_ID }
});

describe('Widgets Outbox event contracts', () => {
	it.each([
		[WidgetsOutboxExchange.EVENTS, 'identity.user.changed.v1'],
		[WidgetsOutboxExchange.RETRY, 'identity.retry.2'],
		[WidgetsOutboxExchange.MANUAL_RETRY, 'identity.manual-retry'],
		[WidgetsOutboxExchange.DEAD_LETTER, 'widgets.identity.dead-letter']
	] as const)(
		'accepts an identity event on %s route',
		(exchange, route) => {
			expect(() =>
				assertWidgetsOutboxContract(
					outbox(
						'identity.user.changed.v1',
						route,
						identityPayload(),
						exchange
					)
				)
			).not.toThrow();
		}
	);

	it('accepts notification and provider lead routes', () => {
		expect(() =>
			assertWidgetsOutboxContract(
				outbox(
					'lead.integration.requested.v2',
					'lead.integration.email.v2',
					leadPayload('email')
				)
			)
		).not.toThrow();
		expect(() =>
			assertWidgetsOutboxContract(
				outbox(
					'lead.integration.requested.v2',
					'webhook.retry.3',
					leadPayload('webhook'),
					WidgetsOutboxExchange.RETRY
				)
			)
		).not.toThrow();
	});

	it.each([
		[
			'lead.limit.reached.email.v2',
			'wheel',
			{ email: 'owner@example.com' }
		],
		[
			'lead.limit.reached.telegram.v2',
			'timer',
			{ telegramChatId: '123456789' }
		]
	] as const)(
		'accepts canonical %s notifications',
		(eventType, type, destination) => {
			expect(() =>
				assertWidgetsOutboxContract(
					outbox(eventType, eventType, {
						schemaVersion: 2,
						eventType,
						entity: { id: 'widget-1', name: 'Widget', type },
						limit: 100,
						destination
					})
				)
			).not.toThrow();
		}
	);

	it('accepts update and delivery-close audit contracts without the comment', () => {
		const base = {
			schemaVersion: 1,
			eventType: 'admin.audit.event.v1',
			eventId: EVENT_ID,
			occurredAt: OCCURRED_AT,
			correlationId: 'correlation-1',
			actorId: 'admin-1'
		};
		expect(() =>
			assertWidgetsOutboxContract(
				outbox('admin.audit.event.v1', 'admin.audit.widgets.v1', {
					...base,
					action: 'WIDGET_UPDATE',
					target: {
						widgetId: 'widget-1',
						widgetType: 'WHEEL',
						ownerId: 'user-1'
					},
					metadata: { changedFields: ['config', 'name'] }
				})
			)
		).not.toThrow();
		expect(() =>
			assertWidgetsOutboxContract(
				outbox('admin.audit.event.v1', 'admin.audit.widgets.v1', {
					...base,
					action: 'WIDGET_DELIVERY_CLOSE',
					target: {
						widgetId: 'widget-1',
						widgetType: 'WHEEL',
						ownerId: 'user-1',
						failureId: CREDENTIAL_ID,
						integration: 'webhook'
					},
					metadata: { commentPresent: true, commentLength: 12 }
				})
			)
		).not.toThrow();
	});

	it.each([
		[
			'widgets.widget.changed.v1',
			{
				id: 'widget-1',
				userId: 'user-1',
				widgetType: 'wheel',
				isActive: true,
				hasInstallDomain: true,
				createdAt: OCCURRED_AT
			}
		],
		[
			'widgets.lead.changed.v1',
			{
				id: 'lead-1',
				widgetId: 'widget-1',
				widgetType: 'wheel',
				createdAt: OCCURRED_AT
			}
		]
	] as const)(
		'accepts canonical Reporting %s events',
		(eventType, state) => {
			expect(() =>
				assertWidgetsOutboxContract(
					outbox(eventType, eventType, {
						schemaVersion: 1,
						eventType,
						eventId: EVENT_ID,
						aggregateId: 'wheel:widget-1',
						aggregateVersion: '1',
						sourceSequence: '1',
						occurredAt: OCCURRED_AT,
						tombstone: false,
						state
					})
				)
			).not.toThrow();
		}
	);

	it('rejects route drift, unknown events, and event identity mismatch', () => {
		expect(() =>
			assertWidgetsOutboxContract(
				outbox(
					'lead.integration.requested.v2',
					'lead.integration.webhook.v2',
					leadPayload('email')
				)
			)
		).toThrow('canonical EVENTS route');
		expect(() =>
			assertWidgetsOutboxContract(
				outbox('unknown.v1', 'unknown.v1', { eventType: 'unknown.v1' })
			)
		).toThrow('Unsupported Widgets Outbox eventType');
		expect(() =>
			assertWidgetsOutboxContract(
				outbox('widgets.lead.changed.v1', 'widgets.lead.changed.v1', {
					schemaVersion: 1,
					eventType: 'widgets.lead.changed.v1',
					eventId: CREDENTIAL_ID,
					aggregateId: 'wheel:widget-1',
					aggregateVersion: '1',
					sourceSequence: '1',
					occurredAt: OCCURRED_AT,
					tombstone: true,
					state: null
				})
			)
		).toThrow('eventId must equal Outbox messageId');
	});
});
