import {
	ADMIN_AUDIT_EVENT_TYPE,
	CAMPAIGN_EMAIL_REQUESTED_EVENT_TYPE,
	CAMPAIGN_SNAPSHOT_REQUESTED_EVENT_TYPE,
	CAMPAIGN_TELEGRAM_REQUESTED_EVENT_TYPE,
	CampaignsConsumerKind,
	NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE
} from './campaigns-messaging.constants';
import type { ConsumeMessage } from 'amqplib';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class InvalidCampaignsEventError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidCampaignsEventError';
	}
}

export interface CampaignSnapshotRequestedEvent {
	schemaVersion: 1;
	eventType: typeof CAMPAIGN_SNAPSHOT_REQUESTED_EVENT_TYPE;
	eventId: string;
	occurredAt: string;
	correlationId: string;
	campaignId: string;
}

export interface CampaignDeliveryOutcomeEvent {
	schemaVersion: 2;
	eventType: typeof NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE;
	eventId: string;
	occurredAt: string;
	correlationId: string;
	sourceEventId: string;
	sourceKind: 'campaign-email' | 'campaign-telegram';
	campaignId: string;
	deliveryId: string;
	dispatchGeneration: number;
	status: 'DELIVERED' | 'FAILED';
	failure: {
		normalizedCode: string;
		safeReason: string;
	} | null;
}

export interface CampaignNotificationRequestedEvent {
	schemaVersion: 2;
	eventType:
		| typeof CAMPAIGN_EMAIL_REQUESTED_EVENT_TYPE
		| typeof CAMPAIGN_TELEGRAM_REQUESTED_EVENT_TYPE;
	eventId: string;
	occurredAt: string;
	correlationId: string;
	campaignId: string;
	deliveryId: string;
	dispatchGeneration: number;
	reference: {
		type: 'campaign-delivery';
		id: string;
		aggregateId: string;
		dispatchGeneration: number;
	};
	destination: { email: string } | { telegramChatId: string };
	content: {
		subject: string;
		message: string;
	};
}

export interface AdminAuditEvent {
	schemaVersion: 1;
	eventType: typeof ADMIN_AUDIT_EVENT_TYPE;
	eventId: string;
	occurredAt: string;
	correlationId: string;
	actorId: string;
	action:
		| 'CAMPAIGN_CREATE'
		| 'CAMPAIGN_CANCEL'
		| 'CAMPAIGN_DELIVERY_RETRY';
	target: {
		campaignId: string;
		deliveryId?: string;
	};
	metadata: {
		channel?: 'EMAIL' | 'TELEGRAM' | 'BOTH';
		audience?: 'ALL' | 'ACTIVE_SUBSCRIBERS';
		recipientCount?: number;
		dispatchGeneration?: number;
	};
}

export type IncomingCampaignsEvent =
	| CampaignSnapshotRequestedEvent
	| CampaignDeliveryOutcomeEvent;

export interface ParsedCampaignsMessage {
	eventId: string;
	eventType: string;
	payload: IncomingCampaignsEvent;
	retryAttempt: number;
}

export function parseCampaignsMessage(
	kind: CampaignsConsumerKind,
	message: ConsumeMessage
): ParsedCampaignsMessage {
	if (message.content.length > 256 * 1024) {
		throw new InvalidCampaignsEventError('Event payload is too large');
	}
	let value: unknown;
	try {
		value = JSON.parse(message.content.toString('utf8'));
	} catch {
		throw new InvalidCampaignsEventError('Event payload is not JSON');
	}
	const payload =
		kind === 'snapshot'
			? parseSnapshotRequested(value)
			: parseDeliveryOutcome(value);
	const messageId =
		typeof message.properties.messageId === 'string'
			? message.properties.messageId
			: '';
	const messageType =
		typeof message.properties.type === 'string'
			? message.properties.type
			: '';
	if (messageId !== payload.eventId) {
		throw new InvalidCampaignsEventError(
			'AMQP messageId must equal payload eventId'
		);
	}
	if (messageType !== payload.eventType) {
		throw new InvalidCampaignsEventError(
			'AMQP type must equal payload eventType'
		);
	}
	const retryAttemptValue =
		message.properties.headers?.['x-retry-attempt'];
	const retryAttempt =
		typeof retryAttemptValue === 'number' &&
		Number.isInteger(retryAttemptValue) &&
		retryAttemptValue >= 0
			? retryAttemptValue
			: 0;
	return {
		eventId: payload.eventId,
		eventType: payload.eventType,
		payload,
		retryAttempt
	};
}

