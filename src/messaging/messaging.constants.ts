export const RABBITMQ_CONNECTION = Symbol('RABBITMQ_CONNECTION');

export const OUTBOX_EVENT_TYPE = 'lead.integration.requested.v2';
export const PAYMENT_SUCCEEDED_EVENT_TYPE = 'payment.succeeded.v1';
export const PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE =
	'payment.notification.telegram.requested.v1';
export const AUTO_RENEWAL_CHARGE_EVENT_TYPE =
	'payment.auto-renewal.charge.requested.v1';
export const LIMIT_REACHED_EMAIL_EVENT_TYPE =
	'lead.limit.reached.email.v2';
export const LIMIT_REACHED_TELEGRAM_EVENT_TYPE =
	'lead.limit.reached.telegram.v2';
export const TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE =
	'notification.telegram.destination-unavailable.v1';
export const CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE =
	'notification.campaign.email.requested.v2';
export const CAMPAIGN_TELEGRAM_NOTIFICATION_EVENT_TYPE =
	'notification.campaign.telegram.requested.v2';
export const SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE =
	'notification.subscription-expiry.email.requested.v1';
export const SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE =
	'notification.subscription-expiry.telegram.requested.v1';
export const NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE =
	'notification.delivery.outcome.v1';
export const ADMIN_AUDIT_EVENT_TYPE = 'admin.audit.event.v1';
export const CAMPAIGN_ADMIN_AUDIT_EVENT_TYPE = ADMIN_AUDIT_EVENT_TYPE;
export const REPORTING_ADMIN_AUDIT_ROUTING_KEY =
	'admin.audit.reporting.v1';
export const WIDGETS_ADMIN_AUDIT_ROUTING_KEY = 'admin.audit.widgets.v1';
export const BILLING_ADMIN_AUDIT_ROUTING_KEY = 'admin.audit.billing.v1';
export const BILLING_IDENTITY_EVENT_TYPE = 'billing.identity.changed.v1';
export const BILLING_TRIAL_REQUESTED_EVENT_TYPE =
	'billing.trial.requested.v1';
export const BILLING_REFERRAL_REQUESTED_EVENT_TYPE =
	'billing.referral.requested.v1';
export const BILLING_NOTIFICATION_ROUTING_EVENT_TYPE =
	'billing.notification-routing.changed.v1';
export const BILLING_LIFECYCLE_REPAIR_EVENT_TYPE =
	'billing.lifecycle-repair.requested.v1';
export const BILLING_OFFER_EVENT_TYPE = 'billing.offer.changed.v1';
export const BILLING_PAYMENT_DETAILS_EVENT_TYPE =
	'billing.payment.details.changed.v1';
export const BILLING_SUBSCRIPTION_DETAILS_EVENT_TYPE =
	'billing.subscription.details.changed.v1';
export const BILLING_AFFILIATE_EVENT_TYPE = 'billing.affiliate.changed.v1';
export const BILLING_SETTINGS_SOURCE_EVENT_TYPE =
	'billing.settings.source.changed.v1';
export const BILLING_SETTINGS_EVENT_TYPE = 'billing.settings.changed.v1';
export const DATABASE_BACKUP_EVENT_TYPE = 'database.backup.requested.v1';
export const REPORTING_IDENTITY_USER_EVENT_TYPE =
	'identity.user.changed.v1';
export const REPORTING_BILLING_PAYMENT_EVENT_TYPE =
	'billing.payment.changed.v1';
export const REPORTING_BILLING_SUBSCRIPTION_EVENT_TYPE =
	'billing.subscription.changed.v1';
export const REPORTING_WIDGET_EVENT_TYPE = 'widgets.widget.changed.v1';
export const REPORTING_LEAD_EVENT_TYPE = 'widgets.lead.changed.v1';
export const REPORTING_CORE_OPERATIONAL_ROUTING_EVENT_TYPE =
	'reporting.core-operational-routing.changed.v1';
export const EVENTS_EXCHANGE = 'winwidget.events';
export const RETRY_EXCHANGE = 'winwidget.retry';
export const DEAD_LETTER_EXCHANGE = 'winwidget.dead-letter';
export const MANUAL_RETRY_EXCHANGE = 'winwidget.manual-retry';

