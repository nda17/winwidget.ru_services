import { createMessagingHeaders } from '@/messaging/messaging-context';
import {
	WIDGETS_PROVIDER_INTEGRATION_KINDS,
	WidgetsProviderIntegrationKind
} from '@/messaging/messaging.constants';
import {
	WIDGETS_DELIVERY_FAILURES_PATH,
	WIDGETS_MESSAGING_OVERVIEW_PATH
} from '@/widgets-internal/widgets-internal.constants';
import {
	BadGatewayException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

const DEFAULT_INTERNAL_URL = 'http://127.0.0.1:4700';
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_INTERNAL_TOKEN_LENGTH = 32;
const FAILURE_CATEGORIES = [
	'TRANSIENT',
	'RATE_LIMIT',
	'PERMANENT',
	'AUTH_CONFIGURATION'
] as const;
const OVERVIEW_FAILURE_CATEGORIES = [
	...FAILURE_CATEGORIES,
	'UNCLASSIFIED'
] as const;
const OUTBOX_STATUSES = [
	'PENDING',
	'PUBLISHING',
	'PUBLISHED',
	'FAILED'
] as const;
const WIDGETS_HEARTBEAT_SERVICES = [
	'widgets-api',
	'widgets-worker',
	'widgets-publisher'
] as const;

export interface WidgetsMessagingOverview {
	generatedAt: string;
	outbox: Record<(typeof OUTBOX_STATUSES)[number], number>;
	oldestPendingAt: string | null;
	operational: {
		staleOutbox: number;
		dueOutbox: number;
		unresolvedFailuresByCategory: Record<
			(typeof OVERVIEW_FAILURE_CATEGORIES)[number],
			number
		>;
	};
	unresolvedFailures: number;
	retryingFailures: number;
	deliveredLast24Hours: number;
	heartbeats: Array<{
		service: (typeof WIDGETS_HEARTBEAT_SERVICES)[number];
		status: 'ok' | 'down';
		activeInstances: number;
		lastSeenAt: string | null;
		lastSuccessfulPublishAt?: string | null;
		lastSuccessfulConsumeAt?: string | null;
	}>;
}

export interface WidgetsDeliveryFailureFilters {
	integration?: string;
	category?: string;
	status?: string;
}

export interface WidgetsDeliveryFailureView {
	id: string;
	eventId: string;
	integration: WidgetsProviderIntegrationKind;
	attempts: number;
	lastError: string;
	category: (typeof FAILURE_CATEGORIES)[number] | null;
	normalizedCode: string | null;
	safeReason: string | null;
	httpStatus: number | null;
	providerCode: string | null;
	retryable: boolean | null;
	failedAt: string;
	retryingAt: string | null;
	resolvedAt: string | null;
	resolution: 'DELIVERED' | 'CLOSED_NO_RETRY' | null;
	resolutionComment: string | null;
	source: string | null;
	entity: Record<string, unknown>;
	lead: {
		id: string | null;
		contact: string | null;
		phone: string | null;
		email: string | null;
		url: string | null;
		createdAt: string | null;
	};
}

export interface WidgetsDeliveryFailuresPage {
	items: WidgetsDeliveryFailureView[];
	total: number;
	page: number;
	limit: number;
	totalPages: number;
}

export interface WidgetsDeliveryFailureRetryResult {
	id: string;
	eventId: string;
	integration: WidgetsProviderIntegrationKind;
	retryingAt: string;
}

export interface WidgetsDeliveryFailureCloseResult {
	id: string;
	eventId: string;
	integration: WidgetsProviderIntegrationKind;
	resolvedAt: string;
	resolution: 'CLOSED_NO_RETRY';
	resolutionComment: string;
}

type ResponseValidator<T> = (value: unknown) => value is T;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isString = (value: unknown): value is string =>
	typeof value === 'string';

const isNonEmptyString = (value: unknown): value is string =>
	isString(value) && value.trim().length > 0;

const isNullableString = (value: unknown): value is string | null =>
	value === null || isString(value);

const isNonNegativeInteger = (value: unknown): value is number =>
	Number.isInteger(value) && Number(value) >= 0;

const isPositiveInteger = (value: unknown): value is number =>
	Number.isInteger(value) && Number(value) > 0;

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

const isWidgetsProviderKind = (
	value: unknown
): value is WidgetsProviderIntegrationKind =>
	isString(value) &&
	WIDGETS_PROVIDER_INTEGRATION_KINDS.includes(
		value as WidgetsProviderIntegrationKind
	);

const isFailureView = (
	value: unknown
): value is WidgetsDeliveryFailureView => {
	if (
		!isRecord(value) ||
		!isRecord(value.entity) ||
		!isRecord(value.lead)
	) {
		return false;
	}
	const categoryValid =
		value.category === null ||
		FAILURE_CATEGORIES.includes(
			value.category as (typeof FAILURE_CATEGORIES)[number]
		);
	const resolutionValid =
		value.resolution === null ||
		value.resolution === 'DELIVERED' ||
		value.resolution === 'CLOSED_NO_RETRY';
	const leadValid = [
		'id',
		'contact',
		'phone',
		'email',
		'url',
		'createdAt'
	].every(key => isNullableString(value.lead[key]));
	return (
		isNonEmptyString(value.id) &&
		isNonEmptyString(value.eventId) &&
		isWidgetsProviderKind(value.integration) &&
		isPositiveInteger(value.attempts) &&
		isString(value.lastError) &&
		categoryValid &&
		isNullableString(value.normalizedCode) &&
		isNullableString(value.safeReason) &&
		(value.httpStatus === null ||
			(Number.isInteger(value.httpStatus) &&
				Number(value.httpStatus) >= 100 &&
				Number(value.httpStatus) <= 599)) &&
		isNullableString(value.providerCode) &&
		(value.retryable === null || typeof value.retryable === 'boolean') &&
		isIsoDate(value.failedAt) &&
		isNullableIsoDate(value.retryingAt) &&
		isNullableIsoDate(value.resolvedAt) &&
		resolutionValid &&
		isNullableString(value.resolutionComment) &&
		isNullableString(value.source) &&
		leadValid
	);
};

const isFailuresPage = (
	value: unknown
): value is WidgetsDeliveryFailuresPage =>
	isRecord(value) &&
	Array.isArray(value.items) &&
	value.items.every(isFailureView) &&
	isNonNegativeInteger(value.total) &&
	isPositiveInteger(value.page) &&
	isPositiveInteger(value.limit) &&
	isPositiveInteger(value.totalPages);

const isRetryResult = (
	value: unknown
): value is WidgetsDeliveryFailureRetryResult =>
	isRecord(value) &&
	isNonEmptyString(value.id) &&
	isNonEmptyString(value.eventId) &&
	isWidgetsProviderKind(value.integration) &&
	isIsoDate(value.retryingAt);

const isCloseResult = (
	value: unknown
): value is WidgetsDeliveryFailureCloseResult =>
	isRecord(value) &&
	isNonEmptyString(value.id) &&
	isNonEmptyString(value.eventId) &&
	isWidgetsProviderKind(value.integration) &&
	isIsoDate(value.resolvedAt) &&
	value.resolution === 'CLOSED_NO_RETRY' &&
	isNonEmptyString(value.resolutionComment);

const isOverview = (value: unknown): value is WidgetsMessagingOverview => {
	if (
		!isRecord(value) ||
		!isRecord(value.outbox) ||
		!isRecord(value.operational) ||
		!isRecord(value.operational.unresolvedFailuresByCategory) ||
		!Array.isArray(value.heartbeats)
	) {
		return false;
	}
	const categories = value.operational.unresolvedFailuresByCategory;
	const services = new Set<unknown>();
	const heartbeatsValid = value.heartbeats.every(heartbeat => {
		if (!isRecord(heartbeat)) return false;
		services.add(heartbeat.service);
		return (
			WIDGETS_HEARTBEAT_SERVICES.some(
				service => service === heartbeat.service
			) &&
			(heartbeat.status === 'ok' || heartbeat.status === 'down') &&
			isNonNegativeInteger(heartbeat.activeInstances) &&
			isNullableIsoDate(heartbeat.lastSeenAt) &&
			(heartbeat.lastSuccessfulPublishAt === undefined ||
				isNullableIsoDate(heartbeat.lastSuccessfulPublishAt)) &&
			(heartbeat.lastSuccessfulConsumeAt === undefined ||
				isNullableIsoDate(heartbeat.lastSuccessfulConsumeAt))
		);
	});
	return (
		isIsoDate(value.generatedAt) &&
		OUTBOX_STATUSES.every(status =>
			isNonNegativeInteger(value.outbox[status])
		) &&
		isNullableIsoDate(value.oldestPendingAt) &&
		isNonNegativeInteger(value.operational.staleOutbox) &&
		isNonNegativeInteger(value.operational.dueOutbox) &&
		OVERVIEW_FAILURE_CATEGORIES.every(category =>
			isNonNegativeInteger(categories[category])
		) &&
		isNonNegativeInteger(value.unresolvedFailures) &&
		isNonNegativeInteger(value.retryingFailures) &&
		isNonNegativeInteger(value.deliveredLast24Hours) &&
		heartbeatsValid &&
		value.heartbeats.length === WIDGETS_HEARTBEAT_SERVICES.length &&
		services.size === WIDGETS_HEARTBEAT_SERVICES.length &&
		WIDGETS_HEARTBEAT_SERVICES.every(service => services.has(service))
	);
};

export class WidgetsDeliveryInternalApiError extends Error {
	constructor(
		readonly statusCode: number,
		message: string
	) {
		super(message);
		this.name = 'WidgetsDeliveryInternalApiError';
	}
}

@Injectable()
export class WidgetsDeliveryFailuresClientService {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly timeoutMs: number;

	constructor() {
		this.baseUrl = this.getBaseUrl();
		this.token = this.getToken();
		this.timeoutMs = this.getTimeoutMs();
	}

	getOverview(): Promise<WidgetsMessagingOverview> {
		return this.requestPath(WIDGETS_MESSAGING_OVERVIEW_PATH, isOverview);
	}

	getFailures(
		page: number,
		limit: number,
		filters: WidgetsDeliveryFailureFilters
	): Promise<WidgetsDeliveryFailuresPage> {
		const query = new URLSearchParams({
			page: String(page),
			limit: String(limit)
		});
		for (const [key, value] of Object.entries(filters)) {
			if (value?.trim()) query.set(key, value.trim());
		}
		return this.request(`?${query.toString()}`, isFailuresPage);
	}

	async retryFailure(
		id: string,
		actorId: string
	): Promise<WidgetsDeliveryFailureRetryResult> {
		const result = await this.request(
			`/${encodeURIComponent(id)}/retry`,
			isRetryResult,
			{ method: 'POST', body: JSON.stringify({ actorId }) }
		);
		return {
			id: result.id,
			eventId: result.eventId,
			integration: result.integration,
			retryingAt: result.retryingAt
		};
	}

	async closeFailure(
		id: string,
		actorId: string,
		comment: string
	): Promise<WidgetsDeliveryFailureCloseResult> {
		const result = await this.request(
			`/${encodeURIComponent(id)}/close`,
			isCloseResult,
			{ method: 'POST', body: JSON.stringify({ actorId, comment }) }
		);
		return {
			id: result.id,
			eventId: result.eventId,
			integration: result.integration,
			resolvedAt: result.resolvedAt,
			resolution: result.resolution,
			resolutionComment: result.resolutionComment
		};
	}

	private async request<T>(
		suffix: string,
		validate: ResponseValidator<T>,
		init: RequestInit = {}
	): Promise<T> {
		return this.requestPath(
			`${WIDGETS_DELIVERY_FAILURES_PATH}${suffix}`,
			validate,
			init
		);
	}

	private async requestPath<T>(
		path: string,
		validate: ResponseValidator<T>,
		init: RequestInit = {}
	): Promise<T> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		timeout.unref();
		try {
			const response = await fetch(`${this.baseUrl}/${path}`, {
				...init,
				redirect: 'error',
				headers: {
					Accept: 'application/json',
					...createMessagingHeaders({ messageId: randomUUID() }),
					'x-winwidget-internal-token': this.token,
					...(init.body ? { 'Content-Type': 'application/json' } : {}),
					...(init.headers || {})
				},
				signal: controller.signal
			});
			const body: unknown = await response.json().catch(() => null);
			if (!response.ok) {
				throw new WidgetsDeliveryInternalApiError(
					response.status,
					this.getErrorMessage(
						isRecord(body) ? body : null,
						response.status
					)
				);
			}
			if (!validate(body)) {
				throw new BadGatewayException('Widgets вернул некорректный ответ');
			}
			return body;
		} catch (error) {
			if (
				error instanceof WidgetsDeliveryInternalApiError ||
				error instanceof BadGatewayException
			) {
				throw error;
			}
			throw new ServiceUnavailableException(
				error instanceof Error && error.name === 'AbortError'
					? 'Widgets не ответил вовремя'
					: 'Widgets недоступен'
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	private getBaseUrl(): string {
		const raw =
			process.env.WIDGETS_INTERNAL_BASE_URL?.trim() ||
			DEFAULT_INTERNAL_URL;
		const url = new URL(raw);
		if (
			url.protocol !== 'http:' ||
			!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			throw new Error(
				'WIDGETS_INTERNAL_BASE_URL must be an exact loopback HTTP origin'
			);
		}
		return url.origin;
	}

	private getToken(): string {
		const token = process.env.WIDGETS_INTERNAL_TOKEN?.trim();
		if (
			!token ||
			token.length < MIN_INTERNAL_TOKEN_LENGTH ||
			[
				'XYZXYZXYZ',
				'change-me',
				'WIDGETS_INTERNAL_TOKEN',
				'ci_widgets_internal_token_at_least_32_chars'
			].includes(token)
		) {
			throw new Error(
				`WIDGETS_INTERNAL_TOKEN must contain at least ${MIN_INTERNAL_TOKEN_LENGTH} characters`
			);
		}
		return token;
	}

	private getTimeoutMs(): number {
		const value = Number(
			process.env.WIDGETS_INTERNAL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS
		);
		return Number.isInteger(value) && value >= 500
			? Math.min(value, 30_000)
			: DEFAULT_TIMEOUT_MS;
	}

	private getErrorMessage(
		body: Record<string, unknown> | null,
		status: number
	): string {
		const message = body?.message;
		if (isNonEmptyString(message)) return message.slice(0, 1000);
		if (Array.isArray(message)) {
			const normalized = message.filter(isString).join('; ').trim();
			if (normalized) return normalized.slice(0, 1000);
		}
		return `Widgets вернул HTTP ${status}`;
	}
}
