import { IntegrationErrorCategory } from '@prisma/widgets-client';
import type { WidgetsProviderKind } from '../messaging/widgets-messaging.constants';
import { WidgetsIntegrationDestinationError } from './widgets-integration-delivery.service';
import { WidgetsSafeHttpError } from './widgets-safe-http.service';

export const WIDGETS_INTEGRATION_CLASSIFICATION_VERSION = 1;
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 30_000;
const DEFAULT_RATE_LIMIT_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

const TRANSIENT_CODES = new Set([
	'CONNECTION_ERROR',
	'DNS_ERROR',
	'DNS_TEMPORARY',
	'TRANSPORT_ERROR',
	'TRANSPORT_TIMEOUT'
]);
const CONFIGURATION_CODES = new Set([
	'DNS_NOT_FOUND',
	'TLS_CONFIGURATION',
	'DESTINATION_SNAPSHOT_MISSING',
	'DESTINATION_SNAPSHOT_INVALID',
	'DESTINATION_CONFIGURATION_MISSING',
	'DESTINATION_TARGET_CHANGED'
]);
const PERMANENT_CODES = new Set([
	'INVALID_DESTINATION',
	'INVALID_REQUEST_PAYLOAD'
]);
const BITRIX24_AUTH_CODES = new Set([
	'ACCESS_DENIED',
	'EXPIRED_TOKEN',
	'INSUFFICIENT_SCOPE',
	'INVALID_CREDENTIALS',
	'NO_AUTH_FOUND',
	'OVERLOAD_LIMIT',
	'PORTAL_DELETED',
	'USER_ACCESS_ERROR'
]);
const BITRIX24_TRANSIENT_CODES = new Set([
	'ERROR_UNEXPECTED_ANSWER',
	'INTERNAL_SERVER_ERROR'
]);
const AMO_AUTH_CODES = new Set([
	'110',
	'111',
	'112',
	'113',
	'ACCOUNT_BLOCKED',
	'FORBIDDEN',
	'PAYMENT_REQUIRED',
	'UNAUTHORIZED'
]);

export interface WidgetsIntegrationErrorClassification {
	category: IntegrationErrorCategory;
	normalizedCode: string;
	retryable: boolean;
	retryDelayMs: number | null;
	safeReason: string;
	recognized: boolean;
	classificationVersion: number;
	httpStatus: number | null;
	providerCode: string | null;
}

interface ClassificationInput {
	category: IntegrationErrorCategory;
	normalizedCode: string;
	safeReason: string;
	retryDelayMs?: number | null;
	recognized?: boolean;
	httpStatus?: number | null;
	providerCode?: string | null;
}

export function classifyWidgetsIntegrationError(
	kind: WidgetsProviderKind,
	error: unknown
): WidgetsIntegrationErrorClassification {
	if (error instanceof WidgetsIntegrationDestinationError) {
		return classification({
			category: IntegrationErrorCategory.AUTH_CONFIGURATION,
			normalizedCode: error.code,
			safeReason:
				error.code === 'DESTINATION_TARGET_CHANGED'
					? 'Integration destination changed; automatic redirection is blocked'
					: 'Integration destination configuration is unavailable',
			providerCode: error.code
		});
	}
	if (!(error instanceof WidgetsSafeHttpError)) return unclassified();
	const providerCode = normalizeCode(error.providerCode);
	const normalizedCode = outboundCode(
		kind,
		providerCode,
		error.httpStatus
	);
	const base = {
		normalizedCode,
		httpStatus: error.httpStatus,
		providerCode,
		safeReason: error.safeReason
	};

	if (providerCode && TRANSIENT_CODES.has(providerCode)) {
		return classification({
			...base,
			category: IntegrationErrorCategory.TRANSIENT
		});
	}
	if (providerCode && CONFIGURATION_CODES.has(providerCode)) {
		return classification({
			...base,
			category: IntegrationErrorCategory.AUTH_CONFIGURATION
		});
	}
	if (providerCode && PERMANENT_CODES.has(providerCode)) {
		return classification({
			...base,
			category: IntegrationErrorCategory.PERMANENT
		});
	}
	if (kind === 'bitrix24' && providerCode) {
		if (providerCode === 'QUERY_LIMIT_EXCEEDED') {
			return classification({
				...base,
				category: IntegrationErrorCategory.RATE_LIMIT,
				retryDelayMs: error.retryAfterMs,
				safeReason: 'Bitrix24 rate limit exceeded'
			});
		}
		if (BITRIX24_AUTH_CODES.has(providerCode)) {
			return classification({
				...base,
				category: IntegrationErrorCategory.AUTH_CONFIGURATION,
				safeReason: 'Bitrix24 authorization or configuration failed'
			});
		}
		if (BITRIX24_TRANSIENT_CODES.has(providerCode)) {
			return classification({
				...base,
				category: IntegrationErrorCategory.TRANSIENT,
				safeReason: 'Bitrix24 is temporarily unavailable'
			});
		}
	}
	if (kind === 'amo-crm' && providerCode) {
		if (providerCode === '429' || providerCode === 'TOO_MANY_REQUESTS') {
			return classification({
				...base,
				category: IntegrationErrorCategory.RATE_LIMIT,
				retryDelayMs: error.retryAfterMs,
				safeReason: 'amoCRM rate limit exceeded'
			});
		}
		if (AMO_AUTH_CODES.has(providerCode)) {
			return classification({
				...base,
				category: IntegrationErrorCategory.AUTH_CONFIGURATION,
				safeReason: 'amoCRM authorization or configuration failed'
			});
		}
	}
	if (error.httpStatus === 429) {
		return classification({
			...base,
			category: IntegrationErrorCategory.RATE_LIMIT,
			retryDelayMs: error.retryAfterMs,
			safeReason: `${providerLabel(kind)} rate limit exceeded`
		});
	}
	if (
		error.httpStatus === 401 ||
		error.httpStatus === 403 ||
		(kind === 'amo-crm' &&
			[402, 425, 426].includes(error.httpStatus as number))
	) {
		return classification({
			...base,
			category: IntegrationErrorCategory.AUTH_CONFIGURATION,
			safeReason: `${providerLabel(kind)} authorization or configuration failed`
		});
	}
	if (
		error.httpStatus === 408 ||
		error.httpStatus === 425 ||
		(error.httpStatus !== null && error.httpStatus >= 500)
	) {
		return classification({
			...base,
			category: IntegrationErrorCategory.TRANSIENT,
			safeReason: `${providerLabel(kind)} is temporarily unavailable`
		});
	}
	if (
		error.httpStatus !== null &&
		error.httpStatus >= 400 &&
		error.httpStatus < 500
	) {
		return classification({
			...base,
			category: IntegrationErrorCategory.PERMANENT,
			safeReason: `${providerLabel(kind)} rejected the request`
		});
	}
	return unclassified();
}

