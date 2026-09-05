import {
	WidgetsOutboxEvent,
	WidgetsOutboxExchange
} from '@prisma/widgets-client';
import {
	assertTransferEvent,
	WINCRM_TRANSFER_EVENT
} from '../wincrm/widgets-wincrm.contract';
import {
	BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE,
	IDENTITY_USER_CHANGED_EVENT_TYPE,
	parseWidgetsProjectionEvent
} from '../projections/widgets-projection.contract';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTEXT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const WIDGET_TYPES = [
	'WHEEL',
	'QUIZ',
	'CALLBACK',
	'TIMER',
	'STOP_OFFER',
	'AI_CONSULTANT',
	'CALCULATOR'
] as const;
const REPORTING_WIDGET_TYPES = [
	'wheel',
	'quiz',
	'callback',
	'countdownTimer',
	'stopOffer',
	'aiConsultant',
	'calculator'
] as const;
const REPORTING_LEAD_WIDGET_TYPES = [
	'wheel',
	'quiz',
	'callback',
	'countdownTimer',
	'stopOffer',
	'calculator'
] as const;
const LEAD_SOURCES = [
	'widget',
	'quiz',
	'callback',
	'countdown-timer',
	'stop-offer',
	'calculator'
] as const;
const LIMIT_ENTITY_TYPES = [
	'wheel',
	'quiz',
	'callback',
	'timer',
	'stop-offer',
	'calculator'
] as const;
const LEAD_INTEGRATIONS = [
	'email',
	'telegram',
	'webhook',
	'bitrix24',
	'amo-crm'
] as const;
const PROVIDER_INTEGRATIONS = ['webhook', 'bitrix24', 'amo-crm'] as const;
const ADMIN_ACTIONS = [
	'WIDGET_UPDATE',
	'WIDGET_PUBLISH',
	'WIDGET_VERSION_RESTORE',
	'WIDGET_CLONE',
	'WIDGET_DRAFT_DISCARD',
	'WIDGET_BUTTON_IMAGE_UPDATE',
	'WIDGET_DELETE',
	'WIDGET_DELIVERY_RETRY',
	'WIDGET_DELIVERY_CLOSE'
] as const;
const FORBIDDEN_PAYLOAD_KEYS = new Set([
	'amocrmtoken',
	'apikey',
	'authorization',
	'bitrix24webhookurl',
	'databaseurl',
	'password',
	'refreshtoken',
	'secret',
	'secretkey',
	'token',
	'webhookurl'
]);

type JsonRecord = Record<string, unknown>;

export function assertWidgetsOutboxContract(
	event: WidgetsOutboxEvent
): void {
	assertUuid(event.messageId, 'Outbox messageId');
	assertBoundedString(event.eventType, 'Outbox eventType', 255);
	assertBoundedString(event.routingKey, 'Outbox routingKey', 255);
	const payload = exactRecord(event.payload, undefined, 'Outbox payload');
	if (payload.eventType !== event.eventType) {
		throw new Error('Outbox eventType does not match payload');
	}
	assertHeaders(event.headers);
	assertNoSecrets(payload);

	switch (event.eventType) {
		case WINCRM_TRANSFER_EVENT:
			assertTransferEvent(payload, event.messageId);
			assertEventsRoute(event, WINCRM_TRANSFER_EVENT);
			return;
		case IDENTITY_USER_CHANGED_EVENT_TYPE:
			parseWidgetsProjectionEvent(
				payload,
				IDENTITY_USER_CHANGED_EVENT_TYPE
			);
			assertConsumerRoute(event, 'identity');
			return;
		case BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE:
			parseWidgetsProjectionEvent(
				payload,
				BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE
			);
			assertConsumerRoute(event, 'entitlement');
			return;
		case 'lead.integration.requested.v2': {
			const integration = assertLeadIntegration(payload);
			if (isProvider(integration)) {
				assertConsumerRoute(event, integration);
			} else {
				assertEventsRoute(event, `lead.integration.${integration}.v2`);
			}
			return;
		}
		case 'lead.limit.reached.email.v2':
			assertLimitEvent(payload, 'email');
			assertEventsRoute(event, event.eventType);
			return;
		case 'lead.limit.reached.telegram.v2':
			assertLimitEvent(payload, 'telegram');
			assertEventsRoute(event, event.eventType);
			return;
		case 'admin.audit.event.v1':
			assertAdminAudit(payload, event.messageId);
			assertEventsRoute(event, 'admin.audit.widgets.v1');
			return;
		case 'widgets.widget.changed.v1':
			assertReportingEvent(payload, event.messageId, 'widget');
			assertEventsRoute(event, event.eventType);
			return;
		case 'widgets.lead.changed.v1':
			assertReportingEvent(payload, event.messageId, 'lead');
			assertEventsRoute(event, event.eventType);
			return;
		default:
			throw new Error(
				`Unsupported Widgets Outbox eventType ${event.eventType}`
			);
	}
}

