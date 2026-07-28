import {
	BILLING_PERIOD_VALUES,
	LEAD_SOURCES,
	NotificationDeliveryEventPayload,
	PLAN_VALUES
} from './delivery-event.types';
import {
	getDeadLetterRoutingKey,
	getManualRetryRoutingKey,
	LIMIT_REACHED_EMAIL_EVENT_TYPE,
	LIMIT_REACHED_TELEGRAM_EVENT_TYPE,
	MESSAGING_ROUTING_KEYS,
	NotificationDeliveryKind,
	OUTBOX_EVENT_TYPE,
	PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE,
	PAYMENT_SUCCEEDED_EVENT_TYPE
} from './messaging.constants';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_PAYLOAD_KEYS = new Set([
	'apikey',
	'authorization',
	'databaseurl',
	'password',
	'refreshtoken',
	'secret',
	'secretkey',
	'smtppassword',
	'telegrambottoken',
	'token',
	'webhookurl'
]);

interface MessagingEventContractMetadata {
	eventType: string;
	routingKey: string;
	messageId: string;
	kind?: NotificationDeliveryKind;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
	Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const assertRecord = (value: unknown, path: string): JsonRecord => {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	return value;
};

const assertExactKeys = (
	value: JsonRecord,
	required: readonly string[],
	optional: readonly string[] = [],
	path = 'payload'
): void => {
	const allowed = new Set([...required, ...optional]);
	const missing = required.filter(key => !(key in value));
	if (missing.length) {
		throw new Error(`${path} is missing fields: ${missing.join(', ')}`);
	}
	const unexpected = Object.keys(value).filter(key => !allowed.has(key));
	if (unexpected.length) {
		throw new Error(
			`${path} contains unexpected fields: ${unexpected.join(', ')}`
		);
	}
};

const assertString = (
	value: unknown,
	path: string,
	options: { nullable?: boolean; maxLength?: number } = {}
): void => {
	if (value === null && options.nullable) return;
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		value.length > (options.maxLength ?? 10_000)
	) {
		throw new Error(`${path} must be a non-empty string`);
	}
};

const assertOptionalString = (value: unknown, path: string): void => {
	if (value === undefined || value === null) return;
	if (typeof value !== 'string' || value.length > 10_000) {
		throw new Error(`${path} must be a string or null`);
	}
};

const assertUuid = (value: unknown, path: string): void => {
	if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
		throw new Error(`${path} must be a UUID`);
	}
};

const assertIsoDate = (
	value: unknown,
	path: string,
	nullable = false
): void => {
	if (value === null && nullable) return;
	assertString(value, path);
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
		throw new Error(`${path} must be an ISO date`);
	}
};

const assertNoForbiddenFields = (
	value: unknown,
	path = 'payload',
	depth = 0
): void => {
	if (depth > 20) throw new Error(`${path} exceeds maximum nesting`);
	if (Array.isArray(value)) {
		value.forEach((item, index) =>
			assertNoForbiddenFields(item, `${path}[${index}]`, depth + 1)
		);
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, nested] of Object.entries(value)) {
		if (FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
			throw new Error(`${path}.${key} is forbidden in RabbitMQ payload`);
		}
		assertNoForbiddenFields(nested, `${path}.${key}`, depth + 1);
	}
};

const assertEntity = (value: unknown, allowType: boolean): void => {
	const entity = assertRecord(value, 'payload.entity');
	assertExactKeys(
		entity,
		['id', 'name'],
		allowType ? ['type'] : [],
		'payload.entity'
	);
	assertString(entity.id, 'payload.entity.id');
	assertString(entity.name, 'payload.entity.name');
	if ('type' in entity) assertString(entity.type, 'payload.entity.type');
};

const assertLeadEvent = (
	payload: JsonRecord
): NotificationDeliveryKind => {
	assertExactKeys(payload, [
		'schemaVersion',
		'eventType',
		'integration',
		'source',
		'entity',
		'lead',
		'destination'
	]);
	if (
		payload.schemaVersion !== 2 ||
		payload.eventType !== OUTBOX_EVENT_TYPE
	) {
		throw new Error('Invalid lead integration contract version');
	}
	if (
		payload.integration !== 'email' &&
		payload.integration !== 'telegram'
	) {
		throw new Error('Invalid notification lead integration kind');
	}
	if (
		!LEAD_SOURCES.includes(payload.source as (typeof LEAD_SOURCES)[number])
	) {
		throw new Error('Invalid lead source');
	}
	assertEntity(payload.entity, false);
	const lead = assertRecord(payload.lead, 'payload.lead');
	assertExactKeys(
		lead,
		['id', 'createdAt'],
		[
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
			'answers',
			'url'
		],
		'payload.lead'
	);
	assertString(lead.id, 'payload.lead.id');
	assertIsoDate(lead.createdAt, 'payload.lead.createdAt');
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
		assertOptionalString(lead[key], `payload.lead.${key}`);
	}

	const destination = assertRecord(
		payload.destination,
		'payload.destination'
	);
	if (payload.integration === 'email') {
		assertExactKeys(destination, ['email'], [], 'payload.destination');
		assertString(destination.email, 'payload.destination.email');
	} else {
		assertExactKeys(
			destination,
			['telegramChatId'],
			[],
			'payload.destination'
		);
		assertString(
			destination.telegramChatId,
			'payload.destination.telegramChatId'
		);
	}
	return payload.integration;
};

