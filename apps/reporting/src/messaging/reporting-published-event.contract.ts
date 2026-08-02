import {
	ADMIN_AUDIT_EVENT_TYPE,
	DAILY_SUMMARY_NOTIFICATION_EVENT_TYPE,
	REPORTING_ACCEPTED_ROUTING_KEYS,
	REPORTING_CONSUMER_KINDS,
	REPORTING_RETRY_DELAYS_MS,
	ReportingConsumerKind,
	getReportingDeadLetterRoutingKey,
	getReportingManualRetryRoutingKey,
	getReportingRetryRoutingKey
} from './reporting-messaging.constants';
import {
	ReportingSourceEventType,
	parseNotificationDeliveryOutcome,
	parseReportingSourceEvent
} from '../projections/reporting-event.contract';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CONTEXT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface DailySummaryNotificationRequestedEvent {
	schemaVersion: 1;
	eventType: typeof DAILY_SUMMARY_NOTIFICATION_EVENT_TYPE;
	reference: {
		type: 'daily-summary-job';
		id: string;
	};
	destination: {
		telegramChatId: string;
		messageThreadId: number;
	};
	content: {
		text: string;
	};
}

export const REPORTING_SETTINGS_AUDIT_FIELDS = [
	'enabled',
	'destinationChatId',
	'messageThreadId',
	'scheduleTime',
	'timezone'
] as const;

export type ReportingSettingsAuditField =
	(typeof REPORTING_SETTINGS_AUDIT_FIELDS)[number];

export interface ReportingSettingsAdminAuditEvent {
	schemaVersion: 1;
	eventType: typeof ADMIN_AUDIT_EVENT_TYPE;
	eventId: string;
	occurredAt: string;
	correlationId: string;
	actorId: string;
	action: 'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE';
	target: { reportingSettingsId: 'daily-summary' };
	metadata: { changedFields: ReportingSettingsAuditField[] };
}

export interface ReportingDeliveryRetryAdminAuditEvent {
	schemaVersion: 1;
	eventType: typeof ADMIN_AUDIT_EVENT_TYPE;
	eventId: string;
	occurredAt: string;
	correlationId: string;
	actorId: string;
	action: 'REPORTING_DELIVERY_RETRY';
	target: {
		eventId: string;
		consumerKind: ReportingConsumerKind;
	};
	metadata: Record<string, never>;
}

export type ReportingAdminAuditEvent =
	| ReportingSettingsAdminAuditEvent
	| ReportingDeliveryRetryAdminAuditEvent;

export interface ReportingConsumerOutboxContract {
	exchange: 'RETRY' | 'MANUAL_RETRY' | 'DEAD_LETTER';
	eventType: string;
	routingKey: string;
	messageId: string;
	payload: unknown;
	headers: unknown;
}

export function assertReportingConsumerOutboxEvent(
	event: ReportingConsumerOutboxContract
): void {
	if (!UUID_PATTERN.test(event.messageId)) {
		throw new Error('Reporting consumer Outbox messageId is invalid');
	}
	const kind = REPORTING_CONSUMER_KINDS.find(candidate =>
		REPORTING_ACCEPTED_ROUTING_KEYS[candidate].some(
			acceptedEventType => acceptedEventType === event.eventType
		)
	);
	if (!kind) {
		throw new Error('Reporting consumer Outbox eventType is invalid');
	}
	if (kind === 'deliveryOutcome') {
		parseNotificationDeliveryOutcome(event.payload);
	} else {
		const payload = parseReportingSourceEvent(
			event.payload,
			event.eventType as ReportingSourceEventType
		);
		if (payload.eventId !== event.messageId) {
			throw new Error(
				'Reporting projection Outbox payload must equal messageId'
			);
		}
	}

	const headers = exactRecord(
		event.headers,
		event.exchange === 'MANUAL_RETRY'
			? [
					'x-correlation-id',
					'x-causation-id',
					'x-retry-attempt',
					'x-retry-cycle',
					'x-manual-retry'
				]
			: [
					'x-correlation-id',
					'x-causation-id',
					'x-retry-attempt',
					'x-retry-cycle',
					'x-last-error'
				]
	);
	if (
		typeof headers['x-correlation-id'] !== 'string' ||
		!SAFE_CONTEXT_ID.test(headers['x-correlation-id']) ||
		headers['x-causation-id'] !== event.messageId ||
		!Number.isInteger(headers['x-retry-attempt']) ||
		Number(headers['x-retry-attempt']) < 0 ||
		Number(headers['x-retry-attempt']) >
			REPORTING_RETRY_DELAYS_MS.length ||
		!Number.isInteger(headers['x-retry-cycle']) ||
		Number(headers['x-retry-cycle']) < 0 ||
		Number(headers['x-retry-cycle']) > 1_000_000
	) {
		throw new Error('Reporting consumer Outbox headers are invalid');
	}

	if (event.exchange === 'MANUAL_RETRY') {
		if (
			event.routingKey !== getReportingManualRetryRoutingKey(kind) ||
			headers['x-retry-attempt'] !== 0 ||
			Number(headers['x-retry-cycle']) < 1 ||
			headers['x-manual-retry'] !== true
		) {
			throw new Error('Reporting manual retry Outbox route is invalid');
		}
		return;
	}
	if (
		typeof headers['x-last-error'] !== 'string' ||
		!headers['x-last-error'] ||
		headers['x-last-error'].length > 1000
	) {
		throw new Error('Reporting consumer Outbox error header is invalid');
	}
	if (event.exchange === 'RETRY') {
		const attempt = Number(headers['x-retry-attempt']);
		if (
			attempt < 1 ||
			event.routingKey !== getReportingRetryRoutingKey(kind, attempt - 1)
		) {
			throw new Error('Reporting retry Outbox route is invalid');
		}
		return;
	}
	if (event.routingKey !== getReportingDeadLetterRoutingKey(kind)) {
		throw new Error('Reporting dead-letter Outbox route is invalid');
	}
}