function assertLeadIntegration(
	payload: JsonRecord
): (typeof LEAD_INTEGRATIONS)[number] {
	exactRecord(
		payload,
		[
			'schemaVersion',
			'eventType',
			'integration',
			'source',
			'entity',
			'lead',
			'destination'
		],
		'lead integration payload'
	);
	if (
		payload.schemaVersion !== 2 ||
		payload.eventType !== 'lead.integration.requested.v2'
	) {
		throw new Error('Invalid lead integration contract version');
	}
	assertOneOf(payload.integration, LEAD_INTEGRATIONS, 'integration');
	assertOneOf(payload.source, LEAD_SOURCES, 'source');
	const entity = exactRecord(
		payload.entity,
		['id', 'name'],
		'lead integration entity'
	);
	assertIdentifier(entity.id, 'entity.id');
	assertBoundedString(entity.name, 'entity.name');
	const lead = exactRecord(
		payload.lead,
		[
			'id',
			'createdAt',
			'contact?',
			'name?',
			'phone?',
			'email?',
			'bonus?',
			'result?',
			'timeSlot?',
			'timezone?',
			'actionLabel?',
			'actionValue?',
			'calculatedPrice?',
			'currency?',
			'answers?',
			'url?'
		],
		'lead integration lead'
	);
	assertIdentifier(lead.id, 'lead.id');
	assertIsoDate(lead.createdAt, 'lead.createdAt');
	for (const key of [
		'contact',
		'name',
		'phone',
		'email',
		'bonus',
		'result',
		'timeSlot',
		'timezone',
		'actionLabel',
		'actionValue',
		'calculatedPrice',
		'currency',
		'url'
	]) {
		assertOptionalString(lead[key], `lead.${key}`);
	}

	const destination = exactRecord(
		payload.destination,
		undefined,
		'lead integration destination'
	);
	if (payload.integration === 'email') {
		exactRecord(destination, ['email'], 'lead integration destination');
		assertBoundedString(destination.email, 'destination.email');
	} else if (payload.integration === 'telegram') {
		exactRecord(
			destination,
			['telegramChatId'],
			'lead integration destination'
		);
		assertBoundedString(
			destination.telegramChatId,
			'destination.telegramChatId'
		);
	} else {
		exactRecord(
			destination,
			['credentialRef'],
			'lead integration destination'
		);
		assertUuid(destination.credentialRef, 'destination.credentialRef');
	}
	return payload.integration;
}

function assertLimitEvent(
	payload: JsonRecord,
	destinationKind: 'email' | 'telegram'
): void {
	exactRecord(
		payload,
		['schemaVersion', 'eventType', 'entity', 'limit', 'destination'],
		'limit payload'
	);
	if (
		payload.schemaVersion !== 2 ||
		!Number.isInteger(payload.limit) ||
		Number(payload.limit) < 1 ||
		Number(payload.limit) > 2_147_483_647
	) {
		throw new Error('Invalid limit event contract');
	}
	const entity = exactRecord(
		payload.entity,
		['id', 'name', 'type'],
		'limit entity'
	);
	assertIdentifier(entity.id, 'entity.id');
	assertBoundedString(entity.name, 'entity.name');
	assertOneOf(entity.type, LIMIT_ENTITY_TYPES, 'entity.type');
	const destination = exactRecord(
		payload.destination,
		destinationKind === 'email' ? ['email'] : ['telegramChatId'],
		'limit destination'
	);
	assertBoundedString(
		destinationKind === 'email'
			? destination.email
			: destination.telegramChatId,
		`destination.${destinationKind === 'email' ? 'email' : 'telegramChatId'}`
	);
}

