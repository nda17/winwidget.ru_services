import {
	DAILY_SUMMARY_EVENT_TYPE,
	DATABASE_BACKUP_EVENT_TYPE,
	getManualRetryRoutingKey,
	IntegrationKind,
	LIMIT_REACHED_EMAIL_EVENT_TYPE,
	LIMIT_REACHED_TELEGRAM_EVENT_TYPE,
	MAINTENANCE_KINDS,
	MAILING_DELIVERY_EVENT_TYPE,
	MESSAGING_ROUTING_KEYS,
	MessagingKind,
	OUTBOX_EVENT_TYPE,
	PAYMENT_SUCCEEDED_EVENT_TYPE
} from '@/messaging/messaging.constants';
import {
	BillingPeriod,
	MailingDeliveryChannel,
	Plan
} from '@prisma/client';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
	'smtppassword',
	'telegrambottoken',
	'token',
	'webhookurl'
]);

interface MessagingEventContractMetadata {
	eventType: string;
	routingKey: string;
	messageId: string;
	kind?: MessagingKind;
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

const assertUuid = (value: unknown, path: string): void => {
	if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
		throw new Error(`${path} must be a UUID`);
	}
};

const assertEntity = (value: unknown): void => {
	const entity = assertRecord(value, 'payload.entity');
	assertExactKeys(entity, ['id', 'name'], ['type'], 'payload.entity');
	assertString(entity.id, 'payload.entity.id');
	assertString(entity.name, 'payload.entity.name');
	if ('type' in entity) assertString(entity.type, 'payload.entity.type');
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

const assertLeadEvent = (payload: JsonRecord): IntegrationKind => {
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
	const integration = payload.integration;
	if (
		integration !== 'email' &&
		integration !== 'webhook' &&
		integration !== 'telegram' &&
		integration !== 'bitrix24' &&
		integration !== 'amo-crm'
	) {
		throw new Error('Invalid lead integration kind');
	}
	if (
		payload.source !== 'widget' &&
		payload.source !== 'quiz' &&
		payload.source !== 'callback' &&
		payload.source !== 'countdown-timer' &&
		payload.source !== 'stop-offer' &&
		payload.source !== 'online-consultant' &&
		payload.source !== 'calculator'
	) {
		throw new Error('Invalid lead source');
	}
	assertEntity(payload.entity);
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
	if (integration === 'email') {
		assertExactKeys(destination, ['email'], [], 'payload.destination');
		assertString(destination.email, 'payload.destination.email');
	} else if (integration === 'telegram') {
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
	} else {
		assertExactKeys(
			destination,
			['credentialRef'],
			[],
			'payload.destination'
		);
		assertUuid(
			destination.credentialRef,
			'payload.destination.credentialRef'
		);
	}
	return integration;
};

const assertPaymentEvent = (payload: JsonRecord): IntegrationKind[] => {
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
	const payment = assertRecord(payload.payment, 'payload.payment');
	assertExactKeys(
		payment,
		['id', 'yookassaId', 'amount', 'plan', 'billingPeriod', 'succeededAt'],
		[],
		'payload.payment'
	);
	assertString(payment.id, 'payload.payment.id');
	assertString(payment.yookassaId, 'payload.payment.yookassaId');
	assertString(payment.amount, 'payload.payment.amount');
	if (!Object.values(Plan).includes(payment.plan as Plan)) {
		throw new Error('payload.payment.plan is invalid');
	}
	if (
		!Object.values(BillingPeriod).includes(
			payment.billingPeriod as BillingPeriod
		)
	) {
		throw new Error('payload.payment.billingPeriod is invalid');
	}
	assertIsoDate(payment.succeededAt, 'payload.payment.succeededAt');

	const user = assertRecord(payload.user, 'payload.user');
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
	return ['payment-email', 'payment-telegram'];
};

const assertMailingEvent = (payload: JsonRecord): IntegrationKind => {
	assertExactKeys(payload, [
		'schemaVersion',
		'eventType',
		'campaignId',
		'deliveryId',
		'channel'
	]);
	if (
		payload.schemaVersion !== 1 ||
		payload.eventType !== MAILING_DELIVERY_EVENT_TYPE
	) {
		throw new Error('Invalid mailing event contract version');
	}
	assertUuid(payload.campaignId, 'payload.campaignId');
	assertUuid(payload.deliveryId, 'payload.deliveryId');
	if (payload.channel === MailingDeliveryChannel.EMAIL) {
		return 'mailing-email';
	}
	if (payload.channel === MailingDeliveryChannel.TELEGRAM) {
		return 'mailing-telegram';
	}
	throw new Error('payload.channel is invalid');
};

const assertLimitEvent = (payload: JsonRecord): IntegrationKind => {
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
	assertEntity(payload.entity);
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

const assertScheduledEvent = (payload: JsonRecord): MessagingKind => {
	assertExactKeys(payload, [
		'schemaVersion',
		'eventType',
		'jobId',
		'jobType',
		'scheduleKey',
		'periodStart',
		'periodEnd'
	]);
	if (payload.schemaVersion !== 1) {
		throw new Error('Invalid scheduled event contract version');
	}
	assertUuid(payload.jobId, 'payload.jobId');
	assertString(payload.jobType, 'payload.jobType');
	assertString(payload.scheduleKey, 'payload.scheduleKey');
	if (payload.eventType === DAILY_SUMMARY_EVENT_TYPE) {
		if (payload.jobType !== 'DAILY_TELEGRAM_SUMMARY') {
			throw new Error('Invalid daily summary job type');
		}
		assertIsoDate(payload.periodStart, 'payload.periodStart');
		assertIsoDate(payload.periodEnd, 'payload.periodEnd');
		if (
			Date.parse(payload.periodEnd as string) <=
			Date.parse(payload.periodStart as string)
		) {
			throw new Error(
				'payload.periodEnd must be after payload.periodStart'
			);
		}
		return 'daily-summary-telegram';
	}
	if (payload.eventType === DATABASE_BACKUP_EVENT_TYPE) {
		if (payload.jobType !== 'DATABASE_BACKUP') {
			throw new Error('Invalid database backup job type');
		}
		assertIsoDate(payload.periodStart, 'payload.periodStart', true);
		assertIsoDate(payload.periodEnd, 'payload.periodEnd', true);
		if ((payload.periodStart === null) !== (payload.periodEnd === null)) {
			throw new Error(
				'payload.periodStart and payload.periodEnd must be null or dates together'
			);
		}
		if (
			typeof payload.periodStart === 'string' &&
			typeof payload.periodEnd === 'string' &&
			Date.parse(payload.periodEnd) <= Date.parse(payload.periodStart)
		) {
			throw new Error(
				'payload.periodEnd must be after payload.periodStart'
			);
		}
		return MAINTENANCE_KINDS[0];
	}
	throw new Error('Invalid scheduled event type');
};

const resolveExpectedKinds = (payload: JsonRecord): MessagingKind[] => {
	switch (payload.eventType) {
		case OUTBOX_EVENT_TYPE:
			return [assertLeadEvent(payload)];
		case PAYMENT_SUCCEEDED_EVENT_TYPE:
			return assertPaymentEvent(payload);
		case MAILING_DELIVERY_EVENT_TYPE:
			return [assertMailingEvent(payload)];
		case LIMIT_REACHED_EMAIL_EVENT_TYPE:
		case LIMIT_REACHED_TELEGRAM_EVENT_TYPE:
			return [assertLimitEvent(payload)];
		case DAILY_SUMMARY_EVENT_TYPE:
		case DATABASE_BACKUP_EVENT_TYPE:
			return [assertScheduledEvent(payload)];
		default:
			throw new Error(
				`Unsupported messaging event type: ${String(payload.eventType)}`
			);
	}
};

export function assertMessagingEventContract(
	payloadValue: unknown,
	metadata: MessagingEventContractMetadata
): void {
	assertUuid(metadata.messageId, 'messageId');
	const payload = assertRecord(payloadValue, 'payload');
	assertNoForbiddenFields(payload);
	assertString(payload.eventType, 'payload.eventType');
	if (payload.eventType !== metadata.eventType) {
		throw new Error(
			`AMQP type does not match payload eventType: ${metadata.eventType}`
		);
	}

	const expectedKinds = resolveExpectedKinds(payload);
	if (
		(payload.eventType === DAILY_SUMMARY_EVENT_TYPE ||
			payload.eventType === DATABASE_BACKUP_EVENT_TYPE) &&
		payload.jobId !== metadata.messageId
	) {
		throw new Error('Scheduled event jobId must match the AMQP messageId');
	}
	if (metadata.kind && !expectedKinds.includes(metadata.kind)) {
		throw new Error(
			`Event type ${metadata.eventType} cannot be consumed by ${metadata.kind}`
		);
	}
	const routingMatches = expectedKinds.some(kind =>
		[
			MESSAGING_ROUTING_KEYS[kind],
			getManualRetryRoutingKey(kind),
			kind
		].includes(metadata.routingKey)
	);
	if (!routingMatches) {
		throw new Error(
			`Routing key ${metadata.routingKey} does not match ${metadata.eventType}`
		);
	}
}