export function assertDailySummaryNotificationRequestedEvent(
	value: unknown,
	messageId: string
): asserts value is DailySummaryNotificationRequestedEvent {
	const payload = exactRecord(value, [
		'schemaVersion',
		'eventType',
		'reference',
		'destination',
		'content'
	]);
	if (
		payload.schemaVersion !== 1 ||
		payload.eventType !== DAILY_SUMMARY_NOTIFICATION_EVENT_TYPE
	) {
		throw new Error('Invalid daily summary notification contract version');
	}
	const reference = exactRecord(payload.reference, ['type', 'id']);
	if (
		reference.type !== 'daily-summary-job' ||
		reference.id !== messageId ||
		typeof reference.id !== 'string' ||
		!UUID_PATTERN.test(reference.id)
	) {
		throw new Error('Daily summary reference must equal Outbox messageId');
	}
	const destination = exactRecord(payload.destination, [
		'telegramChatId',
		'messageThreadId'
	]);
	if (
		typeof destination.telegramChatId !== 'string' ||
		!destination.telegramChatId.trim() ||
		destination.telegramChatId.length > 255 ||
		!Number.isInteger(destination.messageThreadId) ||
		Number(destination.messageThreadId) < 1
	) {
		throw new Error('Daily summary destination is invalid');
	}
	const content = exactRecord(payload.content, ['text']);
	if (
		typeof content.text !== 'string' ||
		!content.text ||
		content.text.length > 10_000
	) {
		throw new Error('Daily summary content is invalid');
	}
}

export function assertReportingAdminAuditEvent(
	value: unknown,
	messageId: string
): asserts value is ReportingAdminAuditEvent {
	const payload = exactRecord(value, [
		'schemaVersion',
		'eventType',
		'eventId',
		'occurredAt',
		'correlationId',
		'actorId',
		'action',
		'target',
		'metadata'
	]);
	if (
		payload.schemaVersion !== 1 ||
		payload.eventType !== ADMIN_AUDIT_EVENT_TYPE ||
		payload.eventId !== messageId ||
		typeof payload.eventId !== 'string' ||
		!UUID_PATTERN.test(payload.eventId) ||
		![
			'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE',
			'REPORTING_DELIVERY_RETRY'
		].includes(String(payload.action))
	) {
		throw new Error('Invalid Reporting admin audit contract');
	}
	assertNonEmptyBoundedString(payload.actorId, 'actorId', 255);
	if (
		typeof payload.correlationId !== 'string' ||
		!SAFE_CONTEXT_ID.test(payload.correlationId)
	) {
		throw new Error('Reporting admin audit correlationId is invalid');
	}
	if (
		typeof payload.occurredAt !== 'string' ||
		!Number.isFinite(Date.parse(payload.occurredAt))
	) {
		throw new Error('Reporting admin audit occurredAt is invalid');
	}
	if (payload.action === 'REPORTING_DELIVERY_RETRY') {
		const target = exactRecord(payload.target, [
			'eventId',
			'consumerKind'
		]);
		if (
			typeof target.eventId !== 'string' ||
			!UUID_PATTERN.test(target.eventId) ||
			typeof target.consumerKind !== 'string' ||
			!REPORTING_CONSUMER_KINDS.includes(
				target.consumerKind as ReportingConsumerKind
			)
		) {
			throw new Error('Reporting delivery retry audit target is invalid');
		}
		exactRecord(payload.metadata, []);
		return;
	}
	const target = exactRecord(payload.target, ['reportingSettingsId']);
	if (target.reportingSettingsId !== 'daily-summary') {
		throw new Error('Reporting admin audit target is invalid');
	}
	const metadata = exactRecord(payload.metadata, ['changedFields']);
	if (
		!Array.isArray(metadata.changedFields) ||
		metadata.changedFields.length < 1 ||
		metadata.changedFields.length > REPORTING_SETTINGS_AUDIT_FIELDS.length
	) {
		throw new Error('Reporting admin audit changedFields are invalid');
	}
	const fields = metadata.changedFields;
	if (
		fields.some(
			field =>
				typeof field !== 'string' ||
				!REPORTING_SETTINGS_AUDIT_FIELDS.includes(
					field as ReportingSettingsAuditField
				)
		) ||
		new Set(fields).size !== fields.length ||
		fields.join(',') !== [...fields].sort().join(',')
	) {
		throw new Error(
			'Reporting admin audit changedFields must be sorted and unique'
		);
	}
}

function assertNonEmptyBoundedString(
	value: unknown,
	field: string,
	maxLength: number
): asserts value is string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		value.length > maxLength
	) {
		throw new Error(`Reporting admin audit ${field} is invalid`);
	}
}

function exactRecord(
	value: unknown,
	keys: readonly string[]
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Expected an object');
	}
	const record = value as Record<string, unknown>;
	const actual = Object.keys(record).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new Error('Object contains invalid keys');
	}
	return record;
}
