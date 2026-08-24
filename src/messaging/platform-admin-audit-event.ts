export const PLATFORM_ADMIN_AUDIT_ACTIONS = [
	'PLATFORM_SITE_SETTINGS_UPDATE',
	'PLATFORM_LEGAL_PAGE_UPDATE',
	'PLATFORM_HOME_PAGE_CONTENT_UPDATE',
	'PLATFORM_HOME_PAGE_RAW_CODE_UPDATE'
] as const;

export type PlatformAdminAuditAction =
	(typeof PLATFORM_ADMIN_AUDIT_ACTIONS)[number];

export interface PlatformAdminAuditEventPayload {
	schemaVersion: 1;
	eventType: 'admin.audit.event.v1';
	eventId: string;
	occurredAt: string;
	correlationId: string;
	actorId: string;
	section: 'PLATFORM_CONTENT';
	action: PlatformAdminAuditAction;
	description: string;
	entity: {
		type: string;
		id: string;
		label: string | null;
		targetUserId: null;
	};
	metadata: Record<string, unknown>;
}