const assertPaymentEvent = (
	payload: JsonRecord
): NotificationDeliveryKind => {
	assertExactKeys(payload, [
		'schemaVersion',
		'eventType',
		'payment',
		'user',
		'subscription'
	]);
	if (
		payload.schemaVersion !== 1 ||
		payload.eventType !== PAYMENT_SUCCEEDED_EVENT_TYPE
	) {
		throw new Error('Invalid payment event contract version');
	}
	assertPaymentDetails(payload.payment);
	assertPaymentUser(payload.user);

	const subscription = assertRecord(
		payload.subscription,
		'payload.subscription'
	);
	assertExactKeys(subscription, ['expiresAt'], [], 'payload.subscription');
	assertIsoDate(
		subscription.expiresAt,
		'payload.subscription.expiresAt',
		true
	);
	return 'payment-email';
};

const assertPaymentTelegramEvent = (
	payload: JsonRecord
): NotificationDeliveryKind => {
	assertExactKeys(payload, [
		'schemaVersion',
		'eventType',
		'payment',
		'user',
		'destination'
	]);
	if (
		payload.schemaVersion !== 1 ||
		payload.eventType !== PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE
	) {
		throw new Error(
			'Invalid payment Telegram notification contract version'
		);
	}
	assertPaymentDetails(payload.payment);
	assertPaymentUser(payload.user);

	const destination = assertRecord(
		payload.destination,
		'payload.destination'
	);
	assertExactKeys(
		destination,
		['telegramChatId', 'messageThreadId'],
		[],
		'payload.destination'
	);
	assertString(
		destination.telegramChatId,
		'payload.destination.telegramChatId',
		{
			nullable: true
		}
	);
	if (
		destination.messageThreadId !== null &&
		(!Number.isInteger(destination.messageThreadId) ||
			Number(destination.messageThreadId) < 1)
	) {
		throw new Error(
			'payload.destination.messageThreadId must be a positive integer or null'
		);
	}
	return 'payment-telegram';
};

const assertPaymentDetails = (value: unknown): void => {
	const payment = assertRecord(value, 'payload.payment');
	assertExactKeys(
		payment,
		['id', 'yookassaId', 'amount', 'plan', 'billingPeriod', 'succeededAt'],
		[],
		'payload.payment'
	);
	assertString(payment.id, 'payload.payment.id');
	assertString(payment.yookassaId, 'payload.payment.yookassaId');
	assertString(payment.amount, 'payload.payment.amount');
	if (
		!PLAN_VALUES.includes(payment.plan as (typeof PLAN_VALUES)[number])
	) {
		throw new Error('payload.payment.plan is invalid');
	}
	if (
		!BILLING_PERIOD_VALUES.includes(
			payment.billingPeriod as (typeof BILLING_PERIOD_VALUES)[number]
		)
	) {
		throw new Error('payload.payment.billingPeriod is invalid');
	}
	assertIsoDate(payment.succeededAt, 'payload.payment.succeededAt');
};

const assertPaymentUser = (value: unknown): void => {
	const user = assertRecord(value, 'payload.user');
	assertExactKeys(
		user,
		['id', 'name', 'email', 'phone'],
		[],
		'payload.user'
	);
	assertString(user.id, 'payload.user.id');
	assertOptionalString(user.name, 'payload.user.name');
	assertOptionalString(user.email, 'payload.user.email');
	assertOptionalString(user.phone, 'payload.user.phone');
};