function assertAdminAudit(payload: JsonRecord, messageId: string): void {
	exactRecord(
		payload,
		[
			'schemaVersion',
			'eventType',
			'eventId',
			'occurredAt',
			'correlationId',
			'actorId',
			'action',
			'target',
			'metadata'
		],
		'admin audit payload'
	);
	if (
		payload.schemaVersion !== 1 ||
		payload.eventType !== 'admin.audit.event.v1'
	) {
		throw new Error('Invalid admin audit contract version');
	}
	assertUuid(payload.eventId, 'admin audit eventId');
	if (payload.eventId !== messageId) {
		throw new Error('Admin audit eventId must equal Outbox messageId');
	}
	assertIsoDate(payload.occurredAt, 'admin audit occurredAt');
	if (
		typeof payload.correlationId !== 'string' ||
		!CONTEXT_ID_PATTERN.test(payload.correlationId)
	) {
		throw new Error('Invalid admin audit correlationId');
	}
	assertIdentifier(payload.actorId, 'admin audit actorId');
	assertOneOf(payload.action, ADMIN_ACTIONS, 'admin audit action');
	const action = payload.action;
	const deliveryAction =
		action === 'WIDGET_DELIVERY_RETRY' ||
		action === 'WIDGET_DELIVERY_CLOSE';
	const target = exactRecord(
		payload.target,
		deliveryAction
			? ['widgetId', 'widgetType', 'ownerId', 'failureId', 'integration']
			: ['widgetId', 'widgetType', 'ownerId'],
		'admin audit target'
	);
	assertIdentifier(target.widgetId, 'target.widgetId');
	assertIdentifier(target.ownerId, 'target.ownerId');
	assertOneOf(target.widgetType, WIDGET_TYPES, 'target.widgetType');
	if (deliveryAction) {
		assertUuid(target.failureId, 'target.failureId');
		assertOneOf(
			target.integration,
			PROVIDER_INTEGRATIONS,
			'target.integration'
		);
	}
	const metadata = exactRecord(
		payload.metadata,
		undefined,
		'admin audit metadata'
	);
	switch (action) {
		case 'WIDGET_UPDATE': {
			exactRecord(metadata, ['changedFields'], 'admin audit metadata');
			if (
				!Array.isArray(metadata.changedFields) ||
				metadata.changedFields.length < 1 ||
				metadata.changedFields.length > 100 ||
				metadata.changedFields.some(
					field =>
						typeof field !== 'string' || !field || field.length > 100
				) ||
				new Set(metadata.changedFields).size !==
					metadata.changedFields.length
			) {
				throw new Error('Invalid admin audit changedFields');
			}
			break;
		}
		case 'WIDGET_PUBLISH':
		case 'WIDGET_VERSION_RESTORE':
			exactRecord(metadata, ['version'], 'admin audit metadata');
			assertPositiveInteger(metadata.version, 'metadata.version');
			break;
		case 'WIDGET_CLONE':
			exactRecord(metadata, ['sourceWidgetId'], 'admin audit metadata');
			assertIdentifier(metadata.sourceWidgetId, 'metadata.sourceWidgetId');
			break;
		case 'WIDGET_BUTTON_IMAGE_UPDATE':
			exactRecord(metadata, ['imagePresent'], 'admin audit metadata');
			if (typeof metadata.imagePresent !== 'boolean') {
				throw new Error('Invalid admin audit imagePresent');
			}
			break;
		case 'WIDGET_DELIVERY_CLOSE':
			exactRecord(
				metadata,
				['commentPresent', 'commentLength'],
				'admin audit metadata'
			);
			if (metadata.commentPresent !== true) {
				throw new Error('Invalid admin audit commentPresent');
			}
			assertPositiveInteger(
				metadata.commentLength,
				'metadata.commentLength',
				1_000
			);
			break;
		default:
			exactRecord(metadata, [], 'admin audit metadata');
	}
}

