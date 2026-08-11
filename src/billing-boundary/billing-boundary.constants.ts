export const BILLING_INTERNAL_TOKEN_HEADER = 'x-winwidget-internal-token';
export const BILLING_INTERNAL_TOKEN_ENV = 'BILLING_INTERNAL_TOKEN';
export const BILLING_INTERNAL_TOKEN_MIN_LENGTH = 32;

export const BILLING_AUTH_INTROSPECTION_PATH =
	'internal/billing/auth/introspect';
export const BILLING_IDENTITY_RESOLVE_PATH =
	'internal/billing/identities/resolve';
export const BILLING_SOURCE_REPAIR_PATH =
	'internal/billing/source-events/repair';
export const BILLING_LIFECYCLE_COMPLETE_PATH =
	'internal/billing/lifecycle/complete';

export const BILLING_SERVICE_BASE_URL_ENV = 'BILLING_INTERNAL_BASE_URL';
export const BILLING_SERVICE_TIMEOUT_ENV = 'BILLING_INTERNAL_TIMEOUT_MS';
export const BILLING_SERVICE_DEFAULT_BASE_URL = 'http://127.0.0.1:4800';

export const BILLING_REVOKE_ENTITLEMENTS_PATH =
	'/internal/v1/billing/users/revoke-entitlements';
export const BILLING_ENSURE_TRIAL_PATH =
	'/internal/v1/billing/trials/ensure';
export const BILLING_SETTINGS_PATH = '/internal/v1/billing/settings';
