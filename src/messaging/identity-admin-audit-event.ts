export const IDENTITY_ADMIN_AUDIT_ACTIONS = [
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

export type IdentityAdminAuditAction =
	(typeof IDENTITY_ADMIN_AUDIT_ACTIONS)[number];

export const IDENTITY_ADMIN_AUDIT_SECTIONS = [
	'USERS',
	'SITE_SETTINGS',
	'TELEGRAM_BOT',
	'TASKS',
	'MESSAGING'
] as const;

export type IdentityAdminAuditSection =
	(typeof IDENTITY_ADMIN_AUDIT_SECTIONS)[number];

export interface IdentityAdminAuditSnapshot {
	name: string | null;
	email: string | null;
}

export interface IdentityAdminAuditEventPayload {
	schemaVersion: 1;
	eventType: 'admin.audit.event.v1';
	eventId: string;
	occurredAt: string;
	correlationId: string;
	actorId: string;
	actorSnapshot: IdentityAdminAuditSnapshot;
	section: IdentityAdminAuditSection;
	action: IdentityAdminAuditAction;
	description: string;
	entity: {
		type: string;
		id: string;
		label: string | null;
		targetUserId: string | null;
		targetSnapshot: IdentityAdminAuditSnapshot;
	};
	metadata: Record<string, unknown>;
}
