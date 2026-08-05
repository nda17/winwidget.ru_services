import type { ConsumeMessage } from 'amqplib';
import {
	BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE,
	IDENTITY_USER_CHANGED_EVENT_TYPE,
	InvalidWidgetsProjectionEventError,
	parseWidgetsProjectionEvent,
	parseWidgetsProjectionMessage,
	projectionPayloadHash
} from './widgets-projection.contract';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const OCCURRED_AT = '2026-08-04T12:00:00.000Z';
const POSTGRES_BIGINT_MAX = '9223372036854775807';

const identityEvent = () => ({
	schemaVersion: 1 as const,
	eventType: IDENTITY_USER_CHANGED_EVENT_TYPE,
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
		status: 'ACTIVE' as const,
		roles: ['USER'] as const,
		hasEmailIdentity: true,
		hasPhoneIdentity: false,
		hasTelegramIdentity: false,
		loginMethodCount: 1
	}
});

const entitlementEvent = () => ({
	schemaVersion: 1 as const,
	eventType: BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE,
	eventId: EVENT_ID,
	aggregateId: 'subscription-1',
	aggregateVersion: POSTGRES_BIGINT_MAX,
	sourceSequence: POSTGRES_BIGINT_MAX,
	occurredAt: OCCURRED_AT,
	tombstone: false,
	state: {
		id: 'subscription-1',
		userId: 'user-1',
		plan: 'HARD' as const,
		billingPeriod: 'MONTHLY' as const,
		status: 'ACTIVE' as const,
		startsAt: OCCURRED_AT,
		expiresAt: null,
		periodResetsAt: null,
		maxWidgets: 1_000_000,
		maxLeadsPerPeriod: null,
		unlimited: true,
		createdAt: OCCURRED_AT
	}
});

const messageFor = (
	payload: unknown,
	properties: Partial<ConsumeMessage['properties']> = {}
): ConsumeMessage =>
	({
		content: Buffer.from(JSON.stringify(payload)),
		fields: {},
		properties: {
			messageId: EVENT_ID,
			type: IDENTITY_USER_CHANGED_EVENT_TYPE,
			headers: {},
			...properties
		}
	}) as unknown as ConsumeMessage;

describe('widgets projection contract', () => {
	it('accepts exact identity and entitlement projection envelopes', () => {
		expect(parseWidgetsProjectionEvent(identityEvent())).toEqual(
			identityEvent()
		);
		expect(parseWidgetsProjectionEvent(entitlementEvent())).toEqual(
			entitlementEvent()
		);
	});

	it('rejects unknown fields and inconsistent tombstones', () => {
		expect(() =>
			parseWidgetsProjectionEvent({ ...identityEvent(), unexpected: true })
		).toThrow(InvalidWidgetsProjectionEventError);
		expect(() =>
			parseWidgetsProjectionEvent({ ...identityEvent(), tombstone: true })
		).toThrow('tombstone state must be null');
		expect(() =>
			parseWidgetsProjectionEvent({
				...identityEvent(),
				state: null
			})
		).toThrow('non-tombstone state is required');
	});

	it('enforces the PostgreSQL BIGINT upper bound', () => {
		expect(() =>
			parseWidgetsProjectionEvent(entitlementEvent())
		).not.toThrow();
		expect(() =>
			parseWidgetsProjectionEvent({
				...entitlementEvent(),
				aggregateVersion: '9223372036854775808'
			})
		).toThrow('aggregateVersion must be a positive PostgreSQL bigint');
		expect(() =>
			parseWidgetsProjectionEvent({
				...entitlementEvent(),
				sourceSequence: '9999999999999999999'
			})
		).toThrow('sourceSequence must be a positive PostgreSQL bigint');
	});

	it('binds AMQP identity and bounded retry headers to the payload', () => {
		const parsed = parseWidgetsProjectionMessage(
			'identity',
			messageFor(identityEvent(), {
				headers: {
					'x-retry-attempt': Buffer.from('2'),
					'x-manual-retry-cycle': 3
				}
			})
		);
		expect(parsed.retryAttempt).toBe(2);
		expect(parsed.manualRetryCycle).toBe(3);

		expect(() =>
			parseWidgetsProjectionMessage(
				'identity',
				messageFor(identityEvent(), { messageId: 'different' })
			)
		).toThrow('AMQP messageId must equal eventId');
		expect(() =>
			parseWidgetsProjectionMessage(
				'identity',
				messageFor(identityEvent(), {
					headers: { 'x-retry-attempt': 1_000_001 }
				})
			)
		).toThrow('x-retry-attempt must be a non-negative integer');
	});

	it('rejects an oversized body before JSON parsing', () => {
		const message = messageFor(identityEvent());
		message.content = Buffer.alloc(256 * 1024 + 1, 0x7b);
		expect(() =>
			parseWidgetsProjectionMessage('identity', message)
		).toThrow('Projection event payload is too large');
	});

	it('hashes semantically identical objects deterministically', () => {
		expect(projectionPayloadHash({ a: 1, b: { c: true } })).toBe(
			projectionPayloadHash({ b: { c: true }, a: 1 })
		);
		expect(projectionPayloadHash({ a: 1 })).not.toBe(
			projectionPayloadHash({ a: 2 })
		);
	});
});
