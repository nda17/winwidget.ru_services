import type { ConsumeMessage } from 'amqplib';
import { createHash } from 'node:crypto';

export const IDENTITY_USER_CHANGED_EVENT_TYPE =
	'identity.user.changed.v1' as const;
export const BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE =
	'billing.subscription.changed.v1' as const;

export const WIDGETS_PROJECTION_EVENT_TYPES = [
	IDENTITY_USER_CHANGED_EVENT_TYPE,
	BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE
] as const;

export type WidgetsProjectionEventType =
	(typeof WIDGETS_PROJECTION_EVENT_TYPES)[number];
export type WidgetsProjectionKind = 'identity' | 'entitlement';

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

export interface BillingSubscriptionState {
	id: string;
	userId: string;
	plan: 'TRIAL' | 'EASY' | 'HARD';
	billingPeriod: 'MONTHLY' | 'YEARLY' | null;
	status: 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
	startsAt: string;
	expiresAt: string | null;
	periodResetsAt: string | null;
	maxWidgets: number;
	maxLeadsPerPeriod: number | null;
	unlimited: boolean;
	createdAt: string;
}

type StateByEventType = {
	[IDENTITY_USER_CHANGED_EVENT_TYPE]: IdentityUserState;
	[BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE]: BillingSubscriptionState;
};

export type WidgetsProjectionEvent<
	TType extends WidgetsProjectionEventType = WidgetsProjectionEventType
> = TType extends WidgetsProjectionEventType
	? {
			schemaVersion: 1;
			eventType: TType;
			eventId: string;
			aggregateId: string;
			aggregateVersion: string;
			sourceSequence: string;
			occurredAt: string;
			tombstone: boolean;
			state: StateByEventType[TType] | null;
		}
	: never;

export interface ParsedWidgetsProjectionMessage {
	event: WidgetsProjectionEvent;
	retryAttempt: number;
	manualRetryCycle: number;
}

export class InvalidWidgetsProjectionEventError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidWidgetsProjectionEventError';
	}
}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL_PATTERN = /^[1-9][0-9]{0,18}$/;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const SAFE_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,255}$/;
const MAX_MESSAGE_BYTES = 256 * 1024;

export function projectionPayloadHash(value: unknown): string {
	return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function projectionStateHash(
	event: Pick<WidgetsProjectionEvent, 'tombstone' | 'state'>
): string {
	return projectionPayloadHash({
		tombstone: event.tombstone,
		state: event.state
	});
}

export function projectionKindForEventType(
	eventType: WidgetsProjectionEventType
): WidgetsProjectionKind {
	return eventType === IDENTITY_USER_CHANGED_EVENT_TYPE
		? 'identity'
		: 'entitlement';
}

export function parseWidgetsProjectionMessage(
	kind: WidgetsProjectionKind,
	message: ConsumeMessage
): ParsedWidgetsProjectionMessage {
	if (message.content.length > MAX_MESSAGE_BYTES) {
		throw new InvalidWidgetsProjectionEventError(
			'Projection event payload is too large'
		);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(message.content.toString('utf8'));
	} catch {
		throw new InvalidWidgetsProjectionEventError(
			'Projection event payload is not JSON'
		);
	}
	const expectedType =
		kind === 'identity'
			? IDENTITY_USER_CHANGED_EVENT_TYPE
			: BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE;
	const event = parseWidgetsProjectionEvent(payload, expectedType);
	if (message.properties.messageId !== event.eventId) {
		throw new InvalidWidgetsProjectionEventError(
			'AMQP messageId must equal eventId'
		);
	}
	if (message.properties.type !== event.eventType) {
		throw new InvalidWidgetsProjectionEventError(
			'AMQP type must equal eventType'
		);
	}
	return {
		event,
		retryAttempt: nonNegativeHeader(
			message.properties.headers?.['x-retry-attempt'],
			'x-retry-attempt'
		),
		manualRetryCycle: nonNegativeHeader(
			message.properties.headers?.['x-manual-retry-cycle'],
			'x-manual-retry-cycle'
		)
	};
}

export function parseWidgetsProjectionEvent(
	value: unknown,
	expectedType?: WidgetsProjectionEventType
): WidgetsProjectionEvent {
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
	if (record.schemaVersion !== 1) invalid('schemaVersion must equal 1');
	if (
		!WIDGETS_PROJECTION_EVENT_TYPES.includes(record.eventType as never)
	) {
		invalid('eventType is not supported by Widgets');
	}
	const eventType = record.eventType as WidgetsProjectionEventType;
	if (expectedType && eventType !== expectedType) {
		invalid(`eventType must equal ${expectedType}`);
	}
	assertUuid(record.eventId, 'eventId');
	assertId(record.aggregateId, 'aggregateId');
	assertDecimal(record.aggregateVersion, 'aggregateVersion');
	assertDecimal(record.sourceSequence, 'sourceSequence');
	assertIsoDate(record.occurredAt, 'occurredAt');
	if (typeof record.tombstone !== 'boolean') {
		invalid('tombstone must be a boolean');
	}
	if (record.tombstone) {
		if (record.state !== null) invalid('tombstone state must be null');
	} else {
		if (record.state === null) invalid('non-tombstone state is required');
		if (eventType === IDENTITY_USER_CHANGED_EVENT_TYPE) {
			parseIdentityState(record.state, String(record.aggregateId));
		} else {
			parseEntitlementState(record.state, String(record.aggregateId));
		}
	}
	return record as unknown as WidgetsProjectionEvent;
}

function parseIdentityState(value: unknown, aggregateId: string): void {
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
	assertId(state.id, 'state.id');
	if (state.id !== aggregateId) invalid('state.id must equal aggregateId');
	assertIsoDate(state.createdAt, 'state.createdAt');
	assertIsoDate(state.updatedAt, 'state.updatedAt');
	assertNullableIsoDate(state.deletedAt, 'state.deletedAt');
	assertOneOf(state.status, ['ACTIVE', 'DEACTIVATED'], 'state.status');
	if (!Array.isArray(state.roles)) invalid('state.roles must be an array');
	state.roles.forEach(role =>
		assertOneOf(role, ['USER', 'ADMIN', 'DEV'], 'state.roles')
	);
	if (new Set(state.roles).size !== state.roles.length) {
		invalid('state.roles must be unique');
	}
	for (const key of [
		'hasEmailIdentity',
		'hasPhoneIdentity',
		'hasTelegramIdentity'
	] as const) {
		if (typeof state[key] !== 'boolean') {
			invalid(`state.${key} must be a boolean`);
		}
	}
	assertInteger(state.loginMethodCount, 'state.loginMethodCount', 0, 20);
}

function parseEntitlementState(value: unknown, aggregateId: string): void {
	const state = exactRecord(value, [
		'id',
		'userId',
		'plan',
		'billingPeriod',
		'status',
		'startsAt',
		'expiresAt',
		'periodResetsAt',
		'maxWidgets',
		'maxLeadsPerPeriod',
		'unlimited',
		'createdAt'
	]);
	assertId(state.id, 'state.id');
	assertId(state.userId, 'state.userId');
	if (state.id !== aggregateId) invalid('state.id must equal aggregateId');
	assertOneOf(state.plan, ['TRIAL', 'EASY', 'HARD'], 'state.plan');
	if (state.billingPeriod !== null) {
		assertOneOf(
			state.billingPeriod,
			['MONTHLY', 'YEARLY'],
			'state.billingPeriod'
		);
	}
	assertOneOf(
		state.status,
		['ACTIVE', 'EXPIRED', 'CANCELLED'],
		'state.status'
	);
	assertIsoDate(state.startsAt, 'state.startsAt');
	assertNullableIsoDate(state.expiresAt, 'state.expiresAt');
	assertNullableIsoDate(state.periodResetsAt, 'state.periodResetsAt');
	assertIsoDate(state.createdAt, 'state.createdAt');
	assertInteger(state.maxWidgets, 'state.maxWidgets', 1, 1_000_000);
	if (state.maxLeadsPerPeriod !== null) {
		assertInteger(
			state.maxLeadsPerPeriod,
			'state.maxLeadsPerPeriod',
			1,
			2_147_483_647
		);
	}
	if (typeof state.unlimited !== 'boolean') {
		invalid('state.unlimited must be a boolean');
	}
	if (state.unlimited !== (state.maxLeadsPerPeriod === null)) {
		invalid(
			'state.unlimited must be true exactly when maxLeadsPerPeriod is null'
		);
	}
}

function exactRecord(
	value: unknown,
	keys: readonly string[]
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		invalid('value must be an object');
	}
	const record = value as Record<string, unknown>;
	const actual = Object.keys(record).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		invalid('object fields do not match the projection contract');
	}
	return record;
}