export function assertCampaignsPublishedEvent(
	value: unknown,
	eventType: string,
	messageId: string
): void {
	let payload:
		| CampaignSnapshotRequestedEvent
		| CampaignNotificationRequestedEvent
		| AdminAuditEvent;
	if (eventType === CAMPAIGN_SNAPSHOT_REQUESTED_EVENT_TYPE) {
		payload = parseSnapshotRequested(value);
	} else if (
		eventType === CAMPAIGN_EMAIL_REQUESTED_EVENT_TYPE ||
		eventType === CAMPAIGN_TELEGRAM_REQUESTED_EVENT_TYPE
	) {
		payload = parseNotificationRequested(value, eventType);
	} else if (eventType === ADMIN_AUDIT_EVENT_TYPE) {
		payload = parseAdminAudit(value);
	} else {
		throw new InvalidCampaignsEventError(
			`Campaigns cannot publish event type ${eventType}`
		);
	}
	if (payload.eventId !== messageId) {
		throw new InvalidCampaignsEventError(
			'Outbox messageId must equal payload eventId'
		);
	}
}

function parseSnapshotRequested(
	value: unknown
): CampaignSnapshotRequestedEvent {
	const record = getExactRecord(value, [
		'schemaVersion',
		'eventType',
		'eventId',
		'occurredAt',
		'correlationId',
		'campaignId'
	]);
	assertLiteral(record.schemaVersion, 1, 'schemaVersion');
	assertLiteral(
		record.eventType,
		CAMPAIGN_SNAPSHOT_REQUESTED_EVENT_TYPE,
		'eventType'
	);
	assertUuid(record.eventId, 'eventId');
	assertIsoDate(record.occurredAt, 'occurredAt');
	assertUuid(record.correlationId, 'correlationId');
	assertUuid(record.campaignId, 'campaignId');
	return record as unknown as CampaignSnapshotRequestedEvent;
}

function parseDeliveryOutcome(
	value: unknown
): CampaignDeliveryOutcomeEvent {
	const record = getExactRecord(value, [
		'schemaVersion',
		'eventType',
		'eventId',
		'occurredAt',
		'correlationId',
		'sourceEventId',
		'sourceKind',
		'campaignId',
		'deliveryId',
		'dispatchGeneration',
		'status',
		'failure'
	]);
	assertLiteral(record.schemaVersion, 2, 'schemaVersion');
	assertLiteral(
		record.eventType,
		NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
		'eventType'
	);
	assertUuid(record.eventId, 'eventId');
	assertIsoDate(record.occurredAt, 'occurredAt');
	assertUuid(record.correlationId, 'correlationId');
	assertUuid(record.sourceEventId, 'sourceEventId');
	assertOneOf(
		record.sourceKind,
		['campaign-email', 'campaign-telegram'],
		'sourceKind'
	);
	assertUuid(record.campaignId, 'campaignId');
	assertUuid(record.deliveryId, 'deliveryId');
	assertPositiveInteger(record.dispatchGeneration, 'dispatchGeneration');
	assertOneOf(record.status, ['DELIVERED', 'FAILED'], 'status');
	if (record.status === 'DELIVERED') {
		if (record.failure !== null) {
			throw new InvalidCampaignsEventError(
				'Delivered outcome failure must be null'
			);
		}
	} else {
		const failure = getExactRecord(record.failure, [
			'normalizedCode',
			'safeReason'
		]);
		assertBoundedString(failure.normalizedCode, 'normalizedCode', 255);
		assertBoundedString(failure.safeReason, 'safeReason', 2000);
	}
	return record as unknown as CampaignDeliveryOutcomeEvent;
}

function parseNotificationRequested(
	value: unknown,
	eventType:
		| typeof CAMPAIGN_EMAIL_REQUESTED_EVENT_TYPE
		| typeof CAMPAIGN_TELEGRAM_REQUESTED_EVENT_TYPE
): CampaignNotificationRequestedEvent {
	const record = getExactRecord(value, [
		'schemaVersion',
		'eventType',
		'eventId',
		'occurredAt',
		'correlationId',
		'campaignId',
		'deliveryId',
		'dispatchGeneration',
		'reference',
		'destination',
		'content'
	]);
	assertLiteral(record.schemaVersion, 2, 'schemaVersion');
	assertLiteral(record.eventType, eventType, 'eventType');
	assertUuid(record.eventId, 'eventId');
	assertIsoDate(record.occurredAt, 'occurredAt');
	assertUuid(record.correlationId, 'correlationId');
	assertUuid(record.campaignId, 'campaignId');
	assertUuid(record.deliveryId, 'deliveryId');
	assertPositiveInteger(record.dispatchGeneration, 'dispatchGeneration');
	const reference = getExactRecord(record.reference, [
		'type',
		'id',
		'aggregateId',
		'dispatchGeneration'
	]);
	assertLiteral(reference.type, 'campaign-delivery', 'reference.type');
	assertLiteral(reference.id, record.deliveryId, 'reference.id');
	assertLiteral(
		reference.aggregateId,
		record.campaignId,
		'reference.aggregateId'
	);
	assertLiteral(
		reference.dispatchGeneration,
		record.dispatchGeneration,
		'reference.dispatchGeneration'
	);
	const destination =
		eventType === CAMPAIGN_EMAIL_REQUESTED_EVENT_TYPE
			? getExactRecord(record.destination, ['email'])
			: getExactRecord(record.destination, ['telegramChatId']);
	assertBoundedString(
		eventType === CAMPAIGN_EMAIL_REQUESTED_EVENT_TYPE
			? destination.email
			: destination.telegramChatId,
		'destination',
		1000
	);
	const content = getExactRecord(record.content, ['subject', 'message']);
	assertBoundedString(content.subject, 'subject', 120, 3);
	assertBoundedString(content.message, 'message', 5000, 10);
	return record as unknown as CampaignNotificationRequestedEvent;
}

