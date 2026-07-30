export const EVENTS_EXCHANGE = 'winwidget.events';
export const CAMPAIGNS_RETRY_EXCHANGE = 'winwidget.campaigns.retry';
export const DEAD_LETTER_EXCHANGE = 'winwidget.dead-letter';

export const CAMPAIGN_SNAPSHOT_REQUESTED_EVENT_TYPE =
	'campaign.snapshot.requested.v1';
export const CAMPAIGN_EMAIL_REQUESTED_EVENT_TYPE =
	'notification.campaign.email.requested.v2';
export const CAMPAIGN_TELEGRAM_REQUESTED_EVENT_TYPE =
	'notification.campaign.telegram.requested.v2';
export const NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE =
	'notification.delivery.outcome.v2';
export const ADMIN_AUDIT_EVENT_TYPE = 'admin.audit.event.v1';

export const CAMPAIGNS_CONSUMER_KINDS = ['snapshot', 'outcome'] as const;
export type CampaignsConsumerKind =
	(typeof CAMPAIGNS_CONSUMER_KINDS)[number];

export const CAMPAIGNS_QUEUE_NAMES: Record<CampaignsConsumerKind, string> =
	{
		snapshot: 'winwidget.campaigns.snapshot',
		outcome: 'winwidget.campaigns.delivery-outcome.v2'
	};

export const CAMPAIGNS_ROUTING_KEYS: Record<
	CampaignsConsumerKind,
	string
> = {
	snapshot: CAMPAIGN_SNAPSHOT_REQUESTED_EVENT_TYPE,
	outcome: NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE
};

export const CAMPAIGNS_RETRY_DELAYS_MS = [
	30_000, 300_000, 1_800_000
] as const;

export const getCampaignsRetryRoutingKey = (
	kind: CampaignsConsumerKind,
	index: number
): string => `${kind}.retry.${index + 1}`;

export const getCampaignsDeadLetterRoutingKey = (
	kind: CampaignsConsumerKind
): string => `campaigns.${kind}.dead-letter`;

export const CAMPAIGNS_CONSUMERS: Record<CampaignsConsumerKind, string> = {
	snapshot: 'campaigns-snapshot-v1',
	outcome: 'campaigns-outcome-v2'
};