function assertReportingEvent(
	payload: JsonRecord,
	messageId: string,
	kind: 'widget' | 'lead'
): void {
	exactRecord(
		payload,
		[
			'schemaVersion',
			'eventType',
			'eventId',
			'aggregateId',
			'aggregateVersion',
			'sourceSequence',
			'occurredAt',
			'tombstone',
			'state'
		],
		'Reporting event'
	);
	if (payload.schemaVersion !== 1) {
		throw new Error('Invalid Reporting event contract version');
	}
	assertUuid(payload.eventId, 'Reporting eventId');
	if (payload.eventId !== messageId) {
		throw new Error('Reporting eventId must equal Outbox messageId');
	}
	assertNamespacedAggregateId(
		payload.aggregateId,
		kind === 'widget'
			? REPORTING_WIDGET_TYPES
			: REPORTING_LEAD_WIDGET_TYPES
	);
	assertPositiveBigint(payload.aggregateVersion, 'aggregateVersion');
	assertPositiveBigint(payload.sourceSequence, 'sourceSequence');
	assertIsoDate(payload.occurredAt, 'occurredAt');
	if (typeof payload.tombstone !== 'boolean') {
		throw new Error('Reporting tombstone must be a boolean');
	}
	if (payload.tombstone) {
		if (payload.state !== null) {
			throw new Error('Reporting tombstone state must be null');
		}
		return;
	}
	if (payload.state === null) {
		throw new Error('Reporting non-tombstone state is required');
	}
	const state = exactRecord(
		payload.state,
		kind === 'widget'
			? [
					'id',
					'userId',
					'widgetType',
					'isActive',
					'hasInstallDomain',
					'createdAt'
				]
			: ['id', 'widgetId', 'widgetType', 'createdAt'],
		'Reporting state'
	);
	assertIdentifier(state.id, 'state.id');
	assertOneOf(
		state.widgetType,
		kind === 'widget'
			? REPORTING_WIDGET_TYPES
			: REPORTING_LEAD_WIDGET_TYPES,
		'state.widgetType'
	);
	assertIsoDate(state.createdAt, 'state.createdAt');
	if (kind === 'widget') {
		assertIdentifier(state.userId, 'state.userId');
		if (
			typeof state.isActive !== 'boolean' ||
			typeof state.hasInstallDomain !== 'boolean'
		) {
			throw new Error('Invalid Reporting widget booleans');
		}
	} else {
		assertIdentifier(state.widgetId, 'state.widgetId');
	}
}

function assertConsumerRoute(
	event: WidgetsOutboxEvent,
	kind: 'identity' | 'entitlement' | (typeof PROVIDER_INTEGRATIONS)[number]
): void {
	switch (event.exchange) {
		case WidgetsOutboxExchange.EVENTS: {
			const expected =
				kind === 'identity'
					? IDENTITY_USER_CHANGED_EVENT_TYPE
					: kind === 'entitlement'
						? BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE
						: `lead.integration.${kind}.v2`;
			if (event.routingKey !== expected) {
				throw new Error('Widgets EVENTS routing key is invalid');
			}
			return;
		}
		case WidgetsOutboxExchange.RETRY:
			if (
				!new RegExp(`^${kind}\\.retry\\.[1-3]$`).test(event.routingKey)
			) {
				throw new Error('Widgets RETRY routing key is invalid');
			}
			return;
		case WidgetsOutboxExchange.MANUAL_RETRY:
			if (event.routingKey !== `${kind}.manual-retry`) {
				throw new Error('Widgets MANUAL_RETRY routing key is invalid');
			}
			return;
		case WidgetsOutboxExchange.DEAD_LETTER:
			if (event.routingKey !== `widgets.${kind}.dead-letter`) {
				throw new Error('Widgets DEAD_LETTER routing key is invalid');
			}
	}
}

function assertEventsRoute(
	event: WidgetsOutboxEvent,
	routingKey: string
): void {
	if (
		event.exchange !== WidgetsOutboxExchange.EVENTS ||
		event.routingKey !== routingKey
	) {
		throw new Error('Widgets event must use its canonical EVENTS route');
	}
}

