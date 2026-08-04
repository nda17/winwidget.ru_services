import {
	REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	type ReportingProjectionStream,
	type ReportingSourceEventType
} from '../projections/reporting-event.contract';

export const REPORTING_EVENTS_EXCHANGE = 'winwidget.events';
export const REPORTING_RETRY_EXCHANGE = 'winwidget.reporting.retry';
export const REPORTING_MANUAL_RETRY_EXCHANGE =
	'winwidget.reporting.manual-retry';
export const REPORTING_DEAD_LETTER_EXCHANGE = 'winwidget.dead-letter';
export const DAILY_SUMMARY_NOTIFICATION_EVENT_TYPE =
	'notification.daily-summary.telegram.requested.v1';
export const DAILY_SUMMARY_NOTIFICATION_DELIVERY_KIND =
	'daily-summary-delivery-telegram' as const;
export const REPORTING_NOTIFICATION_DELIVERY_KINDS = [
	DAILY_SUMMARY_NOTIFICATION_DELIVERY_KIND
] as const;
export const REPORTING_NOTIFICATION_DELIVERY_ROUTING_KEYS = {
	[DAILY_SUMMARY_NOTIFICATION_DELIVERY_KIND]:
		DAILY_SUMMARY_NOTIFICATION_EVENT_TYPE
} as const;
export const ADMIN_AUDIT_EVENT_TYPE = 'admin.audit.event.v1';
export const REPORTING_ADMIN_AUDIT_ROUTING_KEY =
	'admin.audit.reporting.v1';
export const DELIVERY_OUTCOME_EVENT_TYPE =
	REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE;
export const CORE_OPERATIONAL_ROUTING_EVENT_TYPE =
	'reporting.core-operational-routing.changed.v1';

export const REPORTING_CONSUMER_KINDS = [
	'identityUser',
	'billingPayment',
	'billingSubscription',
	'widget',
	'lead',
	'reportingSettings',
	'deliveryOutcome'
] as const;

export type ReportingConsumerKind =
	(typeof REPORTING_CONSUMER_KINDS)[number];

export const REPORTING_QUEUE_NAMES: Record<ReportingConsumerKind, string> =
	{
		identityUser: 'winwidget.reporting.identity-user',
		billingPayment: 'winwidget.reporting.billing-payment',
		billingSubscription: 'winwidget.reporting.billing-subscription',
		widget: 'winwidget.reporting.widget',
		lead: 'winwidget.reporting.lead',
		reportingSettings: 'winwidget.reporting.settings',
		deliveryOutcome: 'winwidget.reporting.delivery-outcome'
	};

export const REPORTING_ROUTING_KEYS: Record<
	ReportingConsumerKind,
	ReportingSourceEventType | typeof DELIVERY_OUTCOME_EVENT_TYPE
> = {
	identityUser: 'identity.user.changed.v1',
	billingPayment: 'billing.payment.changed.v1',
	billingSubscription: 'billing.subscription.changed.v1',
	widget: 'widgets.widget.changed.v1',
	lead: 'widgets.lead.changed.v1',
	reportingSettings: CORE_OPERATIONAL_ROUTING_EVENT_TYPE,
	deliveryOutcome: DELIVERY_OUTCOME_EVENT_TYPE
};

export const REPORTING_ACCEPTED_ROUTING_KEYS: Record<
	ReportingConsumerKind,
	readonly (
		| ReportingSourceEventType
		| typeof DELIVERY_OUTCOME_EVENT_TYPE
	)[]
> = {
	identityUser: ['identity.user.changed.v1'],
	billingPayment: ['billing.payment.changed.v1'],
	billingSubscription: ['billing.subscription.changed.v1'],
	widget: ['widgets.widget.changed.v1'],
	lead: ['widgets.lead.changed.v1'],
	reportingSettings: [CORE_OPERATIONAL_ROUTING_EVENT_TYPE],
	deliveryOutcome: [DELIVERY_OUTCOME_EVENT_TYPE]
};

export const REPORTING_ACCEPTED_PROJECTION_EVENT_TYPES: Record<
	ReportingProjectionStream,
	readonly ReportingSourceEventType[]
> = {
	identityUser: ['identity.user.changed.v1'],
	billingPayment: ['billing.payment.changed.v1'],
	billingSubscription: ['billing.subscription.changed.v1'],
	widget: ['widgets.widget.changed.v1'],
	lead: ['widgets.lead.changed.v1'],
	reportingSettings: [CORE_OPERATIONAL_ROUTING_EVENT_TYPE]
};

export const REPORTING_CONSUMERS: Record<ReportingConsumerKind, string> = {
	identityUser: 'reporting-identity-user-v1',
	billingPayment: 'reporting-billing-payment-v1',
	billingSubscription: 'reporting-billing-subscription-v1',
	widget: 'reporting-widget-v1',
	lead: 'reporting-lead-v1',
	reportingSettings: 'reporting-settings-v1',
	deliveryOutcome: 'reporting-delivery-outcome-v1'
};

export const REPORTING_RETRY_DELAYS_MS = [
	30_000, 300_000, 1_800_000
] as const;

export const getReportingRetryRoutingKey = (
	kind: ReportingConsumerKind,
	index: number
): string => `${kind}.retry.${index + 1}`;

export const getReportingDeadLetterRoutingKey = (
	kind: ReportingConsumerKind
): string => `reporting.${kind}.dead-letter`;

export const getReportingManualRetryRoutingKey = (
	kind: ReportingConsumerKind
): string => `manual.${kind}`;

export function isProjectionConsumerKind(
	kind: ReportingConsumerKind
): kind is ReportingProjectionStream {
	return kind !== 'deliveryOutcome';
}
