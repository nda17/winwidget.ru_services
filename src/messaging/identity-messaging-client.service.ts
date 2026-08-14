import { createMessagingHeaders } from '@/messaging/messaging-context';
import {
	BadGatewayException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

const OVERVIEW_PATH = '/internal/v1/identity/messaging/overview';
const FAILURES_PATH = '/internal/v1/identity/messaging/failures';
const DEFAULT_BASE_URL = 'http://127.0.0.1:4900';
const DEFAULT_TIMEOUT_MS = 5_000;
const INTEGRATION = 'telegram-destination-unavailable' as const;
const TOKEN_PLACEHOLDERS = new Set([
	'change_me',
	'change-me',
	'XYZXYZXYZ',
	'identity_core_token',
	'ci_identity_core_token_at_least_32_chars'
]);
const CATEGORIES = [
	'TRANSIENT',
	'RATE_LIMIT',
	'PERMANENT',
	'AUTH_CONFIGURATION'
] as const;

type FailureCategory = (typeof CATEGORIES)[number];
type Validator<T> = (value: unknown) => value is T;

export interface IdentityMessagingOverview {
	generatedAt: string;
	outbox: Record<
		'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED',
		number
	>;
	oldestPendingAt: string | null;
	unresolvedFailures: number;
	retryingFailures: number;
	deliveredLast24Hours: number;
	heartbeats: Array<{
		service: string;
		status: 'ok';
		activeInstances: number;
		lastSeenAt: string;
	}>;
}

export interface IdentityMessagingFailureView {
	id: string;
	eventId: string;
	integration: typeof INTEGRATION;
	attempts: number;
	lastError: string;
	category: FailureCategory;
	normalizedCode: string;
	safeReason: string;
	failedAt: string;
	retryingAt: string | null;
	resolvedAt: string | null;
	resolution: 'DELIVERED' | 'CLOSED_NO_RETRY' | null;
	resolutionComment: string | null;
	source: string;
	entity: null;
	lead: null;
}

export interface IdentityMessagingFailuresPage {
	items: IdentityMessagingFailureView[];
	total: number;
	page: number;
	limit: number;
	totalPages: number;
}

export interface IdentityMessagingRetryResult {
	id: string;
	eventId: string;
	integration: typeof INTEGRATION;
	retryingAt: string;
}

export interface IdentityMessagingCloseResult {
	id: string;
	eventId: string;
	integration: typeof INTEGRATION;
	resolvedAt: string;
	resolution: 'CLOSED_NO_RETRY';
	resolutionComment: string;
}

export class IdentityMessagingInternalApiError extends Error {
	constructor(
		readonly statusCode: number,
		message: string
	) {
		super(message);
		this.name = 'IdentityMessagingInternalApiError';
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string =>
	typeof value === 'string';
const isNonEmptyString = (value: unknown): value is string =>
	isString(value) && value.trim().length > 0;
const isNullableString = (value: unknown): value is string | null =>
	value === null || isString(value);
const isNonNegativeInteger = (value: unknown): value is number =>
	Number.isSafeInteger(value) && Number(value) >= 0;
const isPositiveInteger = (value: unknown): value is number =>
	Number.isSafeInteger(value) && Number(value) > 0;
const isIsoDate = (value: unknown): value is string => {
	if (!isString(value)) return false;
	const timestamp = Date.parse(value);
	return (
		Number.isFinite(timestamp) &&
		new Date(timestamp).toISOString() === value
	);
};
const isNullableIsoDate = (value: unknown): value is string | null =>
	value === null || isIsoDate(value);

const isFailure = (
	value: unknown
): value is IdentityMessagingFailureView =>
	isRecord(value) &&
	isNonEmptyString(value.id) &&
	isNonEmptyString(value.eventId) &&
	value.integration === INTEGRATION &&
	isPositiveInteger(value.attempts) &&
	isString(value.lastError) &&
	CATEGORIES.includes(value.category as FailureCategory) &&
	isNonEmptyString(value.normalizedCode) &&
	isString(value.safeReason) &&
	isIsoDate(value.failedAt) &&
	isNullableIsoDate(value.retryingAt) &&
	isNullableIsoDate(value.resolvedAt) &&
	(value.resolution === null ||
		value.resolution === 'DELIVERED' ||
		value.resolution === 'CLOSED_NO_RETRY') &&
	isNullableString(value.resolutionComment) &&
	isString(value.source) &&
	value.entity === null &&
	value.lead === null;

const isFailuresPage = (
	value: unknown
): value is IdentityMessagingFailuresPage =>
	isRecord(value) &&
	Array.isArray(value.items) &&
	value.items.every(isFailure) &&
	isNonNegativeInteger(value.total) &&
	isPositiveInteger(value.page) &&
	isPositiveInteger(value.limit) &&
	isPositiveInteger(value.totalPages);

const isOverview = (
	value: unknown
): value is IdentityMessagingOverview => {
	if (
		!isRecord(value) ||
		!isRecord(value.outbox) ||
		!Array.isArray(value.heartbeats)
	) {
		return false;
	}
	return (
		isIsoDate(value.generatedAt) &&
		['PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED'].every(status =>
			isNonNegativeInteger(value.outbox[status])
		) &&
		isNullableIsoDate(value.oldestPendingAt) &&
		isNonNegativeInteger(value.unresolvedFailures) &&
		isNonNegativeInteger(value.retryingFailures) &&
		isNonNegativeInteger(value.deliveredLast24Hours) &&
		value.heartbeats.every(
			heartbeat =>
				isRecord(heartbeat) &&
				isNonEmptyString(heartbeat.service) &&
				heartbeat.service.startsWith('identity-') &&
				heartbeat.status === 'ok' &&
				isPositiveInteger(heartbeat.activeInstances) &&
				isIsoDate(heartbeat.lastSeenAt)
		)
	);
};

const isRetryResult = (
	value: unknown
): value is IdentityMessagingRetryResult =>
	isRecord(value) &&
	isNonEmptyString(value.id) &&
	isNonEmptyString(value.eventId) &&
	value.integration === INTEGRATION &&
	isIsoDate(value.retryingAt);

const isCloseResult = (
	value: unknown
): value is IdentityMessagingCloseResult =>
	isRecord(value) &&
	isNonEmptyString(value.id) &&
	isNonEmptyString(value.eventId) &&
	value.integration === INTEGRATION &&
	isIsoDate(value.resolvedAt) &&
	value.resolution === 'CLOSED_NO_RETRY' &&
	isNonEmptyString(value.resolutionComment);

@Injectable()
export class IdentityMessagingClientService {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly timeoutMs: number;

	constructor(config: ConfigService) {
		this.baseUrl = this.parseBaseUrl(
			config.get<string>('IDENTITY_INTERNAL_BASE_URL')
		);
		this.token = config.get<string>('IDENTITY_CORE_TOKEN')?.trim() || '';
		if (this.token.length < 32 || TOKEN_PLACEHOLDERS.has(this.token)) {
			throw new Error(
				'IDENTITY_CORE_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		const timeout = Number(
			config.get<string>('IDENTITY_INTERNAL_TIMEOUT_MS') ||
				DEFAULT_TIMEOUT_MS
		);
		if (
			!Number.isSafeInteger(timeout) ||
			timeout < 500 ||
			timeout > 60_000
		) {
			throw new Error(
				'IDENTITY_INTERNAL_TIMEOUT_MS must be between 500 and 60000'
			);
		}
		this.timeoutMs = timeout;
	}

	getOverview(): Promise<IdentityMessagingOverview> {
		return this.request(OVERVIEW_PATH, isOverview);
	}

	getFailures(
		page: number,
		limit: number,
		filters: { category?: string; status?: string }
	): Promise<IdentityMessagingFailuresPage> {
		const query = new URLSearchParams({
			page: String(page),
			limit: String(limit),
			consumer: INTEGRATION
		});
		for (const [key, value] of Object.entries(filters)) {
			if (value?.trim()) query.set(key, value.trim());
		}
		return this.request(
			`${FAILURES_PATH}?${query.toString()}`,
			isFailuresPage
		);
	}

	retryFailure(
		id: string,
		actorId: string
	): Promise<IdentityMessagingRetryResult> {
		return this.request(
			`${FAILURES_PATH}/${encodeURIComponent(id)}/retry`,
			isRetryResult,
			{ method: 'POST', body: JSON.stringify({ actorId }) }
		);
	}

	closeFailure(
		id: string,
		actorId: string,
		comment: string
	): Promise<IdentityMessagingCloseResult> {
		return this.request(
			`${FAILURES_PATH}/${encodeURIComponent(id)}/close`,
			isCloseResult,
			{ method: 'POST', body: JSON.stringify({ actorId, comment }) }
		);
	}

	private async request<T>(
		path: string,
		validate: Validator<T>,
		init: RequestInit = {}
	): Promise<T> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		timeout.unref();
		try {
			const response = await fetch(`${this.baseUrl}${path}`, {
				...init,
				redirect: 'error',
				headers: {
					Accept: 'application/json',
					...createMessagingHeaders({ messageId: randomUUID() }),
					'x-winwidget-service': 'core',
					'x-winwidget-internal-token': this.token,
					...(init.body ? { 'Content-Type': 'application/json' } : {}),
					...(init.headers || {})
				},
				signal: controller.signal
			});
			const body: unknown = await response.json().catch(() => null);
			if (!response.ok) {
				throw new IdentityMessagingInternalApiError(
					response.status,
					this.errorMessage(body, response.status)
				);
			}
			if (!validate(body)) {
				throw new BadGatewayException(
					'Identity вернул некорректный ответ'
				);
			}
			return body;
		} catch (error) {
			if (
				error instanceof IdentityMessagingInternalApiError ||
				error instanceof BadGatewayException
			) {
				throw error;
			}
			throw new ServiceUnavailableException(
				error instanceof Error && error.name === 'AbortError'
					? 'Identity не ответил вовремя'
					: 'Identity недоступен'
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	private parseBaseUrl(value?: string): string {
		const configured = value?.trim() || DEFAULT_BASE_URL;
		const url = new URL(configured);
		if (
			url.protocol !== 'http:' ||
			!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(
				url.hostname.toLowerCase()
			) ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			throw new Error(
				'IDENTITY_INTERNAL_BASE_URL must be an exact private loopback HTTP origin'
			);
		}
		return url.origin;
	}

	private errorMessage(body: unknown, status: number): string {
		if (isRecord(body)) {
			if (isNonEmptyString(body.message))
				return body.message.slice(0, 1_000);
			if (Array.isArray(body.message)) {
				const message = body.message.filter(isString).join('; ').trim();
				if (message) return message.slice(0, 1_000);
			}
		}
		return `Identity вернул HTTP ${status}`;
	}
}
