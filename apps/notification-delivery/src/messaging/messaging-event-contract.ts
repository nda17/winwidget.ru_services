import {
	BILLING_PERIOD_VALUES,
	LEAD_SOURCES,
	NotificationDeliveryEventPayload,
	PLAN_VALUES
} from './delivery-event.types';
import {
	CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE,
	CAMPAIGN_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	CAMPAIGN_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	DAILY_SUMMARY_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	getDeadLetterRoutingKey,
	getManualRetryRoutingKey,
	LIMIT_REACHED_EMAIL_EVENT_TYPE,
	LIMIT_REACHED_TELEGRAM_EVENT_TYPE,
	MESSAGING_ROUTING_KEYS,
	NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	NotificationDeliveryKind,
	OUTBOX_EVENT_TYPE,
	PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	PAYMENT_SUCCEEDED_EVENT_TYPE,
	REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE,
	SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE
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

const OUTCOME_NOTIFICATION_DELIVERY_KINDS = [
	'subscription-expiry-email',
	'subscription-expiry-telegram'
] as const;

const assertNotificationReference = (
	value: unknown,
	expectedType: 'daily-summary-job' | 'subscription-expiry-reminder'
): JsonRecord => {
	const reference = assertRecord(value, 'payload.reference');
	assertExactKeys(reference, ['type', 'id'], [], 'payload.reference');
	if (reference.type !== expectedType) {
		throw new Error(`payload.reference.type must be ${expectedType}`);
	}
	if (expectedType === 'daily-summary-job') {
		assertUuid(reference.id, 'payload.reference.id');
	} else {
		assertString(reference.id, 'payload.reference.id', {
			maxLength: 255
		});
	}
	return reference;
};

const assertCampaignNotificationEvent = (
	payload: JsonRecord
): NotificationDeliveryKind => {
	assertExactKeys(payload, [
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
	if (
		payload.schemaVersion !== 2 ||
		(payload.eventType !== CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE &&
			payload.eventType !== CAMPAIGN_TELEGRAM_NOTIFICATION_EVENT_TYPE)
	) {
		throw new Error('Invalid campaign notification contract version');
	}
	assertUuid(payload.eventId, 'payload.eventId');
	assertIsoDate(payload.occurredAt, 'payload.occurredAt');
	assertUuid(payload.correlationId, 'payload.correlationId');
	assertUuid(payload.campaignId, 'payload.campaignId');
	assertUuid(payload.deliveryId, 'payload.deliveryId');
	if (
		!Number.isInteger(payload.dispatchGeneration) ||
		Number(payload.dispatchGeneration) < 1
	) {
		throw new Error(
			'payload.dispatchGeneration must be a positive integer'
		);
	}

	const reference = assertRecord(payload.reference, 'payload.reference');
	assertExactKeys(
		reference,
		['type', 'id', 'aggregateId', 'dispatchGeneration'],
		[],
		'payload.reference'
	);
	if (
		reference.type !== 'campaign-delivery' ||
		reference.id !== payload.deliveryId ||
		reference.aggregateId !== payload.campaignId ||
		reference.dispatchGeneration !== payload.dispatchGeneration
	) {
		throw new Error(
			'payload.reference must match campaignId, deliveryId and dispatchGeneration'
		);
	}
	assertUuid(reference.id, 'payload.reference.id');
	assertUuid(reference.aggregateId, 'payload.reference.aggregateId');

	const content = assertRecord(payload.content, 'payload.content');
	assertExactKeys(content, ['subject', 'message'], [], 'payload.content');
	assertString(content.subject, 'payload.content.subject', {
		maxLength: 120
	});
	assertString(content.message, 'payload.content.message', {
		maxLength: 5000
	});

	const destination = assertRecord(
		payload.destination,
		'payload.destination'
	);
	if (payload.eventType === CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE) {
		assertExactKeys(destination, ['email'], [], 'payload.destination');
		assertString(destination.email, 'payload.destination.email');
		return 'campaign-email';
	}
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
	return 'campaign-telegram';
};

const assertPreparedNotificationEvent = (
	payload: JsonRecord
): NotificationDeliveryKind => {
	assertExactKeys(payload, [
		'schemaVersion',
		'eventType',
		'reference',
		'destination',
		'content'
	]);
	if (payload.schemaVersion !== 1) {
		throw new Error('Invalid prepared notification contract version');
	}

	const destination = assertRecord(
		payload.destination,
		'payload.destination'
	);
	const content = assertRecord(payload.content, 'payload.content');

	switch (payload.eventType) {
		case DAILY_SUMMARY_TELEGRAM_NOTIFICATION_EVENT_TYPE:
			assertNotificationReference(payload.reference, 'daily-summary-job');
			assertExactKeys(
				destination,
				['telegramChatId', 'messageThreadId'],
				[],
				'payload.destination'
			);
			assertString(
				destination.telegramChatId,
				'payload.destination.telegramChatId'
			);
			if (
				!Number.isInteger(destination.messageThreadId) ||
				Number(destination.messageThreadId) < 1
			) {
				throw new Error(
					'payload.destination.messageThreadId must be a positive integer'
				);
			}
			assertExactKeys(content, ['text'], [], 'payload.content');
			assertString(content.text, 'payload.content.text', {
				maxLength: 10_000
			});
			return 'daily-summary-delivery-telegram';
		case SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE:
		case SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE: {
			assertNotificationReference(
				payload.reference,
				'subscription-expiry-reminder'
			);
			assertExactKeys(
				content,
				['daysBeforeExpiry', 'planLabel', 'expiresAtLabel'],
				[],
				'payload.content'
			);
			if (
				!Number.isInteger(content.daysBeforeExpiry) ||
				Number(content.daysBeforeExpiry) < 0 ||
				Number(content.daysBeforeExpiry) > 365
			) {
				throw new Error(
					'payload.content.daysBeforeExpiry must be an integer between 0 and 365'
				);
			}
			assertString(content.planLabel, 'payload.content.planLabel', {
				maxLength: 100
			});
			assertString(
				content.expiresAtLabel,
				'payload.content.expiresAtLabel',
				{ maxLength: 100 }
			);
			if (
				payload.eventType ===
				SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE
			) {
				assertExactKeys(destination, ['email'], [], 'payload.destination');
				assertString(destination.email, 'payload.destination.email');
				return 'subscription-expiry-email';
			}
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
			return 'subscription-expiry-telegram';
		}
		default:
			throw new Error('Invalid prepared notification event type');
	}
};

type ResolvedContractKind =
	| NotificationDeliveryKind
	| 'telegram-destination-unavailable-outcome'
	| 'notification-delivery-outcome'
	| 'reporting-notification-delivery-outcome'
	| 'campaign-notification-delivery-outcome';

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
		payload.sourceKind !== 'limit-telegram' &&
		payload.sourceKind !== 'campaign-telegram' &&
		payload.sourceKind !== 'subscription-expiry-telegram'
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

const assertNotificationDeliveryOutcome = (
	payload: JsonRecord
): ResolvedContractKind => {
	assertExactKeys(payload, [
		'schemaVersion',
		'eventType',
		'sourceEventId',
		'sourceKind',
		'reference',
		'status',
		'failure',
		'occurredAt'
	]);
	if (
		payload.schemaVersion !== 1 ||
		payload.eventType !== NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE
	) {
		throw new Error(
			'Invalid notification delivery outcome contract version'
		);
	}
	assertUuid(payload.sourceEventId, 'payload.sourceEventId');
	if (
		!OUTCOME_NOTIFICATION_DELIVERY_KINDS.includes(
			payload.sourceKind as (typeof OUTCOME_NOTIFICATION_DELIVERY_KINDS)[number]
		)
	) {
		throw new Error('payload.sourceKind is invalid');
	}
	assertNotificationReference(
		payload.reference,
		'subscription-expiry-reminder'
	);
	if (payload.status !== 'DELIVERED' && payload.status !== 'FAILED') {
		throw new Error('payload.status is invalid');
	}
	if (payload.status === 'DELIVERED') {
		if (payload.failure !== null) {
			throw new Error('payload.failure must be null for DELIVERED');
		}
	} else {
		const failure = assertRecord(payload.failure, 'payload.failure');
		assertExactKeys(
			failure,
			['normalizedCode', 'safeReason'],
			[],
			'payload.failure'
		);
		assertString(
			failure.normalizedCode,
			'payload.failure.normalizedCode',
			{ maxLength: 255 }
		);
		assertString(failure.safeReason, 'payload.failure.safeReason', {
			maxLength: 2000
		});
	}
	assertIsoDate(payload.occurredAt, 'payload.occurredAt');
	return 'notification-delivery-outcome';
};

const assertReportingNotificationDeliveryOutcome = (
	payload: JsonRecord
): ResolvedContractKind => {
	assertExactKeys(payload, [
		'schemaVersion',
		'eventType',
		'sourceEventId',
		'sourceKind',
		'reference',
		'status',
		'failure',
		'occurredAt'
	]);
	if (
		payload.schemaVersion !== 1 ||
		payload.eventType !==
			REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE
	) {
		throw new Error(
			'Invalid Reporting notification delivery outcome contract version'
		);
	}
	assertUuid(payload.sourceEventId, 'payload.sourceEventId');
	if (payload.sourceKind !== 'daily-summary-delivery-telegram') {
		throw new Error('payload.sourceKind is invalid');
	}
	assertNotificationReference(payload.reference, 'daily-summary-job');
	if (payload.status !== 'DELIVERED' && payload.status !== 'FAILED') {
		throw new Error('payload.status is invalid');
	}
	if (payload.status === 'DELIVERED') {
		if (payload.failure !== null) {
			throw new Error('payload.failure must be null for DELIVERED');
		}
	} else {
		const failure = assertRecord(payload.failure, 'payload.failure');
		assertExactKeys(
			failure,
			['normalizedCode', 'safeReason'],
			[],
			'payload.failure'
		);
		assertString(
			failure.normalizedCode,
			'payload.failure.normalizedCode',
			{ maxLength: 255 }
		);
		assertString(failure.safeReason, 'payload.failure.safeReason', {
			maxLength: 2000
		});
	}
	assertIsoDate(payload.occurredAt, 'payload.occurredAt');
	return 'reporting-notification-delivery-outcome';
};

const assertCampaignNotificationDeliveryOutcome = (
	payload: JsonRecord
): ResolvedContractKind => {
	assertExactKeys(payload, [
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
	if (
		payload.schemaVersion !== 2 ||
		payload.eventType !== CAMPAIGN_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE
	) {
		throw new Error(
			'Invalid campaign notification outcome contract version'
		);
	}
	assertUuid(payload.eventId, 'payload.eventId');
	assertIsoDate(payload.occurredAt, 'payload.occurredAt');
	assertUuid(payload.correlationId, 'payload.correlationId');
	assertUuid(payload.sourceEventId, 'payload.sourceEventId');
	if (
		payload.sourceKind !== 'campaign-email' &&
		payload.sourceKind !== 'campaign-telegram'
	) {
		throw new Error('payload.sourceKind is invalid');
	}
	assertUuid(payload.campaignId, 'payload.campaignId');
	assertUuid(payload.deliveryId, 'payload.deliveryId');
	if (
		!Number.isInteger(payload.dispatchGeneration) ||
		Number(payload.dispatchGeneration) < 1
	) {
		throw new Error(
			'payload.dispatchGeneration must be a positive integer'
		);
	}
	if (payload.status !== 'DELIVERED' && payload.status !== 'FAILED') {
		throw new Error('payload.status is invalid');
	}
	if (payload.status === 'DELIVERED') {
		if (payload.failure !== null) {
			throw new Error('payload.failure must be null for DELIVERED');
		}
	} else {
		const failure = assertRecord(payload.failure, 'payload.failure');
		assertExactKeys(
			failure,
			['normalizedCode', 'safeReason'],
			[],
			'payload.failure'
		);
		assertString(
			failure.normalizedCode,
			'payload.failure.normalizedCode',
			{ maxLength: 255 }
		);
		assertString(failure.safeReason, 'payload.failure.safeReason', {
			maxLength: 2000
		});
	}
	return 'campaign-notification-delivery-outcome';
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
		case CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE:
		case CAMPAIGN_TELEGRAM_NOTIFICATION_EVENT_TYPE:
			return assertCampaignNotificationEvent(payload);
		case DAILY_SUMMARY_TELEGRAM_NOTIFICATION_EVENT_TYPE:
		case SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE:
		case SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE:
			return assertPreparedNotificationEvent(payload);
		case TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE:
			return assertTelegramDestinationUnavailableEvent(payload);
		case NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE:
			return assertNotificationDeliveryOutcome(payload);
		case REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE:
			return assertReportingNotificationDeliveryOutcome(payload);
		case CAMPAIGN_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE:
			return assertCampaignNotificationDeliveryOutcome(payload);
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
	if (expectedKind === 'notification-delivery-outcome') {
		if (metadata.kind) {
			throw new Error(
				`${metadata.eventType} is not a notification delivery input`
			);
		}
		if (metadata.routingKey !== NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE) {
			throw new Error(
				`Routing key ${metadata.routingKey} does not match ${metadata.eventType}`
			);
		}
		return;
	}
	if (expectedKind === 'reporting-notification-delivery-outcome') {
		if (metadata.kind) {
			throw new Error(
				`${metadata.eventType} is not a notification delivery input`
			);
		}
		if (
			metadata.routingKey !==
			REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE
		) {
			throw new Error(
				`Routing key ${metadata.routingKey} does not match ${metadata.eventType}`
			);
		}
		return;
	}
	if (expectedKind === 'campaign-notification-delivery-outcome') {
		if (metadata.kind) {
			throw new Error(
				`${metadata.eventType} is not a notification delivery input`
			);
		}
		if (
			metadata.routingKey !==
			CAMPAIGN_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE
		) {
			throw new Error(
				`Routing key ${metadata.routingKey} does not match ${metadata.eventType}`
			);
		}
		if (payload.eventId !== metadata.messageId) {
			throw new Error(
				'Campaign outcome eventId must match the AMQP messageId'
			);
		}
		return;
	}
	if (
		(expectedKind === 'campaign-email' ||
			expectedKind === 'campaign-telegram') &&
		payload.eventId !== metadata.messageId
	) {
		throw new Error(
			'Campaign request eventId must match the AMQP messageId'
		);
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