export function expiredWidgetsRetryClassification(): WidgetsIntegrationErrorClassification {
	return classification({
		category: IntegrationErrorCategory.PERMANENT,
		normalizedCode: 'AUTOMATIC_RETRY_WINDOW_EXPIRED',
		safeReason: 'Automatic retry window expired'
	});
}

export function exhaustedWidgetsRetryClassification(
	value: WidgetsIntegrationErrorClassification
): WidgetsIntegrationErrorClassification {
	return {
		...value,
		retryable: false,
		retryDelayMs: null,
		safeReason: `${value.safeReason}; automatic retry budget exhausted`
	};
}

function classification(
	input: ClassificationInput
): WidgetsIntegrationErrorClassification {
	const retryable =
		input.category === IntegrationErrorCategory.TRANSIENT ||
		input.category === IntegrationErrorCategory.RATE_LIMIT;
	return {
		category: input.category,
		normalizedCode: input.normalizedCode.slice(0, 255),
		retryable,
		retryDelayMs: retryable
			? normalizeDelay(
					input.retryDelayMs,
					input.category === IntegrationErrorCategory.RATE_LIMIT
						? DEFAULT_RATE_LIMIT_RETRY_DELAY_MS
						: DEFAULT_TRANSIENT_RETRY_DELAY_MS
				)
			: null,
		safeReason: input.safeReason.slice(0, 2000),
		recognized: input.recognized ?? true,
		classificationVersion: WIDGETS_INTEGRATION_CLASSIFICATION_VERSION,
		httpStatus: input.httpStatus ?? null,
		providerCode: input.providerCode?.slice(0, 255) || null
	};
}

function unclassified(): WidgetsIntegrationErrorClassification {
	return classification({
		category: IntegrationErrorCategory.TRANSIENT,
		normalizedCode: 'UNCLASSIFIED',
		safeReason: 'Unclassified integration error',
		recognized: false
	});
}

function outboundCode(
	kind: WidgetsProviderKind,
	providerCode: string | null,
	httpStatus: number | null
): string {
	const prefix =
		kind === 'amo-crm'
			? 'AMO_CRM'
			: kind === 'bitrix24'
				? 'BITRIX24'
				: 'WEBHOOK';
	if (providerCode) return `${prefix}_${providerCode}`;
	return httpStatus !== null
		? `${prefix}_HTTP_${httpStatus}`
		: `${prefix}_ERROR`;
}

function normalizeCode(value: string | null): string | null {
	if (!value) return null;
	const normalized = value.trim().toUpperCase();
	return /^[A-Z\d_.:-]{1,100}$/.test(normalized)
		? normalized.replace(/[.:-]/g, '_')
		: null;
}

function normalizeDelay(
	value: number | null | undefined,
	fallback: number
): number {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(Math.max(Math.round(value), 1000), MAX_RETRY_DELAY_MS);
}

function providerLabel(kind: WidgetsProviderKind): string {
	if (kind === 'amo-crm') return 'amoCRM';
	if (kind === 'bitrix24') return 'Bitrix24';
	return 'Webhook';
}
