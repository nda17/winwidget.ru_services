import { WidgetType } from '../domain/widgets-domain.types';

export const WINCRM_TRANSFER_EVENT =
	'widgets.wincrm.lead-transfer.requested.v1';
export const LEAD_WIDGET_TYPES = [
	WidgetType.WHEEL,
	WidgetType.QUIZ,
	WidgetType.CALLBACK,
	WidgetType.TIMER,
	WidgetType.STOP_OFFER,
	WidgetType.CALCULATOR
] as const;
export type LeadWidgetType = (typeof LEAD_WIDGET_TYPES)[number];
export const SNAPSHOT_SKIP_REASONS = [
	'PAYLOAD_TOO_LARGE',
	'PAYLOAD_SHAPE_UNSUPPORTED',
	'TEXT_UNSUPPORTED',
	'SOURCE_PERIOD_INELIGIBLE',
	'SOURCE_PERIOD_INVALID',
	'BEFORE_ACTIVATION'
] as const;
export type SnapshotSkipReason = (typeof SNAPSHOT_SKIP_REASONS)[number];
export type TransferReason =
	| SnapshotSkipReason
	| 'READY'
	| 'CONNECTOR_DISABLED'
	| 'GENERATION_CHANGED'
	| 'WIDGET_UNAVAILABLE'
	| 'LEAD_UNAVAILABLE'
	| 'PERIOD_EXPIRED'
	| 'BILLING_INELIGIBLE'
	| 'BILLING_PERIOD_CHANGED';
export const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type JsonObject = Record<string, unknown>;

export function record(
	value: unknown,
	keys?: readonly string[]
): JsonObject {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid object');
	const result = value as JsonObject;
	if (
		keys &&
		(Object.keys(result).length !== keys.length ||
			keys.some(key => !Object.prototype.hasOwnProperty.call(result, key)))
	)
		throw new Error('Invalid fields');
	return result;
}
export function identifier(value: unknown, max = 255): string {
	if (
		typeof value !== 'string' ||
		!value.length ||
		value.length > max ||
		/[\s\u0000-\u001f\u007f]/u.test(value)
	)
		throw new Error('Invalid identifier');
	assertUnicode(value);
	return value;
}
export function uuid(value: unknown): string {
	if (typeof value !== 'string' || !UUID_V4.test(value))
		throw new Error('Invalid UUID');
	return value;
}
export function integer(
	value: unknown,
	max = 2_147_483_647,
	min = 1
): number {
	if (
		typeof value !== 'number' ||
		!Number.isInteger(value) ||
		value < min ||
		value > max
	)
		throw new Error('Invalid integer');
	return value;
}
export function iso(value: unknown): string {
	if (
		typeof value !== 'string' ||
		value.length !== 24 ||
		!Number.isFinite(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	)
		throw new Error('Invalid timestamp');
	return value;
}
export function version(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!/^(0|[1-9][0-9]{0,18})$/.test(value) ||
		BigInt(value) > 9_223_372_036_854_775_807n
	)
		throw new Error('Invalid version');
	return value;
}
export function widgetType(value: unknown): LeadWidgetType {
	if (!LEAD_WIDGET_TYPES.includes(value as LeadWidgetType))
		throw new Error('Invalid widget type');
	return value as LeadWidgetType;
}
export function plainText(value: unknown, max: number): string {
	if (typeof value !== 'string' || value.length > max)
		throw new SnapshotError('PAYLOAD_SHAPE_UNSUPPORTED');
	assertUnicode(value);
	// Legacy content remains untouched. Unsupported rich text is visible as a skipped transfer.
	if (/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))
		throw new SnapshotError('TEXT_UNSUPPORTED');
	return value;
}
export function assertUnicode(value: string): void {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 0xfffd || (code >= 0xdc00 && code <= 0xdfff))
			throw new SnapshotError('TEXT_UNSUPPORTED');
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(++index);
			if (!(next >= 0xdc00 && next <= 0xdfff))
				throw new SnapshotError('TEXT_UNSUPPORTED');
		}
	}
}
export class SnapshotError extends Error {
	constructor(readonly reason: SnapshotSkipReason) {
		super(reason);
	}
}

export interface ConfigureConnector {
	schemaVersion: 1;
	commandId: string;
	workspaceId: string;
	sourceId: string;
	ownerSubject: string;
	widgetType: LeadWidgetType;
	widgetId: string;
	controlVersion: number;
	generation: number;
	enabled: boolean;
}
export function configureInput(
	value: unknown,
	key: unknown
): ConfigureConnector {
	const input = record(value, [
		'schemaVersion',
		'commandId',
		'workspaceId',
		'sourceId',
		'ownerSubject',
		'widgetType',
		'widgetId',
		'controlVersion',
		'generation',
		'enabled'
	]);
	if (
		input.schemaVersion !== 1 ||
		input.commandId !== key ||
		typeof input.enabled !== 'boolean'
	)
		throw new Error('Invalid command');
	return {
		schemaVersion: 1,
		commandId: uuid(input.commandId),
		workspaceId: uuid(input.workspaceId),
		sourceId: uuid(input.sourceId),
		ownerSubject: identifier(input.ownerSubject, 256),
		widgetType: widgetType(input.widgetType),
		widgetId: identifier(input.widgetId),
		controlVersion: integer(input.controlVersion),
		generation: integer(input.generation),
		enabled: input.enabled
	};
}

