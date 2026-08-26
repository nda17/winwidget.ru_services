import type { Prisma } from '@prisma/operations-client';
import {
	ADMIN_EVENT_LOG_ACTIONS,
	ADMIN_EVENT_LOG_SECTIONS,
	AdminEventLogAction,
	AdminEventLogRecordInput,
	AdminEventLogSection
} from '../admin-event-log/admin-event-log.contract';
import {
	OPERATIONS_AUDIT_EVENT_TYPE,
	OperationsAuditSource
} from './operations-messaging.constants';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CONTEXT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const FORBIDDEN_PAYLOAD_KEYS = new Set([
	'amocrmtoken',
	'apikey',
	'authorization',
	'bitrix24webhookurl',
	'clientsecret',
	'codehash',
	'databaseurl',
	'oauthaccesstoken',
	'oauthrefreshtoken',
	'otp',
	'otpcode',
	'password',
	'passwordhash',
	'privatekey',
	'refreshtoken',
	'refreshtokenhash',
	'secret',
	'secretkey',
	'smtppassword',
	'telegrambottoken',
	'telegramwebhooksecret',
	'token',
	'webhookurl'
]);
const CAMPAIGN_ACTIONS = [
	'CAMPAIGN_CREATE',
	'CAMPAIGN_CANCEL',
	'CAMPAIGN_DELIVERY_RETRY'
] as const;
const REPORTING_ACTIONS = [
	'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE',
	'REPORTING_DELIVERY_RETRY'
] as const;
const WIDGET_ACTIONS = [
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
const BILLING_ACTIONS = [
	'PAYMENT_MANUAL_CHECK',
	'PAYMENT_CLEANUP_RUN',
	'TARIFF_PRICES_UPDATE',
	'SUBSCRIPTION_ACTIVATE',
	'SUBSCRIPTION_EXTEND_DAYS',
	'SUBSCRIPTION_CANCEL',
	'SUBSCRIPTION_EXPIRY_CHECK_RUN',
	'AUTO_RENEWAL_ADMIN_PAUSE',
	'AUTO_RENEWAL_ADMIN_RESUME',
	'AUTO_RENEWAL_REVOKE',
	'AUTO_RENEWAL_RECONCILE',
	'AUTO_RENEWAL_TECHNICAL_RESUME',
	'AFFILIATE_SETTINGS_UPDATE',
	'SITE_SETTINGS_UPDATE',
	'BILLING_DELIVERY_RETRY'
] as const;
const IDENTITY_ACTIONS = [
	'USER_UPDATE',
	'USER_TOGGLE_ACTIVATION',
	'USER_SOFT_DELETE',
	'USER_RESTORE',
	'SITE_SETTINGS_UPDATE',
	'TELEGRAM_BOT_SETTINGS_UPDATE',
	'TELEGRAM_BOT_WEBHOOK_REINSTALL',
	'VERIFICATION_CHALLENGE_CLEANUP_RUN',
	'MESSAGING_FAILURE_RETRY',
	'MESSAGING_FAILURE_CLOSE_WITHOUT_RETRY'
] as const;
const PLATFORM_ACTIONS = [
	'PLATFORM_SITE_SETTINGS_UPDATE',
	'PLATFORM_LEGAL_PAGE_UPDATE',
	'PLATFORM_HOME_PAGE_CONTENT_UPDATE',
	'PLATFORM_HOME_PAGE_RAW_CODE_UPDATE'
] as const;
const SUPPORT_ACTIONS = [
	'SUPPORT_ROUTING_SETTINGS_UPDATE',
	'SUPPORT_WEBHOOK_REINSTALL',
	'SUPPORT_DELIVERY_RETRY',
	'SUPPORT_DELIVERY_CLOSE'
] as const;
const IDENTITY_USER_UPDATE_FIELDS = [
	'name',
	'avatarPath',
	'email',
	'phone',
	'isPhoneVerified',
	'isUser',
	'isAdmin',
	'isDev',
	'password'
] as const;
const IDENTITY_AUTH_SETTING_FIELDS = [
	'recaptchaEnabled',
	'googleAuthEnabled',
	'yandexAuthEnabled',
	'githubAuthEnabled',
	'vkAuthEnabled',
	'telegramAuthEnabled'
] as const;
const IDENTITY_REQUEST_METADATA_FIELDS = [
	'requestId',
	'requestIp',
	'requestUserAgent'
] as const;
const WIDGET_TYPES = [
	'WHEEL',
	'QUIZ',
	'CALLBACK',
	'TIMER',
	'STOP_OFFER',
	'ONLINE_CONSULTANT',
	'CALCULATOR'
] as const;
const WIDGET_INTEGRATIONS = ['webhook', 'bitrix24', 'amo-crm'] as const;
const REPORTING_CONSUMERS = [
	'identityUser',
	'billingPayment',
	'billingSubscription',
	'widget',
	'lead',
	'reportingSettings',
	'deliveryOutcome'
] as const;
const REPORTING_SETTINGS_FIELDS = [
	'enabled',
	'destinationChatId',
	'messageThreadId',
	'scheduleTime',
	'timezone'
] as const;

interface CommonAuditEvent {
	eventId: string;
	correlationId: string;
	actorId: string;
	action: AdminEventLogAction;
	payload: Record<string, unknown>;
}

export interface NormalizedAdminAuditEvent {
	eventId: string;
	record: AdminEventLogRecordInput;
}

export function parseAdminAuditEvent(
	source: OperationsAuditSource,
	value: unknown
): NormalizedAdminAuditEvent {
	const common = assertCommon(value);
	switch (source.kind) {
		case 'campaign-admin-audit':
			return mapCampaign(common);
		case 'reporting-admin-audit':
			return mapReporting(common);
		case 'widgets-admin-audit':
			return mapWidgets(common);
		case 'billing-admin-audit':
			return mapStructured(common, 'billing');
		case 'identity-admin-audit':
			return mapStructured(common, 'identity');
		case 'platform-admin-audit':
			return mapStructured(common, 'platform');
		case 'support-admin-audit':
			return mapStructured(common, 'support');
	}
}

function assertCommon(value: unknown): CommonAuditEvent {
	const payload = plainRecord(value, 'payload');
	assertNoForbiddenFields(payload);
	assertExactKeys(
		payload,
		[
			'schemaVersion',
			'eventType',
			'eventId',
			'occurredAt',
			'correlationId',
			'actorId',
			'action',
			'metadata'
		],
		['target', 'section', 'description', 'entity', 'actorSnapshot']
	);
	if (
		payload.schemaVersion !== 1 ||
		payload.eventType !== OPERATIONS_AUDIT_EVENT_TYPE
	) {
		throw new Error('Admin audit event version is invalid');
	}
	const eventId = uuid(payload.eventId, 'eventId');
	const correlationId = contextId(payload.correlationId, 'correlationId');
	const actorId = boundedString(payload.actorId, 'actorId', 256);
	const action = boundedString(payload.action, 'action', 120);
	if (!ADMIN_EVENT_LOG_ACTIONS.includes(action as AdminEventLogAction)) {
		throw new Error('Admin audit action is unsupported');
	}
	const occurredAt = boundedString(payload.occurredAt, 'occurredAt', 64);
	if (Number.isNaN(Date.parse(occurredAt))) {
		throw new Error('Admin audit occurredAt is invalid');
	}
	assertJsonValue(payload.metadata, 'metadata');
	return {
		eventId,
		correlationId,
		actorId,
		action: action as AdminEventLogAction,
		payload
	};
}

function mapCampaign(common: CommonAuditEvent): NormalizedAdminAuditEvent {
	assertAbsent(common.payload, [
		'section',
		'description',
		'entity',
		'actorSnapshot'
	]);
	if (!CAMPAIGN_ACTIONS.includes(common.action as never)) {
		throw new Error('Campaign admin audit action is invalid');
	}
	const target = plainRecord(common.payload.target, 'target');
	const deliveryAction = common.action === 'CAMPAIGN_DELIVERY_RETRY';
	assertExactKeys(
		target,
		deliveryAction ? ['campaignId', 'deliveryId'] : ['campaignId']
	);
	const campaignId = boundedString(target.campaignId, 'campaignId', 255);
	const deliveryId = deliveryAction
		? uuid(target.deliveryId, 'deliveryId')
		: null;
	uuid(campaignId, 'campaignId');
	uuid(common.correlationId, 'correlationId');
	const descriptions: Record<string, string> = {
		CAMPAIGN_CREATE: `Создана кампания ${campaignId}`,
		CAMPAIGN_CANCEL: `Запрошена отмена кампании ${campaignId}`,
		CAMPAIGN_DELIVERY_RETRY: `Повтор доставки ${deliveryId} кампании ${campaignId}`
	};
	const metadata = plainRecord(common.payload.metadata, 'metadata');
	if (deliveryAction) {
		assertExactKeys(metadata, ['channel', 'dispatchGeneration']);
		if (
			!['EMAIL', 'TELEGRAM'].includes(String(metadata.channel)) ||
			!Number.isSafeInteger(metadata.dispatchGeneration) ||
			Number(metadata.dispatchGeneration) < 1
		) {
			throw new Error('Campaign retry audit metadata is invalid');
		}
	} else if (common.action === 'CAMPAIGN_CREATE') {
		assertExactKeys(metadata, ['channel', 'audience']);
		if (
			!['EMAIL', 'TELEGRAM', 'BOTH'].includes(String(metadata.channel)) ||
			!['ALL', 'ACTIVE_SUBSCRIBERS'].includes(String(metadata.audience))
		) {
			throw new Error('Campaign create audit metadata is invalid');
		}
	} else {
		assertExactKeys(metadata, ['recipientCount']);
		if (
			!Number.isSafeInteger(metadata.recipientCount) ||
			Number(metadata.recipientCount) < 0
		) {
			throw new Error('Campaign cancel audit metadata is invalid');
		}
	}
	return {
		eventId: common.eventId,
		record: {
			id: common.eventId,
			adminId: common.actorId,
			section: 'CAMPAIGNS',
			action: common.action,
			description: descriptions[common.action],
			entityType: deliveryAction ? 'campaign-delivery' : 'campaign',
			entityId: deliveryId || campaignId,
			metadata: {
				eventId: common.eventId,
				correlationId: common.correlationId,
				campaignId,
				...(deliveryId ? { deliveryId } : {}),
				...(metadata as Prisma.InputJsonObject)
			}
		}
	};
}

function mapReporting(
	common: CommonAuditEvent
): NormalizedAdminAuditEvent {
	boundedString(common.actorId, 'actorId', 255);
	assertAbsent(common.payload, [
		'section',
		'description',
		'entity',
		'actorSnapshot'
	]);
	if (!REPORTING_ACTIONS.includes(common.action as never)) {
		throw new Error('Reporting admin audit action is invalid');
	}
	const target = plainRecord(common.payload.target, 'target');
	const metadata = plainRecord(common.payload.metadata, 'metadata');
	if (common.action === 'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE') {
		assertExactKeys(target, ['reportingSettingsId']);
		if (target.reportingSettingsId !== 'daily-summary') {
			throw new Error('Reporting settings target is invalid');
		}
		assertExactKeys(metadata, ['changedFields']);
		const changedFields = stringArray(
			metadata.changedFields,
			'changedFields',
			REPORTING_SETTINGS_FIELDS.length,
			80
		);
		if (
			changedFields.length < 1 ||
			changedFields.some(
				field => !REPORTING_SETTINGS_FIELDS.includes(field as never)
			) ||
			new Set(changedFields).size !== changedFields.length ||
			changedFields.join(',') !== [...changedFields].sort().join(',')
		) {
			throw new Error('Reporting changedFields are invalid');
		}
		return {
			eventId: common.eventId,
			record: {
				id: common.eventId,
				adminId: common.actorId,
				section: 'REPORTING',
				action: common.action,
				description: 'Обновлены настройки ежедневной сводки Reporting',
				entityType: 'reporting-settings',
				entityId: 'daily-summary',
				entityLabel: 'Ежедневная сводка',
				metadata: { changedFields }
			}
		};
	}
	assertExactKeys(target, ['eventId', 'consumerKind']);
	assertExactKeys(metadata, []);
	const targetEventId = uuid(target.eventId, 'target.eventId');
	const consumerKind = boundedString(
		target.consumerKind,
		'consumerKind',
		80
	);
	if (!REPORTING_CONSUMERS.includes(consumerKind as never)) {
		throw new Error('Reporting consumer kind is invalid');
	}
	return {
		eventId: common.eventId,
		record: {
			id: common.eventId,
			adminId: common.actorId,
			section: 'REPORTING',
			action: common.action,
			description: 'Запрошен повтор обработки события Reporting',
			entityType: 'reporting-delivery',
			entityId: targetEventId,
			entityLabel: consumerKind,
			metadata: {}
		}
	};
}

function mapWidgets(common: CommonAuditEvent): NormalizedAdminAuditEvent {
	boundedString(common.actorId, 'actorId', 255);
	assertAbsent(common.payload, [
		'section',
		'description',
		'entity',
		'actorSnapshot'
	]);
	if (!WIDGET_ACTIONS.includes(common.action as never)) {
		throw new Error('Widgets admin audit action is invalid');
	}
	const deliveryAction =
		common.action === 'WIDGET_DELIVERY_RETRY' ||
		common.action === 'WIDGET_DELIVERY_CLOSE';
	const target = plainRecord(common.payload.target, 'target');
	assertExactKeys(
		target,
		['widgetId', 'widgetType', 'ownerId'],
		deliveryAction ? ['failureId', 'integration'] : []
	);
	const widgetId = boundedString(target.widgetId, 'widgetId', 255);
	const widgetType = boundedString(target.widgetType, 'widgetType', 80);
	const ownerId = boundedString(target.ownerId, 'ownerId', 255);
	if (!WIDGET_TYPES.includes(widgetType as never)) {
		throw new Error('Widget audit type is invalid');
	}
	const failureId = deliveryAction
		? boundedString(target.failureId, 'failureId', 255)
		: undefined;
	const integration = deliveryAction
		? boundedString(target.integration, 'integration', 80)
		: undefined;
	if (integration && !WIDGET_INTEGRATIONS.includes(integration as never)) {
		throw new Error('Widget audit integration is invalid');
	}
	const descriptions: Record<string, string> = {
		WIDGET_UPDATE: 'Обновлён пользовательский виджет',
		WIDGET_PUBLISH: 'Опубликован пользовательский виджет',
		WIDGET_VERSION_RESTORE:
			'Восстановлена версия пользовательского виджета',
		WIDGET_CLONE: 'Клонирован пользовательский виджет',
		WIDGET_DRAFT_DISCARD:
			'Отброшены изменения черновика пользовательского виджета',
		WIDGET_BUTTON_IMAGE_UPDATE:
			'Обновлено изображение кнопки пользовательского виджета',
		WIDGET_DELETE: 'Удалён пользовательский виджет',
		WIDGET_DELIVERY_RETRY:
			'Запрошен повтор интеграции пользовательского виджета',
		WIDGET_DELIVERY_CLOSE:
			'Закрыта ошибка интеграции пользовательского виджета'
	};
	const metadata = validateWidgetMetadata(
		common.action,
		plainRecord(common.payload.metadata, 'metadata')
	);
	return {
		eventId: common.eventId,
		record: {
			id: common.eventId,
			adminId: common.actorId,
			section: 'WIDGETS',
			action: common.action,
			description: descriptions[common.action],
			entityType: deliveryAction
				? 'widget-integration-delivery'
				: 'widget',
			entityId: failureId || widgetId,
			entityLabel: widgetType,
			targetUserId: ownerId,
			metadata: {
				eventId: common.eventId,
				correlationId: common.correlationId,
				widgetId,
				widgetType,
				...(deliveryAction ? { failureId, integration } : {}),
				...(metadata as Prisma.InputJsonObject)
			}
		}
	};
}

function mapStructured(
	common: CommonAuditEvent,
	source: 'billing' | 'identity' | 'platform' | 'support'
): NormalizedAdminAuditEvent {
	boundedString(common.actorId, 'actorId', 255);
	if ('target' in common.payload) {
		throw new Error('Structured admin audit target is invalid');
	}
	const identitySnapshots = source === 'identity';
	if (identitySnapshots) {
		if (!('actorSnapshot' in common.payload)) {
			throw new Error('Identity admin audit snapshot is required');
		}
	} else if ('actorSnapshot' in common.payload) {
		throw new Error('Admin audit snapshot is not allowed');
	}
	const sourceActions =
		source === 'identity'
			? IDENTITY_ACTIONS
			: source === 'platform'
				? PLATFORM_ACTIONS
				: source === 'support'
					? SUPPORT_ACTIONS
					: BILLING_ACTIONS;
	if (!(sourceActions as readonly string[]).includes(common.action)) {
		throw new Error('Structured admin audit action is invalid');
	}
	const section = boundedString(common.payload.section, 'section', 80);
	if (
		!ADMIN_EVENT_LOG_SECTIONS.includes(section as AdminEventLogSection)
	) {
		throw new Error('Admin audit section is invalid');
	}
	const allowedSections: Record<typeof source, readonly string[]> = {
		billing: [
			'PAYMENTS',
			'SUBSCRIPTIONS',
			'AFFILIATE',
			'SITE_SETTINGS',
			'TASKS',
			'MESSAGING'
		],
		identity: [
			'USERS',
			'SITE_SETTINGS',
			'TELEGRAM_BOT',
			'TASKS',
			'MESSAGING'
		],
		platform: ['PLATFORM_CONTENT'],
		support: ['SUPPORT']
	};
	if (!allowedSections[source].includes(section)) {
		throw new Error('Admin audit source section is invalid');
	}
	const description = boundedString(
		common.payload.description,
		'description',
		2_000
	);
	const entity = plainRecord(common.payload.entity, 'entity');
	assertExactKeys(
		entity,
		['type', 'id', 'label', 'targetUserId'],
		identitySnapshots ? ['targetSnapshot'] : []
	);
	if (source === 'platform' && entity.targetUserId !== null) {
		throw new Error('Platform admin audit target user must be null');
	}
	if (source === 'support' && entity.targetUserId !== null) {
		throw new Error('Support admin audit target user must be null');
	}
	const metadata = plainRecord(common.payload.metadata, 'metadata');
	if (source === 'platform') {
		validatePlatformAudit(common.action, entity, metadata);
	}
	if (source === 'support') {
		validateSupportAudit(common.action, entity, metadata);
	}
	if (source === 'identity') {
		validateIdentityMetadata(common.action, metadata);
	}
	const requestIp =
		source === 'billing'
			? typeof metadata.requestIp === 'string'
				? metadata.requestIp
				: null
			: optionalString(metadata.requestIp, 'requestIp', 128);
	const requestUserAgent =
		source === 'billing'
			? typeof metadata.requestUserAgent === 'string'
				? metadata.requestUserAgent
				: null
			: optionalString(metadata.requestUserAgent, 'requestUserAgent', 500);
	const auditMetadata: Record<string, unknown> = { ...metadata };
	delete auditMetadata.requestIp;
	delete auditMetadata.requestUserAgent;
	let actorName: string | null = null;
	let actorEmail: string | null = null;
	let targetName: string | null = null;
	let targetEmail: string | null = null;
	if (identitySnapshots) {
		const actor = snapshot(common.payload.actorSnapshot, 'actorSnapshot');
		const target = snapshot(entity.targetSnapshot, 'targetSnapshot');
		actorName = actor.name;
		actorEmail = actor.email;
		targetName = target.name;
		targetEmail = target.email;
	}
	return {
		eventId: common.eventId,
		record: {
			id: common.eventId,
			adminId: common.actorId,
			adminName: actorName,
			adminEmail: actorEmail,
			section: section as AdminEventLogSection,
			action: common.action,
			description,
			entityType: boundedString(entity.type, 'entity.type', 255),
			entityId: boundedString(entity.id, 'entity.id', 255),
			entityLabel: nullableString(entity.label, 'entity.label', 10_000),
			targetUserId: nullableString(
				entity.targetUserId,
				'entity.targetUserId',
				10_000
			),
			targetUserName: targetName,
			targetUserEmail: targetEmail,
			ip: requestIp,
			userAgent: requestUserAgent,
			metadata: {
				...(auditMetadata as Prisma.InputJsonObject),
				eventId: common.eventId,
				correlationId: common.correlationId
			}
		}
	};
}

function validateSupportAudit(
	action: AdminEventLogAction,
	entity: Record<string, unknown>,
	metadata: Record<string, unknown>
): void {
	if (
		(action === 'SUPPORT_ROUTING_SETTINGS_UPDATE' &&
			(entity.type !== 'support_routing_settings' ||
				entity.id !== 'singleton')) ||
		(action === 'SUPPORT_WEBHOOK_REINSTALL' &&
			(entity.type !== 'support_webhook' || entity.id !== 'support')) ||
		((action === 'SUPPORT_DELIVERY_RETRY' ||
			action === 'SUPPORT_DELIVERY_CLOSE') &&
			(entity.type !== 'support_delivery_failure' ||
				typeof entity.id !== 'string'))
	) {
		throw new Error('Support admin audit entity is invalid');
	}
	if (
		action === 'SUPPORT_DELIVERY_RETRY' ||
		action === 'SUPPORT_DELIVERY_CLOSE'
	) {
		uuid(entity.id, 'entity.id');
	}
	const requestFields = ['actorRole', 'requestIp', 'requestUserAgent'];
	if (!['ADMIN', 'DEV'].includes(String(metadata.actorRole))) {
		throw new Error('Support actor role is invalid');
	}
	optionalString(metadata.requestIp, 'requestIp', 128);
	optionalString(metadata.requestUserAgent, 'requestUserAgent', 500);
	if (action === 'SUPPORT_ROUTING_SETTINGS_UPDATE') {
		assertExactKeys(metadata, [
			...requestFields,
			'adminChatIdConfigured',
			'supportThreadIdConfigured',
			'aggregateVersion'
		]);
		assertBoolean(metadata.adminChatIdConfigured, 'adminChatIdConfigured');
		assertBoolean(
			metadata.supportThreadIdConfigured,
			'supportThreadIdConfigured'
		);
		if (!/^[1-9][0-9]*$/.test(String(metadata.aggregateVersion))) {
			throw new Error('Support aggregateVersion is invalid');
		}
	} else if (action === 'SUPPORT_WEBHOOK_REINSTALL') {
		assertExactKeys(metadata, [
			...requestFields,
			'webhookMatchesExpected',
			'usernameMatchesConfigured',
			'dropPendingUpdates'
		]);
		assertBoolean(
			metadata.webhookMatchesExpected,
			'webhookMatchesExpected'
		);
		assertBoolean(
			metadata.usernameMatchesConfigured,
			'usernameMatchesConfigured'
		);
		assertBoolean(metadata.dropPendingUpdates, 'dropPendingUpdates');
	} else {
		assertExactKeys(
			metadata,
			action === 'SUPPORT_DELIVERY_RETRY'
				? [...requestFields, 'eventId', 'manualRetryCycle']
				: [...requestFields, 'eventId']
		);
		uuid(metadata.eventId, 'eventId');
		if (
			action === 'SUPPORT_DELIVERY_RETRY' &&
			(!Number.isSafeInteger(metadata.manualRetryCycle) ||
				Number(metadata.manualRetryCycle) < 1)
		) {
			throw new Error('Support manualRetryCycle is invalid');
		}
	}
}

function validatePlatformAudit(
	action: AdminEventLogAction,
	entity: Record<string, unknown>,
	metadata: Record<string, unknown>
): void {
	if (
		(action === 'PLATFORM_SITE_SETTINGS_UPDATE' &&
			(entity.type !== 'site_settings' || entity.id !== 'singleton')) ||
		(action === 'PLATFORM_LEGAL_PAGE_UPDATE' &&
			(entity.type !== 'legal_page' ||
				![
					'personal-policy',
					'consent-processing',
					'cookie-notice',
					'oferta'
				].includes(String(entity.id)))) ||
		((action === 'PLATFORM_HOME_PAGE_CONTENT_UPDATE' ||
			action === 'PLATFORM_HOME_PAGE_RAW_CODE_UPDATE') &&
			(entity.type !== 'home_page_content' || entity.id !== 'singleton'))
	) {
		throw new Error('Platform admin audit entity is invalid');
	}
	const requestFields = ['actorRole', 'requestIp', 'requestUserAgent'];
	if (action === 'PLATFORM_SITE_SETTINGS_UPDATE') {
		assertExactKeys(
			metadata,
			[...requestFields, 'changedFields', 'bannerTextChanged'],
			['bannerEnabled', 'snowflakeEnabled']
		);
		validateSortedChangedFields(metadata.changedFields, 64, 128);
		assertBoolean(metadata.bannerTextChanged, 'bannerTextChanged');
		for (const key of ['bannerEnabled', 'snowflakeEnabled'] as const) {
			if (metadata[key] !== undefined) {
				assertBoolean(metadata[key], key);
			}
		}
	} else if (action === 'PLATFORM_LEGAL_PAGE_UPDATE') {
		assertExactKeys(metadata, [
			...requestFields,
			'contentLength',
			'contentSha256'
		]);
		if (
			!Number.isInteger(metadata.contentLength) ||
			Number(metadata.contentLength) < 0 ||
			Number(metadata.contentLength) > 1_048_576
		) {
			throw new Error('Platform legal content length is invalid');
		}
		assertSha256(metadata.contentSha256, 'contentSha256');
	} else {
		assertExactKeys(metadata, [
			...requestFields,
			'updateKind',
			'changedFields',
			'contentBytes',
			'contentSha256'
		]);
		const expectedKind =
			action === 'PLATFORM_HOME_PAGE_CONTENT_UPDATE'
				? 'STRUCTURED'
				: 'RAW';
		if (metadata.updateKind !== expectedKind) {
			throw new Error('Platform update kind is invalid');
		}
		validateSortedChangedFields(metadata.changedFields, 64, 128);
		if (
			!Number.isInteger(metadata.contentBytes) ||
			Number(metadata.contentBytes) < 0 ||
			Number(metadata.contentBytes) > 1_048_576
		) {
			throw new Error('Platform home content bytes are invalid');
		}
		assertSha256(metadata.contentSha256, 'contentSha256');
	}
	if (!['ADMIN', 'DEV'].includes(String(metadata.actorRole))) {
		throw new Error('Platform actor role is invalid');
	}
	optionalString(metadata.requestIp, 'requestIp', 128);
	optionalString(metadata.requestUserAgent, 'requestUserAgent', 500);
}

function validateIdentityMetadata(
	action: AdminEventLogAction,
	metadata: Record<string, unknown>
): void {
	switch (action) {
		case 'USER_UPDATE':
			assertExactKeys(
				metadata,
				['changedFields', 'passwordChanged'],
				[...IDENTITY_REQUEST_METADATA_FIELDS]
			);
			validateIdentityChangedFields(
				metadata.changedFields,
				IDENTITY_USER_UPDATE_FIELDS
			);
			assertBoolean(metadata.passwordChanged, 'passwordChanged');
			break;
		case 'USER_TOGGLE_ACTIVATION':
		case 'USER_SOFT_DELETE':
		case 'USER_RESTORE': {
			assertExactKeys(
				metadata,
				['operation'],
				['commandId', ...IDENTITY_REQUEST_METADATA_FIELDS]
			);
			const operations =
				action === 'USER_TOGGLE_ACTIVATION'
					? ['ACTIVATE', 'DEACTIVATE']
					: action === 'USER_SOFT_DELETE'
						? ['DELETE']
						: ['RESTORE'];
			if (!operations.includes(String(metadata.operation))) {
				throw new Error('Identity operation is invalid');
			}
			if (metadata.commandId !== undefined) {
				uuid(metadata.commandId, 'commandId');
			}
			break;
		}
		case 'SITE_SETTINGS_UPDATE':
			assertExactKeys(
				metadata,
				['changedFields'],
				[
					...IDENTITY_AUTH_SETTING_FIELDS,
					...IDENTITY_REQUEST_METADATA_FIELDS
				]
			);
			validateIdentityChangedFields(
				metadata.changedFields,
				IDENTITY_AUTH_SETTING_FIELDS
			);
			for (const key of IDENTITY_AUTH_SETTING_FIELDS) {
				if (metadata[key] !== undefined) assertBoolean(metadata[key], key);
			}
			break;
		case 'TELEGRAM_BOT_SETTINGS_UPDATE': {
			const fields = [
				'authTelegramBotTokenConfigured',
				'authTelegramBotUsernameConfigured'
			] as const;
			assertExactKeys(
				metadata,
				['changedFields'],
				[...fields, ...IDENTITY_REQUEST_METADATA_FIELDS]
			);
			validateIdentityChangedFields(metadata.changedFields, fields);
			for (const key of fields) {
				if (metadata[key] !== undefined) assertBoolean(metadata[key], key);
			}
			break;
		}
		case 'TELEGRAM_BOT_WEBHOOK_REINSTALL':
			assertExactKeys(
				metadata,
				[
					'bot',
					'title',
					'dropPendingUpdates',
					'allowedUpdates',
					'secretConfigured',
					'installedAt'
				],
				[...IDENTITY_REQUEST_METADATA_FIELDS]
			);
			if (!['auth', 'info'].includes(String(metadata.bot))) {
				throw new Error('Identity Telegram bot is invalid');
			}
			boundedString(metadata.title, 'title', 100);
			assertBoolean(metadata.dropPendingUpdates, 'dropPendingUpdates');
			if (
				!Array.isArray(metadata.allowedUpdates) ||
				metadata.allowedUpdates.some(
					item => !['message', 'callback_query'].includes(String(item))
				)
			) {
				throw new Error('Identity allowedUpdates are invalid');
			}
			assertBoolean(metadata.secretConfigured, 'secretConfigured');
			isoDate(metadata.installedAt, 'installedAt');
			break;
		case 'VERIFICATION_CHALLENGE_CLEANUP_RUN':
			assertExactKeys(
				metadata,
				['taskId', 'title', 'affectedCount', 'message', 'executedAt'],
				[...IDENTITY_REQUEST_METADATA_FIELDS]
			);
			if (metadata.taskId !== 'verificationChallengeCleanup') {
				throw new Error('Identity cleanup task is invalid');
			}
			boundedString(metadata.title, 'title', 255);
			if (
				!Number.isSafeInteger(metadata.affectedCount) ||
				Number(metadata.affectedCount) < 0
			) {
				throw new Error('Identity affectedCount is invalid');
			}
			boundedString(metadata.message, 'message', 2_000);
			isoDate(metadata.executedAt, 'executedAt');
			break;
		case 'MESSAGING_FAILURE_RETRY':
			assertExactKeys(
				metadata,
				['integration'],
				[...IDENTITY_REQUEST_METADATA_FIELDS]
			);
			if (metadata.integration !== 'telegram-destination-unavailable') {
				throw new Error('Identity integration is invalid');
			}
			break;
		case 'MESSAGING_FAILURE_CLOSE_WITHOUT_RETRY':
			assertExactKeys(
				metadata,
				['integration', 'comment'],
				[...IDENTITY_REQUEST_METADATA_FIELDS]
			);
			if (metadata.integration !== 'telegram-destination-unavailable') {
				throw new Error('Identity integration is invalid');
			}
			const comment = boundedString(metadata.comment, 'comment', 1_000);
			if (comment !== comment.trim() || comment.length < 3) {
				throw new Error('Identity resolution comment is invalid');
			}
			break;
	}
	if (metadata.requestId !== undefined) {
		boundedString(metadata.requestId, 'requestId', 128);
	}
	if (metadata.requestIp !== undefined) {
		boundedString(metadata.requestIp, 'requestIp', 128);
	}
	if (metadata.requestUserAgent !== undefined) {
		boundedString(metadata.requestUserAgent, 'requestUserAgent', 500);
	}
}

function validateIdentityChangedFields(
	value: unknown,
	allowed: readonly string[]
): void {
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > allowed.length ||
		value.some(
			item => typeof item !== 'string' || !allowed.includes(item)
		) ||
		new Set(value).size !== value.length
	) {
		throw new Error('Identity changedFields are invalid');
	}
}

