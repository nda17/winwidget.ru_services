import { createHash } from 'node:crypto';
export const WINCRM_TRANSFER_EVENT =
	'widgets.wincrm.lead-transfer.requested.v1';
export const LEAD_WIDGET_TYPES = [
	'WHEEL',
	'QUIZ',
	'CALLBACK',
	'TIMER',
	'STOP_OFFER',
	'CALCULATOR'
] as const;
export type WidgetLeadType = (typeof LEAD_WIDGET_TYPES)[number];
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
export function widgetType(value: unknown): WidgetLeadType {
	if (!LEAD_WIDGET_TYPES.includes(value as WidgetLeadType))
		throw new Error('Invalid widget type');
	return value as WidgetLeadType;
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

export const MAX_SNAPSHOT_BYTES = 256 * 1024;
const REDACTIONS = [
	'URL_USERINFO_REMOVED',
	'URL_QUERY_REMOVED',
	'URL_FRAGMENT_REMOVED',
	'URL_REJECTED'
] as const;
type Redaction = (typeof REDACTIONS)[number];
type QuizAnswer = {
	questionId: string;
	questionText: string | null;
	options: Array<{ id: string; text: string | null }>;
};
type CalculatorAnswer = {
	fieldId: string;
	fieldLabel: string;
	type: 'number' | 'select' | 'radio' | 'checkbox';
	value: number | string | string[];
	valueLabel: string;
};
export interface WidgetLeadSnapshotV1 {
	schemaVersion: 1;
	widget: {
		type: WidgetLeadType;
		id: string;
		name: string;
		publishedVersion: number;
	};
	lead: {
		id: string;
		createdAt: string;
		contactName: string | null;
		contactRaw: string | null;
		phoneRaw: string | null;
		phoneE164: string | null;
		email: string | null;
		pageUrl: string | null;
		redactions: Redaction[];
	};
	details:
		| { type: 'WHEEL'; bonus: string | null }
		| { type: 'QUIZ'; result: string | null; answers: QuizAnswer[] }
		| {
				type: 'CALLBACK';
				timeSlot: string | null;
				timezone: string | null;
		  }
		| { type: 'TIMER' | 'STOP_OFFER' }
		| {
				type: 'CALCULATOR';
				calculatedPrice: string;
				currency: string;
				answers: CalculatorAnswer[];
		  };
}

function list(value: unknown): unknown[] {
	if (!Array.isArray(value) || value.length > 20)
		throw new SnapshotError('PAYLOAD_SHAPE_UNSUPPORTED');
	return value;
}
function unique(values: string[]): void {
	if (new Set(values).size !== values.length)
		throw new SnapshotError('PAYLOAD_SHAPE_UNSUPPORTED');
}
function pageUrl(value: unknown): {
	pageUrl: string | null;
	redactions: Redaction[];
} {
	if (value === null || value === undefined || value === '')
		return { pageUrl: null, redactions: [] };
	try {
		if (
			typeof value !== 'string' ||
			value.length > 500 ||
			/[\u0000-\u0020\u007f<>]/u.test(value)
		)
			throw new Error();
		assertUnicode(value);
		const parsed = new URL(value);
		if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error();
		const redactions: Redaction[] = [];
		if (parsed.username || parsed.password)
			redactions.push('URL_USERINFO_REMOVED');
		if (parsed.search) redactions.push('URL_QUERY_REMOVED');
		if (parsed.hash) redactions.push('URL_FRAGMENT_REMOVED');
		parsed.username = '';
		parsed.password = '';
		parsed.search = '';
		parsed.hash = '';
		if (parsed.href.length > 500) throw new Error();
		return { pageUrl: parsed.href, redactions };
	} catch {
		return { pageUrl: null, redactions: ['URL_REJECTED'] };
	}
}

/** Validate durable JSON again before exposing it to a different service. */
export function assertWidgetLeadSnapshotV1(
	value: unknown
): asserts value is WidgetLeadSnapshotV1 {
	if (
		Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_SNAPSHOT_BYTES
	)
		throw new SnapshotError('PAYLOAD_TOO_LARGE');
	const payload = record(value, [
		'schemaVersion',
		'widget',
		'lead',
		'details'
	]);
	if (payload.schemaVersion !== 1)
		throw new Error('Invalid snapshot version');
	const widget = record(payload.widget, [
		'type',
		'id',
		'name',
		'publishedVersion'
	]);
	widgetType(widget.type);
	identifier(widget.id);
	plainText(widget.name, 200);
	integer(widget.publishedVersion);
	const lead = record(payload.lead, [
		'id',
		'createdAt',
		'contactName',
		'contactRaw',
		'phoneRaw',
		'phoneE164',
		'email',
		'pageUrl',
		'redactions'
	]);
	identifier(lead.id);
	iso(lead.createdAt);
	for (const key of ['contactName', 'contactRaw', 'phoneRaw']) {
		if (lead[key] !== null) plainText(lead[key], 200);
	}
	if (lead.email !== null) plainText(lead.email, 254);
	if (
		lead.phoneE164 !== null &&
		(typeof lead.phoneE164 !== 'string' ||
			!/^\+[1-9][0-9]{7,14}$/.test(lead.phoneE164) ||
			lead.phoneE164 !== lead.phoneRaw)
	)
		throw new Error('Invalid phone');
	if (
		!Array.isArray(lead.redactions) ||
		lead.redactions.length > 4 ||
		lead.redactions.some(item => !REDACTIONS.includes(item)) ||
		new Set(lead.redactions).size !== lead.redactions.length
	)
		throw new Error('Invalid redactions');
	if (lead.pageUrl !== null) {
		const parsed = pageUrl(lead.pageUrl);
		if (parsed.pageUrl !== lead.pageUrl || parsed.redactions.length)
			throw new Error('Unsafe page URL');
	}
	const details = record(payload.details);
	if (details.type !== widget.type)
		throw new Error('Invalid details binding');
	switch (details.type) {
		case 'WHEEL':
			record(details, ['type', 'bonus']);
			if (details.bonus !== null) plainText(details.bonus, 200);
			break;
		case 'CALLBACK':
			record(details, ['type', 'timeSlot', 'timezone']);
			for (const key of ['timeSlot', 'timezone'])
				if (details[key] !== null) plainText(details[key], 100);
			break;
		case 'TIMER':
		case 'STOP_OFFER':
			record(details, ['type']);
			break;
		case 'QUIZ': {
			record(details, ['type', 'result', 'answers']);
			if (details.result !== null) plainText(details.result, 10000);
			const ids = list(details.answers).map(raw => {
				const item = record(raw, [
					'questionId',
					'questionText',
					'options'
				]);
				if (item.questionText !== null)
					plainText(item.questionText, 10000);
				unique(
					list(item.options).map(rawOption => {
						const option = record(rawOption, ['id', 'text']);
						if (option.text !== null) plainText(option.text, 10000);
						return identifier(option.id, 1024);
					})
				);
				return identifier(item.questionId, 64);
			});
			unique(ids);
			break;
		}
		case 'CALCULATOR': {
			record(details, ['type', 'calculatedPrice', 'currency', 'answers']);
			if (
				typeof details.calculatedPrice !== 'string' ||
				!/^(0|[1-9][0-9]{0,11})\.[0-9]{2}$/.test(
					details.calculatedPrice
				) ||
				typeof details.currency !== 'string' ||
				!['RUB', 'EUR', 'USD'].includes(details.currency)
			)
				throw new Error('Invalid amount');
			unique(
				list(details.answers).map(raw => {
					const item = record(raw, [
						'fieldId',
						'fieldLabel',
						'type',
						'value',
						'valueLabel'
					]);
					plainText(item.fieldLabel, 100);
					plainText(item.valueLabel, 4096);
					if (item.type === 'number') {
						if (
							typeof item.value !== 'number' ||
							!Number.isFinite(item.value)
						)
							throw new Error('Invalid numeric answer');
					} else if (item.type === 'checkbox')
						unique(list(item.value).map(value => identifier(value, 64)));
					else if (item.type === 'select' || item.type === 'radio')
						identifier(item.value, 64);
					else throw new Error('Invalid field type');
					return identifier(item.fieldId, 64);
				})
			);
			break;
		}
		default:
			throw new Error('Invalid snapshot details');
	}
}

export function parseWidgetTransferEvent(
	value: unknown,
	messageId?: string
): TransferEvent {
	assertTransferEvent(value, messageId);
	return value;
}
export function parseWidgetLeadSnapshot(
	value: unknown
): WidgetLeadSnapshotV1 {
	assertWidgetLeadSnapshotV1(value);
	return value;
}
export const TRANSFER_CONSUMER = 'crm-intake.widget-transfer.v1';
export const TRANSFER_RETRY_MS = [5000, 30000, 120000] as const;
export const transferHash = (value: unknown): string =>
	createHash('sha256').update(canonical(value)).digest('hex');
function canonical(value: unknown): string {
	if (Array.isArray(value))
		return '[' + value.map(canonical).join(',') + ']';
	if (value && typeof value === 'object')
		return (
			'{' +
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
				.join(',') +
			'}'
		);
	return JSON.stringify(value);
}