export const INTEGRATION_KINDS = [
	'email',
	'webhook',
	'telegram',
	'bitrix24',
	'amo-crm',
	'payment-email',
	'payment-telegram',
	'limit-email',
	'limit-telegram',
	'telegram-destination-unavailable',
	'campaign-email',
	'campaign-telegram',
	'subscription-expiry-email',
	'subscription-expiry-telegram',
	'notification-delivery-outcome',
	'campaign-admin-audit',
	'reporting-admin-audit',
	'widgets-admin-audit',
	'billing-admin-audit',
	'billing-payment-projection',
	'billing-subscription-projection',
	'billing-affiliate-projection',
	'billing-settings-projection',
	'auto-renewal'
] as const;

export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export const NOTIFICATION_DELIVERY_KINDS = [
	'email',
	'telegram',
	'payment-email',
	'payment-telegram',
	'limit-email',
	'limit-telegram',
	'campaign-email',
	'campaign-telegram',
	'subscription-expiry-email',
	'subscription-expiry-telegram'
] as const satisfies readonly IntegrationKind[];

export type NotificationDeliveryKind =
	(typeof NOTIFICATION_DELIVERY_KINDS)[number];

export const WIDGETS_PROVIDER_INTEGRATION_KINDS = [
	'webhook',
	'bitrix24',
	'amo-crm'
] as const satisfies readonly IntegrationKind[];

export type WidgetsProviderIntegrationKind =
	(typeof WIDGETS_PROVIDER_INTEGRATION_KINDS)[number];

export const CORE_OWNED_INTEGRATION_KINDS = [
	'telegram-destination-unavailable',
	'notification-delivery-outcome',
	'campaign-admin-audit',
	'reporting-admin-audit',
	'widgets-admin-audit',
	'billing-admin-audit',
	'billing-payment-projection',
	'billing-subscription-projection',
	'billing-affiliate-projection',
	'billing-settings-projection',
	'auto-renewal'
] as const satisfies readonly IntegrationKind[];

export type MonolithIntegrationKind =
	(typeof CORE_OWNED_INTEGRATION_KINDS)[number];

export const MONOLITH_INTEGRATION_KINDS = CORE_OWNED_INTEGRATION_KINDS;

export const MAINTENANCE_KINDS = ['database-backup'] as const;

export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];

export const REPORTING_PROJECTION_KINDS = [
	'reporting-identity-user',
	'reporting-billing-payment',
	'reporting-billing-subscription',
	'reporting-widget',
	'reporting-lead',
	'reporting-settings'
] as const;

export type ReportingProjectionKind =
	(typeof REPORTING_PROJECTION_KINDS)[number];

export const BILLING_SOURCE_KINDS = [
	'billing-identity-source',
	'billing-trial-source',
	'billing-referral-source',
	'billing-notification-routing-source',
	'billing-lifecycle-repair-source',
	'billing-offer-source',
	'billing-settings-source'
] as const;

export type BillingSourceKind = (typeof BILLING_SOURCE_KINDS)[number];

export const MESSAGING_KINDS = [
	...INTEGRATION_KINDS,
	...MAINTENANCE_KINDS
] as const;

export type CoreMessagingKind = (typeof MESSAGING_KINDS)[number];
export type MessagingKind =
	| CoreMessagingKind
	| ReportingProjectionKind
	| BillingSourceKind;

// MESSAGING_KINDS is the federated monitoring/admin contract. Topology ownership
// is narrower: Widgets owns its provider queues and Core must not recreate them
// after the ownership handoff.
export const CORE_RABBITMQ_TOPOLOGY_KINDS = [
	...NOTIFICATION_DELIVERY_KINDS,
	...CORE_OWNED_INTEGRATION_KINDS,
	...MAINTENANCE_KINDS
] as const satisfies readonly CoreMessagingKind[];

export const CORE_OWNED_MESSAGING_KINDS = [
	...CORE_OWNED_INTEGRATION_KINDS,
	...MAINTENANCE_KINDS
] as const satisfies readonly CoreMessagingKind[];