function validateSortedChangedFields(
	value: unknown,
	maximumItems: number,
	maximumLength: number
): void {
	const fields = stringArray(
		value,
		'changedFields',
		maximumItems,
		maximumLength
	);
	if (
		fields.length < 1 ||
		new Set(fields).size !== fields.length ||
		fields.join(',') !== [...fields].sort().join(',')
	) {
		throw new Error('Admin audit changedFields are invalid');
	}
}

function assertBoolean(value: unknown, name: string): void {
	if (typeof value !== 'boolean') {
		throw new Error(`Admin audit ${name} must be a boolean`);
	}
}

function assertSha256(value: unknown, name: string): void {
	if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
		throw new Error(`Admin audit ${name} must be SHA-256`);
	}
}

function isoDate(value: unknown, name: string): string {
	const string = boundedString(value, name, 10_000);
	if (!Number.isFinite(Date.parse(string))) {
		throw new Error(`Admin audit ${name} must be an ISO date`);
	}
	return string;
}

function validateWidgetMetadata(
	action: AdminEventLogAction,
	metadata: Record<string, unknown>
): Record<string, unknown> {
	switch (action) {
		case 'WIDGET_UPDATE': {
			assertExactKeys(metadata, ['changedFields']);
			const changedFields = stringArray(
				metadata.changedFields,
				'changedFields',
				100,
				100
			);
			if (
				changedFields.length < 1 ||
				new Set(changedFields).size !== changedFields.length ||
				changedFields.join(',') !== [...changedFields].sort().join(',')
			) {
				throw new Error('Widget changedFields are invalid');
			}
			return { changedFields };
		}
		case 'WIDGET_PUBLISH':
		case 'WIDGET_VERSION_RESTORE': {
			assertExactKeys(metadata, ['version']);
			const version = metadata.version;
			if (!Number.isSafeInteger(version) || Number(version) < 1) {
				throw new Error('Widget audit version is invalid');
			}
			return { version };
		}
		case 'WIDGET_CLONE':
			assertExactKeys(metadata, ['sourceWidgetId']);
			return {
				sourceWidgetId: boundedString(
					metadata.sourceWidgetId,
					'sourceWidgetId',
					255
				)
			};
		case 'WIDGET_BUTTON_IMAGE_UPDATE':
			assertExactKeys(metadata, ['imagePresent']);
			if (typeof metadata.imagePresent !== 'boolean') {
				throw new Error('Widget audit imagePresent is invalid');
			}
			return { imagePresent: metadata.imagePresent };
		case 'WIDGET_DELIVERY_CLOSE':
			assertExactKeys(metadata, ['commentPresent', 'commentLength']);
			if (
				metadata.commentPresent !== true ||
				!Number.isSafeInteger(metadata.commentLength) ||
				Number(metadata.commentLength) < 1 ||
				Number(metadata.commentLength) > 1_000
			) {
				throw new Error('Widget close audit metadata is invalid');
			}
			return {
				commentPresent: true,
				commentLength: metadata.commentLength
			};
		default:
			assertExactKeys(metadata, []);
			return {};
	}
}

