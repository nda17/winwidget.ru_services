export const REPORTING_ADMIN_AUDIT_ACTIONS = [
	'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE',
	'REPORTING_DELIVERY_RETRY'
] as const;

export type ReportingAdminAuditAction =
	(typeof REPORTING_ADMIN_AUDIT_ACTIONS)[number];

export const REPORTING_SETTINGS_AUDIT_FIELDS = [
	'enabled',
	'destinationChatId',
	'messageThreadId',
	'scheduleTime',
	'timezone'
] as const;

export type ReportingSettingsAuditField =
	(typeof REPORTING_SETTINGS_AUDIT_FIELDS)[number];

export const REPORTING_AUDIT_CONSUMER_KINDS = [
	'identityUser',
	'billingPayment',
	'billingSubscription',
	'widget',
	'lead',
	'reportingSettings',
	'deliveryOutcome'
] as const;

export type ReportingAuditConsumerKind =
	(typeof REPORTING_AUDIT_CONSUMER_KINDS)[number];

interface ReportingAdminAuditEventBase {
	schemaVersion: 1;
	eventType: 'admin.audit.event.v1';
	eventId: string;
	occurredAt: string;
	correlationId: string;
	actorId: string;
}

export type ReportingAdminAuditEventPayload =
	| (ReportingAdminAuditEventBase & {
			action: 'REPORTING_DAILY_SUMMARY_SETTINGS_UPDATE';
			target: {
				reportingSettingsId: 'daily-summary';
			};
			metadata: {
				changedFields: ReportingSettingsAuditField[];
			};
	  })
	| (ReportingAdminAuditEventBase & {
			action: 'REPORTING_DELIVERY_RETRY';
			target: {
				eventId: string;
				consumerKind: ReportingAuditConsumerKind;
			};
			metadata: Record<string, never>;
	  });