export interface WidgetsEligibility {
	schemaVersion: 1;
	ownerSubject: string;
	eligible: boolean;
	reason:
		| 'ELIGIBLE'
		| 'NO_SUBSCRIPTION'
		| 'TRIAL'
		| 'INACTIVE'
		| 'NOT_STARTED'
		| 'EXPIRED';
	subscriptionId: string | null;
	version: string | null;
	plan: 'TRIAL' | 'EASY' | 'HARD' | null;
	startsAt: string | null;
	expiresAt: string | null;
	checkedAt: string;
	validUntil: string;
}
export function parseEligibility(
	value: unknown,
	ownerSubject: string,
	now: number
): WidgetsEligibility {
	const item = record(value, [
		'schemaVersion',
		'ownerSubject',
		'eligible',
		'reason',
		'subscriptionId',
		'version',
		'plan',
		'startsAt',
		'expiresAt',
		'checkedAt',
		'validUntil'
	]);
	if (
		item.schemaVersion !== 1 ||
		item.ownerSubject !== ownerSubject ||
		typeof item.eligible !== 'boolean' ||
		![
			'ELIGIBLE',
			'NO_SUBSCRIPTION',
			'TRIAL',
			'INACTIVE',
			'NOT_STARTED',
			'EXPIRED'
		].includes(String(item.reason))
	)
		throw new Error('Invalid eligibility');
	const checked = Date.parse(iso(item.checkedAt));
	const until = Date.parse(iso(item.validUntil));
	// No positive clock-skew allowance: consumers must not accept future checks.
	if (checked > now || checked < now - 5000 || until > checked + 5000)
		throw new Error('Stale eligibility');
	if (item.reason === 'NO_SUBSCRIPTION') {
		if (
			item.eligible ||
			[
				item.subscriptionId,
				item.version,
				item.plan,
				item.startsAt,
				item.expiresAt
			].some(field => field !== null)
		)
			throw new Error('Invalid absent subscription');
	} else {
		identifier(item.subscriptionId);
		version(item.version);
		if (!['TRIAL', 'EASY', 'HARD'].includes(String(item.plan)))
			throw new Error('Invalid plan');
		if (item.startsAt !== null) iso(item.startsAt);
		if (item.expiresAt !== null) iso(item.expiresAt);
	}
	if (item.eligible) {
		if (
			item.reason !== 'ELIGIBLE' ||
			!['EASY', 'HARD'].includes(String(item.plan)) ||
			item.startsAt === null ||
			item.expiresAt === null ||
			Date.parse(iso(item.startsAt)) > checked ||
			Date.parse(iso(item.expiresAt)) <= checked ||
			until <= now ||
			until > Date.parse(iso(item.expiresAt))
		)
			throw new Error('Invalid active period');
	} else if (item.reason === 'ELIGIBLE' || until !== checked)
		throw new Error('Invalid denial');
	return item as unknown as WidgetsEligibility;
}

export interface TransferEvent {
	schemaVersion: 1;
	eventType: typeof WINCRM_TRANSFER_EVENT;
	eventId: string;
	occurredAt: string;
	transferId: string;
	connectorId: string;
	generation: number;
	workspaceId: string;
	sourceId: string;
	originalSubscriptionId: string | null;
	originalSubscriptionVersion: string | null;
	originalPeriodStartsAt: string | null;
	originalDeadline: string | null;
}
export function assertTransferEvent(
	value: unknown,
	messageId?: string
): asserts value is TransferEvent {
	const item = record(value, [
		'schemaVersion',
		'eventType',
		'eventId',
		'occurredAt',
		'transferId',
		'connectorId',
		'generation',
		'workspaceId',
		'sourceId',
		'originalSubscriptionId',
		'originalSubscriptionVersion',
		'originalPeriodStartsAt',
		'originalDeadline'
	]);
	if (
		item.schemaVersion !== 1 ||
		item.eventType !== WINCRM_TRANSFER_EVENT ||
		(messageId !== undefined && item.eventId !== messageId)
	)
		throw new Error('Invalid transfer event');
	for (const key of [
		'eventId',
		'transferId',
		'connectorId',
		'workspaceId',
		'sourceId'
	])
		uuid(item[key]);
	iso(item.occurredAt);
	integer(item.generation);
	if (item.originalSubscriptionId !== null)
		identifier(item.originalSubscriptionId);
	if (item.originalSubscriptionVersion !== null)
		version(item.originalSubscriptionVersion);
	if (item.originalPeriodStartsAt !== null)
		iso(item.originalPeriodStartsAt);
	if (item.originalDeadline !== null) iso(item.originalDeadline);
}
