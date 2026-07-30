export const CAMPAIGN_ADMIN_AUDIT_ACTIONS = [
	'CAMPAIGN_CREATE',
	'CAMPAIGN_CANCEL',
	'CAMPAIGN_DELIVERY_RETRY'
] as const;

export type CampaignAdminAuditAction =
	(typeof CAMPAIGN_ADMIN_AUDIT_ACTIONS)[number];

interface CampaignAdminAuditTarget {
	campaignId: string;
	deliveryId?: string;
}

interface CampaignAdminAuditMetadata {
	channel?: 'EMAIL' | 'TELEGRAM' | 'BOTH';
	audience?: 'ALL' | 'ACTIVE_SUBSCRIBERS';
	recipientCount?: number;
	dispatchGeneration?: number;
}

export interface CampaignAdminAuditEventPayload {
	schemaVersion: 1;
	eventType: 'admin.audit.event.v1';
	eventId: string;
	occurredAt: string;
	correlationId: string;
	actorId: string;
	action: CampaignAdminAuditAction;
	target: CampaignAdminAuditTarget;
	metadata: CampaignAdminAuditMetadata;
}