function assertId(value: unknown, path: string): asserts value is string {
	if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) {
		invalid(`${path} must be a bounded identifier`);
	}
}

function assertUuid(
	value: unknown,
	path: string
): asserts value is string {
	if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
		invalid(`${path} must be a UUID`);
	}
}

function assertDecimal(
	value: unknown,
	path: string
): asserts value is string {
	if (
		typeof value !== 'string' ||
		!DECIMAL_PATTERN.test(value) ||
		BigInt(value) > POSTGRES_BIGINT_MAX
	) {
		invalid(`${path} must be a positive PostgreSQL bigint`);
	}
}

function assertIsoDate(
	value: unknown,
	path: string
): asserts value is string {
	if (
		typeof value !== 'string' ||
		!value ||
		Number.isNaN(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	) {
		invalid(`${path} must be an ISO timestamp`);
	}
}

function assertNullableIsoDate(
	value: unknown,
	path: string
): asserts value is string | null {
	if (value !== null) assertIsoDate(value, path);
}

function assertOneOf(
	value: unknown,
	allowed: readonly string[],
	path: string
): void {
	if (typeof value !== 'string' || !allowed.includes(value)) {
		invalid(`${path} has an unsupported value`);
	}
}

function assertInteger(
	value: unknown,
	path: string,
	minimum: number,
	maximum: number
): asserts value is number {
	if (
		typeof value !== 'number' ||
		!Number.isInteger(value) ||
		value < minimum ||
		value > maximum
	) {
		invalid(
			`${path} must be an integer between ${minimum} and ${maximum}`
		);
	}
}

function nonNegativeHeader(value: unknown, path: string): number {
	if (value === undefined) return 0;
	const normalized = Buffer.isBuffer(value)
		? Number(value.toString('utf8'))
		: Number(value);
	if (
		!Number.isInteger(normalized) ||
		normalized < 0 ||
		normalized > 1_000_000
	) {
		invalid(`${path} must be a non-negative integer`);
	}
	return normalized;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			invalid('Projection payload contains an unsupported value');
		}
		return serialized;
	}
	if (Array.isArray(value)) {
		return `[${value.map(item => canonicalJson(item)).join(',')}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(',')}}`;
}

function invalid(message: string): never {
	throw new InvalidWidgetsProjectionEventError(message);
}
