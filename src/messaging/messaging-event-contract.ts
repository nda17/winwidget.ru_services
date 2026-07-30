import {
	AUTO_RENEWAL_CHARGE_EVENT_TYPE,
	CAMPAIGN_ADMIN_AUDIT_EVENT_TYPE,
	DAILY_SUMMARY_EVENT_TYPE,
	DAILY_SUMMARY_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	DATABASE_BACKUP_EVENT_TYPE,
	getDeadLetterRoutingKey,
	getManualRetryRoutingKey,
	IntegrationKind,
	LIMIT_REACHED_EMAIL_EVENT_TYPE,
	LIMIT_REACHED_TELEGRAM_EVENT_TYPE,
	MAINTENANCE_KINDS,
	MESSAGING_ROUTING_KEYS,
	MessagingKind,
	NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	OUTBOX_EVENT_TYPE,
	PAYMENT_SUCCEEDED_EVENT_TYPE,
	PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE,
	SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE
} from '@/messaging/messaging.constants';
import { CAMPAIGN_ADMIN_AUDIT_ACTIONS } from '@/messaging/campaign-admin-audit-event';
import { OUTCOME_NOTIFICATION_DELIVERY_KINDS } from '@/messaging/notification-delivery-event';
import { TELEGRAM_DESTINATION_SOURCE_KINDS } from '@/messaging/telegram-destination-unavailable-event';
import { isDatabaseBackupJobType } from '@/scheduled-jobs/scheduled-jobs.types';
import { BillingPeriod, Plan } from '@prisma/client';

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
	return ['payment-email'];
};

const assertPaymentTelegramEvent = (
	payload: JsonRecord
): IntegrationKind => {
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
		throw new Error('Invalid payment Telegram event contract version');
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
		{ nullable: true }
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

const assertAutoRenewalChargeEvent = (
	payload: JsonRecord
): IntegrationKind => {
	assertExactKeys(payload, [
		'schemaVersion',
		'eventType',
		'paymentId',
		'autoRenewalId',
		'cycleKey',
		'scheduledFor'
	]);
	if (
		payload.schemaVersion !== 1 ||
		payload.eventType !== AUTO_RENEWAL_CHARGE_EVENT_TYPE
	) {
		throw new Error('Invalid auto-renewal charge event contract version');
	}
	assertString(payload.paymentId, 'payload.paymentId', {
		maxLength: 255
	});
	assertString(payload.autoRenewalId, 'payload.autoRenewalId', {
		maxLength: 255
	});
	assertString(payload.cycleKey, 'payload.cycleKey', {
		maxLength: 1000
	});
	assertIsoDate(payload.scheduledFor, 'payload.scheduledFor');
	return 'auto-renewal';
};

const assertTelegramDestinationUnavailableEvent = (
	payload: JsonRecord
): IntegrationKind => {
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
			'Invalid Telegram destination unavailable event contract version'
		);
	}
	assertUuid(payload.sourceEventId, 'payload.sourceEventId');
	if (
		!TELEGRAM_DESTINATION_SOURCE_KINDS.includes(
			payload.sourceKind as (typeof TELEGRAM_DESTINATION_SOURCE_KINDS)[number]
		)
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
	return 'telegram-destination-unavailable';
};

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

