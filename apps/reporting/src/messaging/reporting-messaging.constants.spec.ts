import {
	DAILY_SUMMARY_NOTIFICATION_DELIVERY_KIND,
	DAILY_SUMMARY_NOTIFICATION_EVENT_TYPE,
	REPORTING_ACCEPTED_ROUTING_KEYS,
	REPORTING_CONSUMER_KINDS,
	REPORTING_NOTIFICATION_DELIVERY_KINDS,
	REPORTING_NOTIFICATION_DELIVERY_ROUTING_KEYS,
	REPORTING_QUEUE_NAMES,
	REPORTING_ROUTING_KEYS,
	getReportingDeadLetterRoutingKey,
	getReportingManualRetryRoutingKey,
	getReportingRetryRoutingKey
} from './reporting-messaging.constants';
import { assertReportingConsumerOutboxEvent } from './reporting-published-event.contract';

const PROJECTION_EVENT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECTION_EVENT = {
	schemaVersion: 1,
	eventType: 'identity.user.changed.v1',
	eventId: PROJECTION_EVENT_ID,
	aggregateId: 'user-1',
	aggregateVersion: '1',
	sourceSequence: '1',
	occurredAt: '2026-07-31T00:00:00.000Z',
	tombstone: false,
	state: {
		id: 'user-1',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-07-31T00:00:00.000Z',
		deletedAt: null,
		status: 'ACTIVE',
		roles: ['USER'],
		hasEmailIdentity: true,
		hasPhoneIdentity: false,
		hasTelegramIdentity: false,
		loginMethodCount: 1
	}
};

const OPERATIONAL_ROUTING_EVENT_ID =
	'22222222-2222-4222-8222-222222222222';
const OPERATIONAL_ROUTING_EVENT = {
	schemaVersion: 1,
	eventType: 'reporting.core-operational-routing.changed.v1',
	eventId: OPERATIONAL_ROUTING_EVENT_ID,
	aggregateId: 'singleton',
	aggregateVersion: '2',
	sourceSequence: '2',
	occurredAt: '2026-07-31T00:00:00.000Z',
	tombstone: false,
	state: {
		id: 'singleton',
		coreOperationalAlertsDestinationChatId: '-100777',
		coreOperationalAlertsThreadId: 2024
	}
};

describe('reporting RabbitMQ topology contract', () => {
	it('uses a separate stable queue for every projection and outcome stream', () => {
		expect(new Set(Object.values(REPORTING_QUEUE_NAMES)).size).toBe(
			REPORTING_CONSUMER_KINDS.length
		);
		for (const kind of REPORTING_CONSUMER_KINDS) {
			expect(REPORTING_QUEUE_NAMES[kind]).toMatch(
				/^winwidget\.reporting\./
			);
			expect(REPORTING_ROUTING_KEYS[kind]).toMatch(/\.v1$/);
			expect(getReportingRetryRoutingKey(kind, 0)).toBe(`${kind}.retry.1`);
			expect(getReportingDeadLetterRoutingKey(kind)).toBe(
				`reporting.${kind}.dead-letter`
			);
			expect(getReportingManualRetryRoutingKey(kind)).toBe(
				`manual.${kind}`
			);
		}
	});

	it('keeps the shared dead-letter exchange topic-compatible', () => {
		// Cross-service declaration is intentionally asserted as topic in the
		// Rabbit service. This contract test protects the stable route format.
		expect(getReportingDeadLetterRoutingKey('deliveryOutcome')).toMatch(
			/^reporting\./
		);
	});

	it('declares the exact Notification Delivery kind produced by Reporting', () => {
		expect(REPORTING_NOTIFICATION_DELIVERY_KINDS).toEqual([
			'daily-summary-delivery-telegram'
		]);
		expect(
			REPORTING_NOTIFICATION_DELIVERY_ROUTING_KEYS[
				DAILY_SUMMARY_NOTIFICATION_DELIVERY_KIND
			]
		).toBe(DAILY_SUMMARY_NOTIFICATION_EVENT_TYPE);
	});

	it('accepts both transitional settings routes on the same queue', () => {
		expect(REPORTING_ACCEPTED_ROUTING_KEYS.reportingSettings).toEqual([
			'reporting.settings.changed.v1',
			'reporting.core-operational-routing.changed.v1'
		]);
	});

	it('accepts only exact manual retry routes and headers', () => {
		const event = {
			exchange: 'MANUAL_RETRY' as const,
			eventType: PROJECTION_EVENT.eventType,
			routingKey: 'manual.identityUser',
			messageId: PROJECTION_EVENT_ID,
			payload: PROJECTION_EVENT,
			headers: {
				'x-correlation-id': 'retry-correlation-1',
				'x-causation-id': PROJECTION_EVENT_ID,
				'x-retry-attempt': 0,
				'x-retry-cycle': 1,
				'x-manual-retry': true
			}
		};
		expect(() => assertReportingConsumerOutboxEvent(event)).not.toThrow();
		expect(() =>
			assertReportingConsumerOutboxEvent({
				...event,
				routingKey: 'manual.billingPayment'
			})
		).toThrow('route is invalid');
	});

	it.each([
		{
			exchange: 'RETRY' as const,
			routingKey: 'reportingSettings.retry.1',
			headers: {
				'x-correlation-id': 'operational-routing-retry',
				'x-causation-id': OPERATIONAL_ROUTING_EVENT_ID,
				'x-retry-attempt': 1,
				'x-retry-cycle': 0,
				'x-last-error': 'temporary failure'
			}
		},
		{
			exchange: 'MANUAL_RETRY' as const,
			routingKey: 'manual.reportingSettings',
			headers: {
				'x-correlation-id': 'operational-routing-manual-retry',
				'x-causation-id': OPERATIONAL_ROUTING_EVENT_ID,
				'x-retry-attempt': 0,
				'x-retry-cycle': 1,
				'x-manual-retry': true
			}
		}
	])('accepts the operational routing event through $exchange', event => {
		expect(() =>
			assertReportingConsumerOutboxEvent({
				...event,
				eventType: OPERATIONAL_ROUTING_EVENT.eventType,
				messageId: OPERATIONAL_ROUTING_EVENT_ID,
				payload: OPERATIONAL_ROUTING_EVENT
			})
		).not.toThrow();
	});
});
