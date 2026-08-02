import {
	assertMessagingEventContract,
	assertReportingProjectionEvent
} from '@/messaging/messaging-event-contract';
import {
	INTEGRATION_KINDS,
	MESSAGING_KINDS,
	MESSAGING_QUEUE_NAMES,
	MESSAGING_ROUTING_KEYS,
	REPORTING_CORE_OPERATIONAL_ROUTING_EVENT_TYPE,
	REPORTING_PROJECTION_KINDS,
	ReportingProjectionKind
} from '@/messaging/messaging.constants';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const OCCURRED_AT = '2026-07-31T12:00:00.000Z';

const states: Record<ReportingProjectionKind, Record<string, unknown>> = {
	'reporting-identity-user': {
		id: 'user-1',
		status: 'ACTIVE',
		deletedAt: null,
		roles: ['USER', 'ADMIN'],
		hasEmailIdentity: true,
		hasPhoneIdentity: false,
		hasTelegramIdentity: true,
		loginMethodCount: 2,
		createdAt: OCCURRED_AT,
		updatedAt: OCCURRED_AT
	},
	'reporting-billing-payment': {
		id: 'payment-1',
		userId: 'user-1',
		status: 'SUCCEEDED',
		amount: '990.00',
		createdAt: OCCURRED_AT,
		updatedAt: OCCURRED_AT
	},
	'reporting-billing-subscription': {
		id: 'subscription-1',
		userId: 'user-1',
		plan: 'EASY',
		status: 'ACTIVE',
		expiresAt: null,
		createdAt: OCCURRED_AT
	},
	'reporting-widget': {
		id: 'widget-1',
		userId: 'user-1',
		widgetType: 'countdownTimer',
		isActive: true,
		hasInstallDomain: true,
		createdAt: OCCURRED_AT
	},
	'reporting-lead': {
		id: 'lead-1',
		widgetId: 'widget-1',
		widgetType: 'countdownTimer',
		createdAt: OCCURRED_AT
	},
	'reporting-settings': {
		id: 'singleton',
		enabled: true,
		destinationChatId: '-100123',
		messageThreadId: 42,
		coreOperationalAlertsThreadId: 43,
		scheduleTime: '01:50',
		timezone: 'Europe/Moscow',
		lastSuccessfulPeriodStart: null,
		lastSuccessfulAt: null
	}
};

const eventFor = (kind: ReportingProjectionKind) => {
	const state = states[kind];
	const aggregateId =
		kind === 'reporting-widget' || kind === 'reporting-lead'
			? `${String(state.widgetType)}:${String(state.id)}`
			: String(state.id);
	return {
		schemaVersion: 1,
		eventType: MESSAGING_ROUTING_KEYS[kind],
		eventId: EVENT_ID,
		aggregateId,
		aggregateVersion: '1',
		sourceSequence: '7',
		occurredAt: OCCURRED_AT,
		tombstone: false,
		state
	};
};

