export const REPORTING_INTERNAL_TOKEN_HEADER =
	'x-winwidget-internal-token';
export const REPORTING_INTERNAL_TOKEN_ENV = 'REPORTING_INTERNAL_TOKEN';
export const REPORTING_INTERNAL_TOKEN_MIN_LENGTH = 32;

export const REPORTING_AUTH_INTROSPECTION_PATH =
	'internal/reporting/auth/introspect';
export const REPORTING_PROJECTION_SNAPSHOT_PATH =
	'internal/reporting/snapshot';
export const REPORTING_SCHEDULE_POLICY_PATH =
	'internal/reporting/schedule-policy';
export const REPORTING_SCHEDULE_POLICY_CONFIRM_PATH =
	'internal/reporting/schedule-policy/confirm';
export const REPORTING_PROJECTION_SNAPSHOT_CONTENT_TYPE =
	'application/x-ndjson';

export const REPORTING_PROJECTION_STREAMS = [
	'identityUser',
	'billingPayment',
	'billingSubscription',
	'widget',
	'lead',
	'reportingSettings'
] as const;

export type ReportingProjectionStream =
	(typeof REPORTING_PROJECTION_STREAMS)[number];