const assertLimitEvent = (
	payload: JsonRecord
): NotificationDeliveryKind => {
	assertExactKeys(payload, [
		'schemaVersion',
		'eventType',
		'entity',
		'limit',
		'destination'
	]);
	if (
		payload.schemaVersion !== 2 ||
		!Number.isInteger(payload.limit) ||
		Number(payload.limit) < 1
	) {
		throw new Error('Invalid limit event contract');
	}
	assertEntity(payload.entity, true);
	const destination = assertRecord(
		payload.destination,
		'payload.destination'
	);
	if (payload.eventType === LIMIT_REACHED_EMAIL_EVENT_TYPE) {
		assertExactKeys(destination, ['email'], [], 'payload.destination');
		assertString(destination.email, 'payload.destination.email');
		return 'limit-email';
	}
	if (payload.eventType === LIMIT_REACHED_TELEGRAM_EVENT_TYPE) {
		assertExactKeys(
			destination,
			['telegramChatId'],
			[],
			'payload.destination'
		);
		assertString(
			destination.telegramChatId,
			'payload.destination.telegramChatId'
		);
		return 'limit-telegram';
	}
	throw new Error('Invalid limit event type');
};

type ResolvedContractKind =
	| NotificationDeliveryKind
	| 'telegram-destination-unavailable-outcome';

const assertTelegramDestinationUnavailableEvent = (
	payload: JsonRecord
): ResolvedContractKind => {
	assertExactKeys(payload, [
		'schemaVersion',
		'eventType',
		'sourceEventId',
		'sourceKind',
		'destination',
		'normalizedCode',
		'occurredAt'
	]);
	if (
		payload.schemaVersion !== 1 ||
		payload.eventType !== TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE
	) {
		throw new Error(
			'Invalid Telegram destination unavailable contract version'
		);
	}
	assertUuid(payload.sourceEventId, 'payload.sourceEventId');
	if (
		payload.sourceKind !== 'telegram' &&
		payload.sourceKind !== 'limit-telegram'
	) {
		throw new Error('payload.sourceKind is invalid');
	}
	const destination = assertRecord(
		payload.destination,
		'payload.destination'
	);
	assertExactKeys(
		destination,
		['telegramChatId'],
		[],
		'payload.destination'
	);
	assertString(
		destination.telegramChatId,
		'payload.destination.telegramChatId'
	);
	assertString(payload.normalizedCode, 'payload.normalizedCode', {
		maxLength: 255
	});
	assertIsoDate(payload.occurredAt, 'payload.occurredAt');
	return 'telegram-destination-unavailable-outcome';
};

const resolveExpectedKind = (
	payload: JsonRecord
): ResolvedContractKind => {
	switch (payload.eventType) {
		case OUTBOX_EVENT_TYPE:
			return assertLeadEvent(payload);
		case PAYMENT_SUCCEEDED_EVENT_TYPE:
			return assertPaymentEvent(payload);
		case PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE:
			return assertPaymentTelegramEvent(payload);
		case LIMIT_REACHED_EMAIL_EVENT_TYPE:
		case LIMIT_REACHED_TELEGRAM_EVENT_TYPE:
			return assertLimitEvent(payload);
		case TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE:
			return assertTelegramDestinationUnavailableEvent(payload);
		default:
			throw new Error(
				`Unsupported notification event type: ${String(payload.eventType)}`
			);
	}
};

export function assertMessagingEventContract(
	payloadValue: unknown,
	metadata: MessagingEventContractMetadata
): asserts payloadValue is NotificationDeliveryEventPayload {
	if (!UUID_PATTERN.test(metadata.messageId)) {
		throw new Error('messageId must be a UUID');
	}
	const payload = assertRecord(payloadValue, 'payload');
	assertNoForbiddenFields(payload);
	assertString(payload.eventType, 'payload.eventType');
	if (payload.eventType !== metadata.eventType) {
		throw new Error(
			`AMQP type does not match payload eventType: ${metadata.eventType}`
		);
	}

	const expectedKind = resolveExpectedKind(payload);
	if (expectedKind === 'telegram-destination-unavailable-outcome') {
		if (metadata.kind) {
			throw new Error(
				`${metadata.eventType} is not a notification delivery input`
			);
		}
		if (
			metadata.routingKey !== TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE
		) {
			throw new Error(
				`Routing key ${metadata.routingKey} does not match ${metadata.eventType}`
			);
		}
		return;
	}
	if (metadata.kind && expectedKind !== metadata.kind) {
		throw new Error(
			`Event type ${metadata.eventType} cannot be consumed by ${metadata.kind}`
		);
	}
	if (
		![
			MESSAGING_ROUTING_KEYS[expectedKind],
			getDeadLetterRoutingKey(expectedKind),
			getManualRetryRoutingKey(expectedKind),
			expectedKind
		].includes(metadata.routingKey)
	) {
		throw new Error(
			`Routing key ${metadata.routingKey} does not match ${metadata.eventType}`
		);
	}
}
