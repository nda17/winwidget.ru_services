export const OPERATIONS_EVENTS_EXCHANGE = 'winwidget.events';
export const OPERATIONS_RETRY_EXCHANGE = 'winwidget.retry';
export const OPERATIONS_DEAD_LETTER_EXCHANGE = 'winwidget.dead-letter';
export const OPERATIONS_MANUAL_RETRY_EXCHANGE = 'winwidget.manual-retry';
export const OPERATIONS_AUDIT_EVENT_TYPE = 'admin.audit.event.v1';
export const OPERATIONS_AUDIT_CONSUMER = 'operations-admin-event-log-v1';
// PostgreSQL receipts are the canonical retry record. The physical broker DLQ
// is only a bounded diagnostic copy.
export const OPERATIONS_AUDIT_DLQ_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export const OPERATIONS_AUDIT_SOURCES = [
	{
		kind: 'campaign-admin-audit',
		source: 'campaigns',
		routingKey: 'admin.audit.event.v1'
	},
	{
		kind: 'reporting-admin-audit',
		source: 'reporting',
		routingKey: 'admin.audit.reporting.v1'
	},
	{
		kind: 'widgets-admin-audit',
		source: 'widgets',
		routingKey: 'admin.audit.widgets.v1'
	},
	{
		kind: 'billing-admin-audit',
		source: 'billing',
		routingKey: 'admin.audit.billing.v1'
	},
	{
		kind: 'identity-admin-audit',
		source: 'identity',
		routingKey: 'admin.audit.identity.v1'
	},
	{
		kind: 'platform-admin-audit',
		source: 'platform',
		routingKey: 'admin.audit.platform.v1'
	},
	{
		kind: 'support-admin-audit',
		source: 'support',
		routingKey: 'admin.audit.support.v1'
	},
	{
		kind: 'core-admin-audit',
		source: 'core',
		routingKey: 'admin.audit.core.v1'
	}
] as const;

export type OperationsAuditSource =
	(typeof OPERATIONS_AUDIT_SOURCES)[number];
export type OperationsAuditKind = OperationsAuditSource['kind'];

export function getOperationsAuditQueue(source: OperationsAuditSource) {
	return `winwidget.operations.admin.audit.${source.source}.v1`;
}

export function getOperationsAuditRetryQueue(
	source: OperationsAuditSource
) {
	return `${getOperationsAuditQueue(source)}.retry-v1`;
}

export function getOperationsAuditDeadLetterQueue(
	source: OperationsAuditSource
) {
	return `${getOperationsAuditQueue(source)}.dead-letter`;
}

export function getOperationsAuditRetryRoutingKey(
	source: OperationsAuditSource
) {
	return `operations.admin.audit.${source.source}.retry.v1`;
}

export function getOperationsAuditDeadLetterRoutingKey(
	source: OperationsAuditSource
) {
	return `operations.admin.audit.${source.source}.dead-letter.v1`;
}

export function getOperationsAuditManualRetryRoutingKey(
	source: OperationsAuditSource
) {
	return `operations.admin.audit.${source.source}.manual.v1`;
}

export function getOperationsAuditSourceByName(
	name: string
): OperationsAuditSource | undefined {
	return OPERATIONS_AUDIT_SOURCES.find(source => source.source === name);
}

export function getOperationsAuditSource(
	routingKey: string
): OperationsAuditSource | undefined {
	return OPERATIONS_AUDIT_SOURCES.find(
		source => source.routingKey === routingKey
	);
}