function assertHeaders(value: unknown): void {
	const headers = exactRecord(value, undefined, 'Outbox headers');
	if (Object.keys(headers).length > 50) {
		throw new Error('Outbox headers contain too many fields');
	}
	for (const [key, item] of Object.entries(headers)) {
		if (!/^[a-z0-9-]{1,100}$/i.test(key)) {
			throw new Error('Outbox header name is invalid');
		}
		if (
			!['string', 'number', 'boolean'].includes(typeof item) ||
			(typeof item === 'string' && item.length > 4_000) ||
			(typeof item === 'number' && !Number.isSafeInteger(item))
		) {
			throw new Error(`Outbox header ${key} has an invalid value`);
		}
	}
}

function assertNoSecrets(value: unknown, depth = 0): void {
	if (depth > 20) throw new Error('Outbox payload is too deeply nested');
	if (Array.isArray(value)) {
		value.forEach(item => assertNoSecrets(item, depth + 1));
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, item] of Object.entries(value)) {
		if (FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
			throw new Error(`Outbox payload contains forbidden field ${key}`);
		}
		assertNoSecrets(item, depth + 1);
	}
}

function exactRecord(
	value: unknown,
	fields: readonly string[] | undefined,
	path: string
): JsonRecord {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	if (!fields) return value;
	const required = fields.filter(field => !field.endsWith('?'));
	const allowed = new Set(fields.map(field => field.replace(/\?$/, '')));
	const missing = required.filter(field => !(field in value));
	const unexpected = Object.keys(value).filter(
		field => !allowed.has(field)
	);
	if (missing.length || unexpected.length) {
		throw new Error(`${path} fields do not match the contract`);
	}
	return value;
}

function isRecord(value: unknown): value is JsonRecord {
	return (
		Boolean(value) && typeof value === 'object' && !Array.isArray(value)
	);
}

function assertUuid(
	value: unknown,
	path: string
): asserts value is string {
	if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
		throw new Error(`${path} must be a UUID`);
	}
}

function assertBoundedString(
	value: unknown,
	path: string,
	maximum = 10_000
): asserts value is string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		value.length > maximum
	) {
		throw new Error(`${path} must be a bounded non-empty string`);
	}
}

function assertIdentifier(
	value: unknown,
	path: string
): asserts value is string {
	assertBoundedString(value, path, 255);
	if (/\p{Cc}/u.test(value))
		throw new Error(`${path} contains control characters`);
}

function assertOptionalString(value: unknown, path: string): void {
	if (value === undefined || value === null) return;
	if (typeof value !== 'string' || value.length > 10_000) {
		throw new Error(`${path} must be a bounded string or null`);
	}
}

function assertIsoDate(
	value: unknown,
	path: string
): asserts value is string {
	assertBoundedString(value, path, 100);
	if (
		Number.isNaN(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	) {
		throw new Error(`${path} must be an ISO timestamp`);
	}
}

function assertPositiveBigint(value: unknown, path: string): void {
	if (
		typeof value !== 'string' ||
		!/^[1-9][0-9]{0,18}$/.test(value) ||
		BigInt(value) > POSTGRES_BIGINT_MAX
	) {
		throw new Error(`${path} must be a positive PostgreSQL bigint`);
	}
}

function assertPositiveInteger(
	value: unknown,
	path: string,
	maximum = 2_147_483_647
): void {
	if (
		!Number.isInteger(value) ||
		Number(value) < 1 ||
		Number(value) > maximum
	) {
		throw new Error(`${path} must be a positive integer`);
	}
}

function assertNamespacedAggregateId<T extends string>(
	value: unknown,
	allowedTypes: readonly T[]
): void {
	assertIdentifier(value, 'aggregateId');
	const separator = value.indexOf(':');
	if (separator < 1 || separator === value.length - 1) {
		throw new Error('aggregateId must be namespaced');
	}
	assertOneOf(
		value.slice(0, separator),
		allowedTypes,
		'aggregateId.widgetType'
	);
	assertIdentifier(value.slice(separator + 1), 'aggregateId.id');
}

function assertOneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
	path: string
): asserts value is T {
	if (typeof value !== 'string' || !allowed.includes(value as T)) {
		throw new Error(`${path} has an unsupported value`);
	}
}

function isProvider(
	value: (typeof LEAD_INTEGRATIONS)[number]
): value is (typeof PROVIDER_INTEGRATIONS)[number] {
	return PROVIDER_INTEGRATIONS.includes(
		value as (typeof PROVIDER_INTEGRATIONS)[number]
	);
}
