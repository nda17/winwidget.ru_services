import type { ConsumeMessage } from 'amqplib';
import { createHash } from 'node:crypto';

export const REPORTING_SOURCE_EVENT_TYPES = [
	'identity.user.changed.v1',
	'billing.payment.changed.v1',
	'billing.subscription.changed.v1',
	'widgets.widget.changed.v1',
	'widgets.lead.changed.v1',
	'reporting.core-operational-routing.changed.v1'
] as const;

export type ReportingSourceEventType =
	(typeof REPORTING_SOURCE_EVENT_TYPES)[number];

export const REPORTING_PROJECTION_STREAMS = [
	'identityUser',
	'billingPayment',
	'billingSubscription',
	'widget',
	'lead',
	'reportingSettings'
] as const;

export type ReportingProjectionStream =
	(typeof REPORTING_PROJECTION_STREAMS)[number];

export const REPORTING_WIDGET_TYPES = [
	'wheel',
	'quiz',
	'callback',
	'countdownTimer',
	'stopOffer',
	'onlineConsultant',
	'calculator'
] as const;

export type ReportingWidgetType = (typeof REPORTING_WIDGET_TYPES)[number];

export interface IdentityUserState {
	id: string;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
	status: 'ACTIVE' | 'DEACTIVATED';
	roles: Array<'USER' | 'ADMIN' | 'DEV'>;
	hasEmailIdentity: boolean;
	hasPhoneIdentity: boolean;
	hasTelegramIdentity: boolean;
	loginMethodCount: number;
}

export interface BillingPaymentState {
	id: string;
	userId: string;
	amount: string;
	status: 'PENDING' | 'SUCCEEDED' | 'CANCELLED' | 'EXPIRED';
	createdAt: string;
	updatedAt: string;
}

export interface BillingSubscriptionState {
	id: string;
	userId: string;
	plan: 'TRIAL' | 'EASY' | 'HARD';
	status: 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
	expiresAt: string | null;
	createdAt: string;
}

export interface WidgetState {
	id: string;
	userId: string;
	widgetType: ReportingWidgetType;
	isActive: boolean;
	hasInstallDomain: boolean;
	createdAt: string;
}

export interface LeadState {
	id: string;
	widgetId: string;
	widgetType: ReportingWidgetType;
	createdAt: string;
}

export interface CoreOperationalRoutingState {
	id: 'singleton';
	coreOperationalAlertsDestinationChatId: string;
	coreOperationalAlertsThreadId: number | null;
}

type SourceStateByType = {
	'identity.user.changed.v1': IdentityUserState;
	'billing.payment.changed.v1': BillingPaymentState;
	'billing.subscription.changed.v1': BillingSubscriptionState;
	'widgets.widget.changed.v1': WidgetState;
	'widgets.lead.changed.v1': LeadState;
	'reporting.core-operational-routing.changed.v1': CoreOperationalRoutingState;
};

export type ReportingSourceEvent<
	TType extends ReportingSourceEventType = ReportingSourceEventType
> = TType extends ReportingSourceEventType
	? {
			schemaVersion: 1;
			eventType: TType;
			eventId: string;
			aggregateId: string;
			aggregateVersion: string;
			sourceSequence: string;
			occurredAt: string;
			tombstone: boolean;
			state: SourceStateByType[TType] | null;
		}
	: never;

export interface NotificationDeliveryOutcomeEvent {
	schemaVersion: 1;
	eventType: 'notification.delivery.outcome.v1';
	sourceEventId: string;
	sourceKind:
		| 'daily-summary-delivery-telegram'
		| 'subscription-expiry-email'
		| 'subscription-expiry-telegram';
	reference:
		| {
				type: 'daily-summary-job';
				id: string;
		  }
		| {
				type: 'subscription-expiry-reminder';
				id: string;
		  };
	status: 'DELIVERED' | 'FAILED';
	failure: {
		normalizedCode: string;
		safeReason: string;
	} | null;
	occurredAt: string;
}

export class InvalidReportingEventError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidReportingEventError';
	}
}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,64})$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_AUTOMATIC_RETRY_ATTEMPT = 3;
const MAX_MANUAL_RETRY_CYCLE = 1_000_000;