function snapshot(value: unknown, name: string) {
	const item = plainRecord(value, name);
	assertExactKeys(item, ['name', 'email']);
	return {
		name: nullableString(item.name, `${name}.name`, 10_000),
		email: nullableString(item.email, `${name}.email`, 10_000)
	};
}

function plainRecord(
	value: unknown,
	name: string
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Admin audit ${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

function assertExactKeys(
	value: Record<string, unknown>,
	required: string[],
	optional: string[] = []
): void {
	const allowed = new Set([...required, ...optional]);
	if (
		required.some(key => !(key in value)) ||
		Object.keys(value).some(key => !allowed.has(key))
	) {
		throw new Error('Admin audit object keys are invalid');
	}
}

function assertAbsent(
	value: Record<string, unknown>,
	keys: string[]
): void {
	if (keys.some(key => key in value)) {
		throw new Error('Admin audit object contains invalid fields');
	}
}

function boundedString(
	value: unknown,
	name: string,
	maximum: number
): string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		value.length > maximum
	) {
		throw new Error(`Admin audit ${name} is invalid`);
	}
	return value;
}

function optionalString(
	value: unknown,
	name: string,
	maximum: number
): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string' || value.length > maximum) {
		throw new Error(`Admin audit ${name} is invalid`);
	}
	return value;
}

