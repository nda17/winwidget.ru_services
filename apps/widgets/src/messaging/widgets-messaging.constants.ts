import {
	BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE,
	IDENTITY_USER_CHANGED_EVENT_TYPE,
	WidgetsProjectionKind
} from '../projections/widgets-projection.contract';

export const WIDGETS_EVENTS_EXCHANGE = 'winwidget.events';
export const WIDGETS_RETRY_EXCHANGE = 'winwidget.widgets.retry';
export const WIDGETS_MANUAL_RETRY_EXCHANGE =
	'winwidget.widgets.manual-retry';
export const WIDGETS_DEAD_LETTER_EXCHANGE = 'winwidget.dead-letter';

export const WIDGETS_PROJECTION_KINDS = [
	'identity',
	'entitlement'
] as const satisfies readonly WidgetsProjectionKind[];

export const WIDGETS_PROVIDER_KINDS = [
	'webhook',
	'bitrix24',
	'amo-crm'
] as const;

export type WidgetsProviderKind = (typeof WIDGETS_PROVIDER_KINDS)[number];
export type WidgetsConsumerKind =
	| WidgetsProjectionKind
	| WidgetsProviderKind;
export const WIDGETS_CONSUMER_KINDS = [
	...WIDGETS_PROJECTION_KINDS,
	...WIDGETS_PROVIDER_KINDS
] as const satisfies readonly WidgetsConsumerKind[];

export const WIDGETS_QUEUE_NAMES: Record<WidgetsConsumerKind, string> = {
	identity: 'winwidget.widgets.identity-user',
	entitlement: 'winwidget.widgets.billing-subscription',
	webhook: 'winwidget.lead-integration.webhook',
	bitrix24: 'winwidget.lead-integration.bitrix24',
	'amo-crm': 'winwidget.lead-integration.amo-crm'
};

export const WIDGETS_ROUTING_KEYS: Record<WidgetsConsumerKind, string> = {
	identity: IDENTITY_USER_CHANGED_EVENT_TYPE,
	entitlement: BILLING_SUBSCRIPTION_CHANGED_EVENT_TYPE,
	webhook: 'lead.integration.webhook.v2',
	bitrix24: 'lead.integration.bitrix24.v2',
	'amo-crm': 'lead.integration.amo-crm.v2'
};

export const WIDGETS_CONSUMERS: Record<WidgetsConsumerKind, string> = {
	identity: 'widgets-owner-projection-v1',
	entitlement: 'widgets-entitlement-projection-v1',
	webhook: 'widgets-webhook-delivery-v1',
	bitrix24: 'widgets-bitrix24-delivery-v1',
	'amo-crm': 'widgets-amo-crm-delivery-v1'
};

export const WIDGETS_RETRY_DELAYS_MS = [
	30_000, 300_000, 1_800_000
] as const;

export const getWidgetsRetryRoutingKey = (
	kind: WidgetsConsumerKind,
	index: number
): string => `${kind}.retry.${index + 1}`;

export const getWidgetsManualRetryRoutingKey = (
	kind: WidgetsConsumerKind
): string => `${kind}.manual-retry`;

export const getWidgetsDeadLetterRoutingKey = (
	kind: WidgetsConsumerKind
): string => `widgets.${kind}.dead-letter`;