export function reportingPayloadHash(value: unknown): string {
	return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function sourceEventTypeToStream(
	eventType: ReportingSourceEventType
): ReportingProjectionStream {
	const mapping: Record<
		ReportingSourceEventType,
		ReportingProjectionStream
	> = {
		'identity.user.changed.v1': 'identityUser',
		'billing.payment.changed.v1': 'billingPayment',
		'billing.subscription.changed.v1': 'billingSubscription',
		'widgets.widget.changed.v1': 'widget',
		'widgets.lead.changed.v1': 'lead',
		'reporting.core-operational-routing.changed.v1': 'reportingSettings'
	};
	return mapping[eventType];
}

export function parseReportingSourceEvent(
	value: unknown,
	expectedType?: ReportingSourceEventType,
	options: { allowZeroVersion?: boolean } = {}
): ReportingSourceEvent {
	const record = exactRecord(value, [
		'schemaVersion',
		'eventType',
		'eventId',
		'aggregateId',
		'aggregateVersion',
		'sourceSequence',
		'occurredAt',
		'tombstone',
		'state'
	]);
	assertLiteral(record.schemaVersion, 1, 'schemaVersion');
	assertOneOf(record.eventType, REPORTING_SOURCE_EVENT_TYPES, 'eventType');
	if (expectedType && record.eventType !== expectedType) {
		throw new InvalidReportingEventError(
			`eventType must equal ${expectedType}`
		);
	}
	assertUuid(record.eventId, 'eventId');
	assertBoundedString(record.aggregateId, 'aggregateId', 255);
	assertDecimal(record.aggregateVersion, 'aggregateVersion');
	assertDecimal(record.sourceSequence, 'sourceSequence');
	const aggregateIsZero = record.aggregateVersion === '0';
	const sequenceIsZero = record.sourceSequence === '0';
	if (
		(!options.allowZeroVersion && (aggregateIsZero || sequenceIsZero)) ||
		aggregateIsZero !== sequenceIsZero
	) {
		throw new InvalidReportingEventError(
			'aggregateVersion and sourceSequence must both be positive, or both zero for a source snapshot'
		);
	}
	assertIsoDate(record.occurredAt, 'occurredAt');
	if (
		record.eventType === 'reporting.core-operational-routing.changed.v1' &&
		record.aggregateId !== 'singleton'
	) {
		throw new InvalidReportingEventError(
			'reporting settings aggregateId must equal singleton'
		);
	}
	if (typeof record.tombstone !== 'boolean') {
		throw new InvalidReportingEventError('tombstone must be a boolean');
	}
	if (record.tombstone) {
		if (record.state !== null) {
			throw new InvalidReportingEventError(
				'tombstone event state must be null'
			);
		}
	} else {
		if (record.state === null) {
			throw new InvalidReportingEventError(
				'non-tombstone event state is required'
			);
		}
		parseSourceState(record.eventType, record.state);
		const state = record.state as Record<string, unknown>;
		const expectedAggregateId =
			record.eventType === 'widgets.widget.changed.v1' ||
			record.eventType === 'widgets.lead.changed.v1'
				? `${String(state.widgetType)}:${String(state.id)}`
				: state.id;
		if (expectedAggregateId !== record.aggregateId) {
			throw new InvalidReportingEventError(
				'state identity must equal aggregateId'
			);
		}
	}
	if (
		record.eventType === 'widgets.widget.changed.v1' ||
		record.eventType === 'widgets.lead.changed.v1'
	) {
		parseWidgetAggregateId(record.aggregateId);
	}
	return record as unknown as ReportingSourceEvent;
}

export function parseWidgetAggregateId(value: string): {
	widgetType: ReportingWidgetType;
	id: string;
} {
	const separator = value.indexOf(':');
	if (separator < 1 || separator === value.length - 1) {
		throw new InvalidReportingEventError(
			'widget aggregateId must be namespaced as widgetType:rawId'
		);
	}
	const widgetType = value.slice(0, separator);
	const id = value.slice(separator + 1);
	assertOneOf(
		widgetType,
		REPORTING_WIDGET_TYPES,
		'aggregateId.widgetType'
	);
	assertBoundedString(id, 'aggregateId.id', 255);
	return { widgetType, id };
}

export function parseNotificationDeliveryOutcome(
	value: unknown
): NotificationDeliveryOutcomeEvent {
	const record = exactRecord(value, [
		'schemaVersion',
		'eventType',
		'sourceEventId',
		'sourceKind',
		'reference',
		'status',
		'failure',
		'occurredAt'
	]);
	assertLiteral(record.schemaVersion, 1, 'schemaVersion');
	assertLiteral(
		record.eventType,
		'notification.delivery.outcome.v1',
		'eventType'
	);
	assertUuid(record.sourceEventId, 'sourceEventId');
	assertOneOf(
		record.sourceKind,
		[
			'daily-summary-delivery-telegram',
			'subscription-expiry-email',
			'subscription-expiry-telegram'
		],
		'sourceKind'
	);
	const reference = exactRecord(record.reference, ['type', 'id']);
	assertLiteral(
		reference.type,
		record.sourceKind === 'daily-summary-delivery-telegram'
			? 'daily-summary-job'
			: 'subscription-expiry-reminder',
		'reference.type'
	);
	assertUuid(reference.id, 'reference.id');
	assertOneOf(record.status, ['DELIVERED', 'FAILED'], 'status');
	if (record.status === 'DELIVERED') {
		if (record.failure !== null) {
			throw new InvalidReportingEventError(
				'DELIVERED outcome failure must be null'
			);
		}
	} else {
		const failure = exactRecord(record.failure, [
			'normalizedCode',
			'safeReason'
		]);
		assertBoundedString(
			failure.normalizedCode,
			'failure.normalizedCode',
			255
		);
		assertBoundedString(failure.safeReason, 'failure.safeReason', 2000);
	}
	assertIsoDate(record.occurredAt, 'occurredAt');
	return record as unknown as NotificationDeliveryOutcomeEvent;
}

export function parseReportingConsumeMessage(
	message: ConsumeMessage,
	expected:
		| ReportingSourceEventType
		| readonly ReportingSourceEventType[]
		| 'notification.delivery.outcome.v1'
): {
	eventId: string;
	eventType: string;
	payload: ReportingSourceEvent | NotificationDeliveryOutcomeEvent;
	retryAttempt: number;
	retryCycle: number;
} {
	if (message.content.length > 256 * 1024) {
		throw new InvalidReportingEventError('Event payload is too large');
	}
	let value: unknown;
	try {
		value = JSON.parse(message.content.toString('utf8'));
	} catch {
		throw new InvalidReportingEventError('Event payload is not JSON');
	}
	const isDeliveryOutcome =
		expected === 'notification.delivery.outcome.v1';
	const expectedTypes: readonly ReportingSourceEventType[] = Array.isArray(
		expected
	)
		? expected
		: isDeliveryOutcome
			? []
			: [expected as ReportingSourceEventType];
	const payload = isDeliveryOutcome
		? parseNotificationDeliveryOutcome(value)
		: parseReportingSourceEvent(value);
	const messageId =
		typeof message.properties.messageId === 'string'
			? message.properties.messageId
			: '';
	const eventType =
		typeof message.properties.type === 'string'
			? message.properties.type
			: '';
	const payloadEventId =
		'eventId' in payload ? payload.eventId : messageId;
	if (!UUID_PATTERN.test(messageId) || payloadEventId !== messageId) {
		throw new InvalidReportingEventError(
			'AMQP messageId must be a UUID and equal payload eventId when present'
		);
	}
	if (
		eventType !== payload.eventType ||
		(!isDeliveryOutcome &&
			!expectedTypes.includes(eventType as ReportingSourceEventType)) ||
		(isDeliveryOutcome && eventType !== 'notification.delivery.outcome.v1')
	) {
		throw new InvalidReportingEventError(
			'AMQP type must equal the expected payload eventType'
		);
	}
	const retryAttempt = parseOptionalIntegerHeader(
		message.properties.headers?.['x-retry-attempt'],
		'x-retry-attempt',
		MAX_AUTOMATIC_RETRY_ATTEMPT
	);
	const retryCycle = parseOptionalIntegerHeader(
		message.properties.headers?.['x-retry-cycle'],
		'x-retry-cycle',
		MAX_MANUAL_RETRY_CYCLE
	);
	return {
		eventId: messageId,
		eventType,
		payload,
		retryAttempt,
		retryCycle
	};
}

function parseOptionalIntegerHeader(
	value: unknown,
	name: string,
	maximum: number
): number {
	if (value === undefined) return 0;
	if (
		typeof value !== 'number' ||
		!Number.isInteger(value) ||
		value < 0 ||
		value > maximum
	) {
		throw new InvalidReportingEventError(`${name} header is invalid`);
	}
	return value;
}

function canonicalJson(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) {
		return `[${value.map(item => canonicalJson(item)).join(',')}]`;
	}
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(',')}}`;
	}
	const serialized = JSON.stringify(value);
	if (serialized === undefined) {
		throw new InvalidReportingEventError(
			'Reporting payload contains an unsupported JSON value'
		);
	}
	return serialized;
}

function parseSourceState(
	eventType: ReportingSourceEventType,
	value: unknown
): void {
	if (eventType === 'identity.user.changed.v1') {
		const state = exactRecord(value, [
			'id',
			'createdAt',
			'updatedAt',
			'deletedAt',
			'status',
			'roles',
			'hasEmailIdentity',
			'hasPhoneIdentity',
			'hasTelegramIdentity',
			'loginMethodCount'
		]);
		assertIdAndDates(state, ['createdAt', 'updatedAt']);
		assertNullableIsoDate(state.deletedAt, 'state.deletedAt');
		assertOneOf(state.status, ['ACTIVE', 'DEACTIVATED'], 'state.status');
		if (!Array.isArray(state.roles)) {
			throw new InvalidReportingEventError('state.roles must be an array');
		}
		state.roles.forEach(role =>
			assertOneOf(role, ['USER', 'ADMIN', 'DEV'], 'state.roles')
		);
		if (new Set(state.roles).size !== state.roles.length) {
			throw new InvalidReportingEventError('state.roles must be unique');
		}
		for (const key of [
			'hasEmailIdentity',
			'hasPhoneIdentity',
			'hasTelegramIdentity'
		] as const) {
			if (typeof state[key] !== 'boolean') {
				throw new InvalidReportingEventError(
					`state.${key} must be a boolean`
				);
			}
		}
		assertNonNegativeInteger(
			state.loginMethodCount,
			'state.loginMethodCount',
			20
		);
		return;
	}
	if (eventType === 'billing.payment.changed.v1') {
		const state = exactRecord(value, [
			'id',
			'userId',
			'amount',
			'status',
			'createdAt',
			'updatedAt'
		]);
		assertIdAndDates(state, ['createdAt', 'updatedAt']);
		assertBoundedString(state.userId, 'state.userId', 255);
		if (
			typeof state.amount !== 'string' ||
			!state.amount.trim() ||
			state.amount.length > 128 ||
			CONTROL_CHARACTER_PATTERN.test(state.amount)
		) {
			throw new InvalidReportingEventError('state.amount is invalid');
		}
		assertOneOf(
			state.status,
			['PENDING', 'SUCCEEDED', 'CANCELLED', 'EXPIRED'],
			'state.status'
		);
		return;
	}
	if (eventType === 'billing.subscription.changed.v1') {
		const state = exactRecord(value, [
			'id',
			'userId',
			'plan',
			'status',
			'expiresAt',
			'createdAt'
		]);
		assertIdAndDates(state, ['createdAt']);
		assertBoundedString(state.userId, 'state.userId', 255);
		assertOneOf(state.plan, ['TRIAL', 'EASY', 'HARD'], 'state.plan');
		assertOneOf(
			state.status,
			['ACTIVE', 'EXPIRED', 'CANCELLED'],
			'state.status'
		);
		assertNullableIsoDate(state.expiresAt, 'state.expiresAt');
		return;
	}
	if (eventType === 'widgets.widget.changed.v1') {
		const state = exactRecord(value, [
			'id',
			'userId',
			'widgetType',
			'isActive',
			'hasInstallDomain',
			'createdAt'
		]);
		assertIdAndDates(state, ['createdAt']);
		assertBoundedString(state.userId, 'state.userId', 255);
		assertOneOf(
			state.widgetType,
			REPORTING_WIDGET_TYPES,
			'state.widgetType'
		);
		if (
			typeof state.isActive !== 'boolean' ||
			typeof state.hasInstallDomain !== 'boolean'
		) {
			throw new InvalidReportingEventError(
				'widget boolean state is invalid'
			);
		}
		return;
	}
	if (eventType === 'widgets.lead.changed.v1') {
		const state = exactRecord(value, [
			'id',
			'widgetId',
			'widgetType',
			'createdAt'
		]);
		assertIdAndDates(state, ['createdAt']);
		assertBoundedString(state.widgetId, 'state.widgetId', 255);
		assertOneOf(
			state.widgetType,
			REPORTING_WIDGET_TYPES,
			'state.widgetType'
		);
		return;
	}
	if (eventType === 'reporting.core-operational-routing.changed.v1') {
		const state = exactRecord(value, [
			'id',
			'coreOperationalAlertsDestinationChatId',
			'coreOperationalAlertsThreadId'
		]);
		if (state.id !== 'singleton') {
			throw new InvalidReportingEventError(
				'state.id must equal singleton for Core operational routing'
			);
		}
		if (
			typeof state.coreOperationalAlertsDestinationChatId !== 'string' ||
			state.coreOperationalAlertsDestinationChatId.length > 255
		) {
			throw new InvalidReportingEventError(
				'state.coreOperationalAlertsDestinationChatId is invalid'
			);
		}
		if (state.coreOperationalAlertsThreadId !== null) {
			assertPositiveInteger(
				state.coreOperationalAlertsThreadId,
				'state.coreOperationalAlertsThreadId'
			);
		}
		return;
	}
	throw new InvalidReportingEventError(
		'Unsupported Reporting source event'
	);
}

function assertIdAndDates(
	state: Record<string, unknown>,
	dates: readonly string[]
): void {
	assertBoundedString(state.id, 'state.id', 255);
	for (const date of dates) {
		assertIsoDate(state[date], `state.${date}`);
	}
}

function exactRecord(
	value: unknown,
	keys: readonly string[]
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new InvalidReportingEventError('Expected an object');
	}
	const record = value as Record<string, unknown>;
	const actual = Object.keys(record).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new InvalidReportingEventError('Object contains invalid keys');
	}
	return record;
}

function assertUuid(
	value: unknown,
	field: string
): asserts value is string {
	if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
		throw new InvalidReportingEventError(`${field} must be a UUID`);
	}
}

function assertDecimal(
	value: unknown,
	field: string
): asserts value is string {
	if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
		throw new InvalidReportingEventError(
			`${field} must be a non-negative decimal string`
		);
	}
}

function assertIsoDate(
	value: unknown,
	field: string
): asserts value is string {
	if (
		typeof value !== 'string' ||
		!/^\d{4}-\d{2}-\d{2}T/.test(value) ||
		!Number.isFinite(Date.parse(value))
	) {
		throw new InvalidReportingEventError(
			`${field} must be an ISO timestamp`
		);
	}
}

function assertNullableIsoDate(value: unknown, field: string): void {
	if (value !== null) assertIsoDate(value, field);
}

function assertLiteral<T>(
	value: unknown,
	expected: T,
	field: string
): asserts value is T {
	if (value !== expected) {
		throw new InvalidReportingEventError(`${field} has an invalid value`);
	}
}

function assertOneOf<T extends string>(
	value: unknown,
	values: readonly T[],
	field: string
): asserts value is T {
	if (typeof value !== 'string' || !values.includes(value as T)) {
		throw new InvalidReportingEventError(`${field} has an invalid value`);
	}
}

function assertBoundedString(
	value: unknown,
	field: string,
	max: number
): asserts value is string {
	if (typeof value !== 'string' || !value.trim() || value.length > max) {
		throw new InvalidReportingEventError(`${field} is invalid`);
	}
}

function assertNonNegativeInteger(
	value: unknown,
	field: string,
	max = Number.MAX_SAFE_INTEGER
): asserts value is number {
	if (
		!Number.isInteger(value) ||
		Number(value) < 0 ||
		Number(value) > max
	) {
		throw new InvalidReportingEventError(
			`${field} must be a non-negative integer`
		);
	}
}

function assertPositiveInteger(
	value: unknown,
	field: string
): asserts value is number {
	if (!Number.isInteger(value) || Number(value) < 1) {
		throw new InvalidReportingEventError(
			`${field} must be a positive integer`
		);
	}
}
