export const SUPPORT_ADMIN_AUDIT_ACTIONS = [
	'SUPPORT_ROUTING_SETTINGS_UPDATE',
	'SUPPORT_WEBHOOK_REINSTALL',
	'SUPPORT_DELIVERY_RETRY',
	'SUPPORT_DELIVERY_CLOSE'
] as const;

export type SupportAdminAuditAction =
	(typeof SUPPORT_ADMIN_AUDIT_ACTIONS)[number];

export interface SupportAdminAuditEventPayload {
	schemaVersion: 1;
	eventType: 'admin.audit.event.v1';
	eventId: string;
	occurredAt: string;
	correlationId: string;
	actorId: string;
	section: 'SUPPORT';
	action: SupportAdminAuditAction;
	description: string;
	entity: {
		type: string;
		id: string;
		label: string | null;
		targetUserId: null;
	};
	metadata: Record<string, unknown>;
}