describe('Reporting projection messaging contract', () => {
	it.each(REPORTING_PROJECTION_KINDS)(
		'accepts the exact %s state and dedicated route',
		kind => {
			const payload = eventFor(kind);
			expect(() =>
				assertMessagingEventContract(payload, {
					eventType: payload.eventType,
					routingKey: MESSAGING_ROUTING_KEYS[kind],
					messageId: EVENT_ID,
					kind
				})
			).not.toThrow();
		}
	);

	it('accepts the exact post-cutover Core operational routing projection', () => {
		const payload = {
			schemaVersion: 1,
			eventType: REPORTING_CORE_OPERATIONAL_ROUTING_EVENT_TYPE,
			eventId: EVENT_ID,
			aggregateId: 'singleton',
			aggregateVersion: '1',
			sourceSequence: '8',
			occurredAt: OCCURRED_AT,
			tombstone: false,
			state: {
				id: 'singleton',
				coreOperationalAlertsDestinationChatId: '-100123',
				coreOperationalAlertsThreadId: 2024
			}
		};
		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: EVENT_ID,
				kind: 'reporting-settings'
			})
		).not.toThrow();
	});

	it('accepts a tombstone and rejects a state attached to it', () => {
		const payload = {
			...eventFor('reporting-widget'),
			tombstone: true,
			state: null
		};
		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: EVENT_ID,
				kind: 'reporting-widget'
			})
		).not.toThrow();
		expect(() =>
			assertReportingProjectionEvent({
				...payload,
				state: states['reporting-widget']
			})
		).toThrow('must be null for a tombstone');
	});

	it('allows zero only for source snapshot rows', () => {
		const snapshotEvent = {
			...eventFor('reporting-identity-user'),
			aggregateVersion: '0',
			sourceSequence: '0'
		};
		expect(() =>
			assertReportingProjectionEvent(snapshotEvent, {
				allowZeroVersion: true
			})
		).not.toThrow();
		expect(() =>
			assertMessagingEventContract(snapshotEvent, {
				eventType: snapshotEvent.eventType,
				routingKey: snapshotEvent.eventType,
				messageId: EVENT_ID,
				kind: 'reporting-identity-user'
			})
		).toThrow('positive decimal string');
	});

	it('preserves legacy payment amount strings and source-field bounds', () => {
		const payload = eventFor('reporting-billing-payment');
		expect(() =>
			assertReportingProjectionEvent({
				...payload,
				aggregateVersion: '1'.repeat(66)
			})
		).toThrow('positive decimal string');
		for (const amount of [
			'0990.00',
			' 1 234,50 ',
			'historical-unknown',
			'x'.repeat(128)
		]) {
			expect(() =>
				assertReportingProjectionEvent({
					...payload,
					state: { ...payload.state, amount }
				})
			).not.toThrow();
		}
		for (const amount of ['', '   ', 'x'.repeat(129), '990\n00']) {
			expect(() =>
				assertReportingProjectionEvent({
					...payload,
					state: { ...payload.state, amount }
				})
			).toThrow('non-empty bounded string without control characters');
		}
		expect(() =>
			assertReportingProjectionEvent({
				...payload,
				aggregateId: 'a'.repeat(256)
			})
		).toThrow('must be a non-empty string');
	});

	it('rejects stale optional state fields and invalid settings timezone', () => {
		const subscription = eventFor('reporting-billing-subscription');
		expect(() =>
			assertReportingProjectionEvent({
				...subscription,
				state: { ...subscription.state, updatedAt: OCCURRED_AT }
			})
		).toThrow('unexpected fields: updatedAt');

		const widget = eventFor('reporting-widget');
		expect(() =>
			assertReportingProjectionEvent({
				...widget,
				state: { ...widget.state, updatedAt: OCCURRED_AT }
			})
		).toThrow('unexpected fields: updatedAt');

		const settings = eventFor('reporting-settings');
		expect(() =>
			assertReportingProjectionEvent({
				...settings,
				state: { ...settings.state, timezone: 'Invalid/Timezone' }
			})
		).toThrow('valid IANA timezone');
		expect(() =>
			assertReportingProjectionEvent({
				...settings,
				state: {
					...settings.state,
					coreOperationalAlertsThreadId: 0
				}
			})
		).toThrow('coreOperationalAlertsThreadId must be a positive integer');
	});

	it('requires the singleton aggregate for settings events and tombstones', () => {
		const settings = eventFor('reporting-settings');
		for (const payload of [
			{ ...settings, aggregateId: 'legacy-settings' },
			{
				...settings,
				aggregateId: 'legacy-settings',
				tombstone: true,
				state: null
			}
		]) {
			expect(() => assertReportingProjectionEvent(payload)).toThrow(
				'payload.aggregateId must equal singleton'
			);
		}
	});

	it('rejects PII or contract drift in projection state', () => {
		const payload = eventFor('reporting-identity-user');
		expect(() =>
			assertReportingProjectionEvent({
				...payload,
				state: {
					...payload.state,
					email: 'person@example.com'
				}
			})
		).toThrow('unexpected fields: email');
	});

	it('requires namespaced aggregate IDs for generic widget events', () => {
		const payload = eventFor('reporting-lead');
		expect(() =>
			assertReportingProjectionEvent({
				...payload,
				aggregateId: String(payload.state.id)
			})
		).toThrow('must namespace a widget type');
	});

	it('keeps Reporting queues publish-only for the core worker', () => {
		const expectedQueues: Record<ReportingProjectionKind, string> = {
			'reporting-identity-user': 'winwidget.reporting.identity-user',
			'reporting-billing-payment': 'winwidget.reporting.billing-payment',
			'reporting-billing-subscription':
				'winwidget.reporting.billing-subscription',
			'reporting-widget': 'winwidget.reporting.widget',
			'reporting-lead': 'winwidget.reporting.lead',
			'reporting-settings': 'winwidget.reporting.settings'
		};
		for (const kind of REPORTING_PROJECTION_KINDS) {
			expect(INTEGRATION_KINDS).not.toContain(kind);
			expect(MESSAGING_KINDS).not.toContain(kind);
			expect(MESSAGING_QUEUE_NAMES[kind]).toBe(expectedQueues[kind]);
		}
	});
});