const assertPreparedNotificationEvent = (
	payload: JsonRecord
): IntegrationKind => {
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

const assertNotificationDeliveryOutcome = (
	payload: JsonRecord
): IntegrationKind => {
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
	if (payload.sourceKind === 'daily-summary-delivery-telegram') {
		assertNotificationReference(payload.reference, 'daily-summary-job');
	} else {
		assertNotificationReference(
			payload.reference,
			'subscription-expiry-reminder'
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
	assertIsoDate(payload.occurredAt, 'payload.occurredAt');
	return 'notification-delivery-outcome';
};

const assertCampaignAdminAuditEvent = (
	payload: JsonRecord
): IntegrationKind => {
	assertExactKeys(payload, [
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
		payload.eventType !== CAMPAIGN_ADMIN_AUDIT_EVENT_TYPE
	) {
		throw new Error('Invalid campaign admin audit contract version');
	}
	assertUuid(payload.eventId, 'payload.eventId');
	assertIsoDate(payload.occurredAt, 'payload.occurredAt');
	assertUuid(payload.correlationId, 'payload.correlationId');
	assertString(payload.actorId, 'payload.actorId', { maxLength: 256 });
	if (
		!CAMPAIGN_ADMIN_AUDIT_ACTIONS.includes(
			payload.action as (typeof CAMPAIGN_ADMIN_AUDIT_ACTIONS)[number]
		)
	) {
		throw new Error('payload.action is invalid');
	}

	const target = assertRecord(payload.target, 'payload.target');
	const metadata = assertRecord(payload.metadata, 'payload.metadata');
	if (payload.action === 'CAMPAIGN_DELIVERY_RETRY') {
		assertExactKeys(
			target,
			['campaignId', 'deliveryId'],
			[],
			'payload.target'
		);
		assertExactKeys(
			metadata,
			['channel', 'dispatchGeneration'],
			[],
			'payload.metadata'
		);
		assertUuid(target.deliveryId, 'payload.target.deliveryId');
		if (metadata.channel !== 'EMAIL' && metadata.channel !== 'TELEGRAM') {
			throw new Error('payload.metadata.channel is invalid');
		}
		if (
			!Number.isInteger(metadata.dispatchGeneration) ||
			Number(metadata.dispatchGeneration) < 1
		) {
			throw new Error(
				'payload.metadata.dispatchGeneration must be a positive integer'
			);
		}
	} else {
		assertExactKeys(target, ['campaignId'], [], 'payload.target');
		if (payload.action === 'CAMPAIGN_CREATE') {
			assertExactKeys(
				metadata,
				['channel', 'audience'],
				[],
				'payload.metadata'
			);
			if (
				metadata.channel !== 'EMAIL' &&
				metadata.channel !== 'TELEGRAM' &&
				metadata.channel !== 'BOTH'
			) {
				throw new Error('payload.metadata.channel is invalid');
			}
			if (
				metadata.audience !== 'ALL' &&
				metadata.audience !== 'ACTIVE_SUBSCRIBERS'
			) {
				throw new Error('payload.metadata.audience is invalid');
			}
		} else {
			assertExactKeys(
				metadata,
				['recipientCount'],
				[],
				'payload.metadata'
			);
			if (
				!Number.isInteger(metadata.recipientCount) ||
				Number(metadata.recipientCount) < 0
			) {
				throw new Error(
					'payload.metadata.recipientCount must be a non-negative integer'
				);
			}
		}
	}
	assertUuid(target.campaignId, 'payload.target.campaignId');
	return 'campaign-admin-audit';
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
		if (
			typeof payload.jobType !== 'string' ||
			!isDatabaseBackupJobType(payload.jobType)
		) {
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
		case PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE:
			return [assertPaymentTelegramEvent(payload)];
		case AUTO_RENEWAL_CHARGE_EVENT_TYPE:
			return [assertAutoRenewalChargeEvent(payload)];
		case LIMIT_REACHED_EMAIL_EVENT_TYPE:
		case LIMIT_REACHED_TELEGRAM_EVENT_TYPE:
			return [assertLimitEvent(payload)];
		case DAILY_SUMMARY_EVENT_TYPE:
		case DATABASE_BACKUP_EVENT_TYPE:
			return [assertScheduledEvent(payload)];
		case TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE:
			return [assertTelegramDestinationUnavailableEvent(payload)];
		case DAILY_SUMMARY_TELEGRAM_NOTIFICATION_EVENT_TYPE:
		case SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE:
		case SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE:
			return [assertPreparedNotificationEvent(payload)];
		case NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE:
			return [assertNotificationDeliveryOutcome(payload)];
		case CAMPAIGN_ADMIN_AUDIT_EVENT_TYPE:
			return [assertCampaignAdminAuditEvent(payload)];
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
	if (
		payload.eventType === CAMPAIGN_ADMIN_AUDIT_EVENT_TYPE &&
		payload.eventId !== metadata.messageId
	) {
		throw new Error(
			'Campaign admin audit eventId must match the AMQP messageId'
		);
	}
	if (metadata.kind && !expectedKinds.includes(metadata.kind)) {
		throw new Error(
			`Event type ${metadata.eventType} cannot be consumed by ${metadata.kind}`
		);
	}
	const routingMatches = expectedKinds.some(kind =>
		[
			MESSAGING_ROUTING_KEYS[kind],
			getDeadLetterRoutingKey(kind),
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