function nullableString(
	value: unknown,
	name: string,
	maximum: number
): string | null {
	if (value === null) return null;
	if (typeof value !== 'string' || value.length > maximum) {
		throw new Error(`Admin audit ${name} is invalid`);
	}
	return value;
}

function uuid(value: unknown, name: string): string {
	const normalized = boundedString(value, name, 36).toLowerCase();
	if (!UUID_PATTERN.test(normalized)) {
		throw new Error(`Admin audit ${name} must be a UUID`);
	}
	return normalized;
}

function contextId(value: unknown, name: string): string {
	if (typeof value !== 'string' || !SAFE_CONTEXT_ID_PATTERN.test(value)) {
		throw new Error(`Admin audit ${name} is invalid`);
	}
	return value;
}

function stringArray(
	value: unknown,
	name: string,
	maximumItems: number,
	maximumLength: number
): string[] {
	if (!Array.isArray(value) || value.length > maximumItems) {
		throw new Error(`Admin audit ${name} is invalid`);
	}
	return value.map(item => boundedString(item, name, maximumLength));
}

function assertJsonValue(value: unknown, name: string, depth = 0): void {
	if (depth > 8)
		throw new Error(`Admin audit ${name} is too deeply nested`);
	if (
		value === null ||
		typeof value === 'boolean' ||
		typeof value === 'number'
	) {
		if (typeof value === 'number' && !Number.isFinite(value)) {
			throw new Error(`Admin audit ${name} number is invalid`);
		}
		return;
	}
	if (typeof value === 'string') {
		if (value.length > 16 * 1024) {
			throw new Error(`Admin audit ${name} string is too long`);
		}
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > 128) {
			throw new Error(`Admin audit ${name} array is too long`);
		}
		value.forEach(item => assertJsonValue(item, name, depth + 1));
		return;
	}
	const record = plainRecord(value, name);
	const entries = Object.entries(record);
	if (entries.length > 128) {
		throw new Error(`Admin audit ${name} object is too large`);
	}
	entries.forEach(([key, item]) => {
		if (!key || key.length > 160) {
			throw new Error(`Admin audit ${name} key is invalid`);
		}
		assertJsonValue(item, name, depth + 1);
	});
}

function assertNoForbiddenFields(value: unknown, depth = 0): void {
	if (depth > 20) {
		throw new Error('Admin audit payload is too deeply nested');
	}
	if (Array.isArray(value)) {
		value.forEach(item => assertNoForbiddenFields(item, depth + 1));
		return;
	}
	if (!value || typeof value !== 'object') return;
	for (const [key, nested] of Object.entries(value)) {
		if (FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
			throw new Error('Admin audit payload contains a forbidden field');
		}
		assertNoForbiddenFields(nested, depth + 1);
	}
}