export const MESSAGING_ROUTING_KEYS: Record<MessagingKind, string> = {
	email: 'lead.integration.email.v2',
	webhook: 'lead.integration.webhook.v2',
	telegram: 'lead.integration.telegram.v2',
	bitrix24: 'lead.integration.bitrix24.v2',
	'amo-crm': 'lead.integration.amo-crm.v2',
	'payment-email': PAYMENT_SUCCEEDED_EVENT_TYPE,
	'payment-telegram': PAYMENT_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	'limit-email': LIMIT_REACHED_EMAIL_EVENT_TYPE,
	'limit-telegram': LIMIT_REACHED_TELEGRAM_EVENT_TYPE,
	'telegram-destination-unavailable':
		TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE,
	'campaign-email': CAMPAIGN_EMAIL_NOTIFICATION_EVENT_TYPE,
	'campaign-telegram': CAMPAIGN_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	'subscription-expiry-email':
		SUBSCRIPTION_EXPIRY_EMAIL_NOTIFICATION_EVENT_TYPE,
	'subscription-expiry-telegram':
		SUBSCRIPTION_EXPIRY_TELEGRAM_NOTIFICATION_EVENT_TYPE,
	'notification-delivery-outcome':
		NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	'campaign-admin-audit': CAMPAIGN_ADMIN_AUDIT_EVENT_TYPE,
	'reporting-admin-audit': REPORTING_ADMIN_AUDIT_ROUTING_KEY,
	'widgets-admin-audit': WIDGETS_ADMIN_AUDIT_ROUTING_KEY,
	'auto-renewal': AUTO_RENEWAL_CHARGE_EVENT_TYPE,
	'billing-admin-audit': BILLING_ADMIN_AUDIT_ROUTING_KEY,
	'billing-payment-projection': BILLING_PAYMENT_DETAILS_EVENT_TYPE,
	'billing-subscription-projection':
		BILLING_SUBSCRIPTION_DETAILS_EVENT_TYPE,
	'billing-affiliate-projection': BILLING_AFFILIATE_EVENT_TYPE,
	'billing-settings-projection': BILLING_SETTINGS_EVENT_TYPE,
	'database-backup': DATABASE_BACKUP_EVENT_TYPE,
	'reporting-identity-user': REPORTING_IDENTITY_USER_EVENT_TYPE,
	'reporting-billing-payment': REPORTING_BILLING_PAYMENT_EVENT_TYPE,
	'reporting-billing-subscription':
		REPORTING_BILLING_SUBSCRIPTION_EVENT_TYPE,
	'reporting-widget': REPORTING_WIDGET_EVENT_TYPE,
	'reporting-lead': REPORTING_LEAD_EVENT_TYPE,
	'reporting-settings': REPORTING_CORE_OPERATIONAL_ROUTING_EVENT_TYPE,
	'billing-identity-source': BILLING_IDENTITY_EVENT_TYPE,
	'billing-trial-source': BILLING_TRIAL_REQUESTED_EVENT_TYPE,
	'billing-referral-source': BILLING_REFERRAL_REQUESTED_EVENT_TYPE,
	'billing-notification-routing-source':
		BILLING_NOTIFICATION_ROUTING_EVENT_TYPE,
	'billing-lifecycle-repair-source': BILLING_LIFECYCLE_REPAIR_EVENT_TYPE,
	'billing-offer-source': BILLING_OFFER_EVENT_TYPE,
	'billing-settings-source': BILLING_SETTINGS_SOURCE_EVENT_TYPE
};