function parseAdminAudit(value: unknown): AdminAuditEvent {
	const record = getExactRecord(value, [
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
	assertLiteral(record.schemaVersion, 1, 'schemaVersion');
	assertLiteral(record.eventType, ADMIN_AUDIT_EVENT_TYPE, 'eventType');
	assertUuid(record.eventId, 'eventId');
	assertIsoDate(record.occurredAt, 'occurredAt');
	assertUuid(record.correlationId, 'correlationId');
	assertBoundedString(record.actorId, 'actorId', 255);
	assertOneOf(
		record.action,
		['CAMPAIGN_CREATE', 'CAMPAIGN_CANCEL', 'CAMPAIGN_DELIVERY_RETRY'],
		'action'
	);
	const isRetry = record.action === 'CAMPAIGN_DELIVERY_RETRY';
	const target = getExactRecord(
		record.target,
		isRetry ? ['campaignId', 'deliveryId'] : ['campaignId']
	);
	assertUuid(target.campaignId, 'target.campaignId');
	if (isRetry) assertUuid(target.deliveryId, 'target.deliveryId');
	const metadataKeys =
		record.action === 'CAMPAIGN_CREATE'
			? ['channel', 'audience']
			: record.action === 'CAMPAIGN_CANCEL'
				? ['recipientCount']
				: ['channel', 'dispatchGeneration'];
	const metadata = getExactRecord(record.metadata, metadataKeys);
	if (record.action === 'CAMPAIGN_CREATE') {
		assertOneOf(
			metadata.channel,
			['EMAIL', 'TELEGRAM', 'BOTH'],
			'metadata.channel'
		);
		assertOneOf(
			metadata.audience,
			['ALL', 'ACTIVE_SUBSCRIBERS'],
			'metadata.audience'
		);
	} else if (record.action === 'CAMPAIGN_CANCEL') {
		assertNonNegativeInteger(
			metadata.recipientCount,
			'metadata.recipientCount'
		);
	} else {
		assertOneOf(
			metadata.channel,
			['EMAIL', 'TELEGRAM'],
			'metadata.channel'
		);
		assertPositiveInteger(
			metadata.dispatchGeneration,
			'metadata.dispatchGeneration'
		);
	}
	return record as unknown as AdminAuditEvent;
}

function getExactRecord(
	value: unknown,
	keys: readonly string[]
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new InvalidCampaignsEventError('Expected an object');
	}
	const record = value as Record<string, unknown>;
	const actual = Object.keys(record).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new InvalidCampaignsEventError('Object contains invalid keys');
	}
	return record;
}

function assertUuid(
	value: unknown,
	field: string
): asserts value is string {
	if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
		throw new InvalidCampaignsEventError(`${field} must be a UUID`);
	}
}

function assertIsoDate(
	value: unknown,
	field: string
): asserts value is string {
	if (
		typeof value !== 'string' ||
		!value.includes('T') ||
		!Number.isFinite(Date.parse(value))
	) {
		throw new InvalidCampaignsEventError(
			`${field} must be an ISO timestamp`
		);
	}
}

function assertLiteral<T>(
	value: unknown,
	expected: T,
	field: string
): asserts value is T {
	if (value !== expected) {
		throw new InvalidCampaignsEventError(`${field} has an invalid value`);
	}
}

function assertOneOf<T extends string>(
	value: unknown,
	values: readonly T[],
	field: string
): asserts value is T {
	if (typeof value !== 'string' || !values.includes(value as T)) {
		throw new InvalidCampaignsEventError(`${field} has an invalid value`);
	}
}

function assertBoundedString(
	value: unknown,
	field: string,
	max: number,
	min = 1
): asserts value is string {
	if (
		typeof value !== 'string' ||
		value.trim().length < min ||
		value.length > max
	) {
		throw new InvalidCampaignsEventError(`${field} is invalid`);
	}
}

function assertPositiveInteger(
	value: unknown,
	field: string
): asserts value is number {
	if (!Number.isInteger(value) || Number(value) < 1) {
		throw new InvalidCampaignsEventError(
			`${field} must be a positive integer`
		);
	}
}

function assertNonNegativeInteger(
	value: unknown,
	field: string
): asserts value is number {
	if (!Number.isInteger(value) || Number(value) < 0) {
		throw new InvalidCampaignsEventError(
			`${field} must be a non-negative integer`
		);
	}
}
