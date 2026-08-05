export const WIDGETS_ADMIN_AUDIT_ACTIONS = [
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

export type WidgetsAdminAuditAction =
	(typeof WIDGETS_ADMIN_AUDIT_ACTIONS)[number];

export const WIDGETS_ADMIN_AUDIT_TYPES = [
	'WHEEL',
	'QUIZ',
	'CALLBACK',
	'TIMER',
	'STOP_OFFER',
	'ONLINE_CONSULTANT',
	'CALCULATOR'
] as const;

export type WidgetsAdminAuditType =
	(typeof WIDGETS_ADMIN_AUDIT_TYPES)[number];

export const WIDGETS_ADMIN_AUDIT_INTEGRATIONS = [
	'webhook',
	'bitrix24',
	'amo-crm'
] as const;

export type WidgetsAdminAuditIntegration =
	(typeof WIDGETS_ADMIN_AUDIT_INTEGRATIONS)[number];

interface WidgetsAdminAuditEventBase {
	schemaVersion: 1;
	eventType: 'admin.audit.event.v1';
	eventId: string;
	occurredAt: string;
	correlationId: string;
	actorId: string;
}

interface WidgetsAdminAuditTarget {
	widgetId: string;
	widgetType: WidgetsAdminAuditType;
	ownerId: string;
}

export type WidgetsAdminAuditEventPayload =
	| (WidgetsAdminAuditEventBase & {
			action: 'WIDGET_UPDATE';
			target: WidgetsAdminAuditTarget;
			metadata: { changedFields: string[] };
	  })
	| (WidgetsAdminAuditEventBase & {
			action: 'WIDGET_PUBLISH' | 'WIDGET_VERSION_RESTORE';
			target: WidgetsAdminAuditTarget;
			metadata: { version: number };
	  })
	| (WidgetsAdminAuditEventBase & {
			action: 'WIDGET_CLONE';
			target: WidgetsAdminAuditTarget;
			metadata: { sourceWidgetId: string };
	  })
	| (WidgetsAdminAuditEventBase & {
			action: 'WIDGET_BUTTON_IMAGE_UPDATE';
			target: WidgetsAdminAuditTarget;
			metadata: { imagePresent: boolean };
	  })
	| (WidgetsAdminAuditEventBase & {
			action: 'WIDGET_DRAFT_DISCARD' | 'WIDGET_DELETE';
			target: WidgetsAdminAuditTarget;
			metadata: Record<string, never>;
	  })
	| (WidgetsAdminAuditEventBase & {
			action: 'WIDGET_DELIVERY_RETRY';
			target: WidgetsAdminAuditTarget & {
				failureId: string;
				integration: WidgetsAdminAuditIntegration;
			};
			metadata: Record<string, never>;
	  })
	| (WidgetsAdminAuditEventBase & {
			action: 'WIDGET_DELIVERY_CLOSE';
			target: WidgetsAdminAuditTarget & {
				failureId: string;
				integration: WidgetsAdminAuditIntegration;
			};
			metadata: {
				commentPresent: true;
				commentLength: number;
			};
	  });