export const MESSAGING_QUEUE_NAMES: Record<MessagingKind, string> = {
	email: 'winwidget.lead-integration.email',
	webhook: 'winwidget.lead-integration.webhook',
	telegram: 'winwidget.lead-integration.telegram',
	bitrix24: 'winwidget.lead-integration.bitrix24',
	'amo-crm': 'winwidget.lead-integration.amo-crm',
	'payment-email': 'winwidget.payment-notification.email',
	'payment-telegram': 'winwidget.payment-notification.telegram.v2',
	'limit-email': 'winwidget.limit-notification.email',
	'limit-telegram': 'winwidget.limit-notification.telegram',
	'telegram-destination-unavailable':
		'winwidget.notification.telegram-destination-unavailable',
	'campaign-email': 'winwidget.notification.campaign.email.v2',
	'campaign-telegram': 'winwidget.notification.campaign.telegram.v2',
	'subscription-expiry-email':
		'winwidget.notification.subscription-expiry.email',
	'subscription-expiry-telegram':
		'winwidget.notification.subscription-expiry.telegram',
	'notification-delivery-outcome':
		'winwidget.notification.delivery-outcome',
	'campaign-admin-audit': 'winwidget.admin.audit.campaigns.v1',
	'reporting-admin-audit': 'winwidget.admin.audit.reporting.v1',
	'widgets-admin-audit': 'winwidget.admin.audit.widgets.v1',
	'auto-renewal': 'winwidget.payment.auto-renewal',
	'billing-admin-audit': 'winwidget.admin.audit.billing.v1',
	'billing-payment-projection':
		'winwidget.core.billing.payment-details.v1',
	'billing-subscription-projection':
		'winwidget.core.billing.subscription-details.v1',
	'billing-affiliate-projection': 'winwidget.core.billing.affiliate.v1',
	'billing-settings-projection': 'winwidget.core.billing.settings.v1',
	'database-backup': 'winwidget.maintenance.database-backup',
	'reporting-identity-user': 'winwidget.reporting.identity-user',
	'reporting-billing-payment': 'winwidget.reporting.billing-payment',
	'reporting-billing-subscription':
		'winwidget.reporting.billing-subscription',
	'reporting-widget': 'winwidget.reporting.widget',
	'reporting-lead': 'winwidget.reporting.lead',
	'reporting-settings': 'winwidget.reporting.settings',
	'billing-identity-source': 'winwidget.billing.identity.v1',
	'billing-trial-source': 'winwidget.billing.trial.v1',
	'billing-referral-source': 'winwidget.billing.referral.v1',
	'billing-notification-routing-source':
		'winwidget.billing.notification-routing.v1',
	'billing-lifecycle-repair-source':
		'winwidget.billing.lifecycle-repair.v1',
	'billing-offer-source': 'winwidget.billing.offer.v1',
	'billing-settings-source': 'winwidget.billing.settings-source.v1'
};

export type MessagingQueueHealthExpectation = Readonly<{
	name: string;
	consumerExpectation: 'at-least-one' | 'none';
	alertOnAnyMessage: boolean;
}>;

const WIDGETS_PROVIDER_KIND_SET: ReadonlySet<CoreMessagingKind> = new Set(
	WIDGETS_PROVIDER_INTEGRATION_KINDS
);

// Passive DLQ are durable holding queues: manual retry is driven by the
// delivery-failure record, so a steady-state RabbitMQ consumer must not drain
// them. They must still exist, stay empty and alert on the first message.
export const getMessagingQueueHealthExpectations = (options: {
	billingOwner: boolean;
}): readonly MessagingQueueHealthExpectation[] =>
	MESSAGING_KINDS.flatMap(kind => {
		const mainQueue = MESSAGING_QUEUE_NAMES[kind];
		const passiveDeadLetter =
			WIDGETS_PROVIDER_KIND_SET.has(kind) ||
			(options.billingOwner && kind === 'auto-renewal');

		return [
			{
				name: mainQueue,
				consumerExpectation: 'at-least-one' as const,
				alertOnAnyMessage: false
			},
			{
				name: `${mainQueue}.dead-letter`,
				consumerExpectation: passiveDeadLetter
					? ('none' as const)
					: ('at-least-one' as const),
				alertOnAnyMessage: passiveDeadLetter
			}
		];
	});

export const INTEGRATION_ROUTING_KEYS = MESSAGING_ROUTING_KEYS;
export const INTEGRATION_QUEUE_NAMES = MESSAGING_QUEUE_NAMES;

export const getManualRetryRoutingKey = (kind: MessagingKind): string =>
	`manual.${kind}`;

export const getDeadLetterRoutingKey = (kind: MessagingKind): string =>
	`${kind}.dead-letter`;

export const RETRY_DELAYS_MS = [30_000, 300_000, 1_800_000] as const;
export const OUTBOX_DEFAULT_BATCH_SIZE = 50;
export const OUTBOX_DEFAULT_POLL_INTERVAL_MS = 1000;
export const OUTBOX_LOCK_TIMEOUT_MS = 60_000;
export const OUTBOX_DEFAULT_RETENTION_DAYS = 7;
