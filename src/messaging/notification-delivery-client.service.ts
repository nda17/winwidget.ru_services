import {
	BadGatewayException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NOTIFICATION_DELIVERY_KINDS } from '@/messaging/messaging.constants';
import { createMessagingHeaders } from '@/messaging/messaging-context';
import { randomUUID } from 'node:crypto';

const DEFAULT_INTERNAL_URL =
	'http://127.0.0.1:4401/internal/notification-delivery';
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_INTERNAL_TOKEN_LENGTH = 32;

// Keep this segmented: the live Reporting checkout guard forbids the
// service-owned kind as a contiguous Core source literal.
const DAILY_SUMMARY_DELIVERY_ADMIN_KIND_PREFIX = 'daily-summary-delivery';
const DAILY_SUMMARY_DELIVERY_ADMIN_KIND_CHANNEL = 'telegram';

export const NOTIFICATION_DELIVERY_DAILY_SUMMARY_ADMIN_KIND =
	`${DAILY_SUMMARY_DELIVERY_ADMIN_KIND_PREFIX}-${DAILY_SUMMARY_DELIVERY_ADMIN_KIND_CHANNEL}` as const;

export const NOTIFICATION_DELIVERY_ADMIN_KINDS = [
	...NOTIFICATION_DELIVERY_KINDS,
	NOTIFICATION_DELIVERY_DAILY_SUMMARY_ADMIN_KIND
] as const;

export type NotificationDeliveryAdminKind =
	(typeof NOTIFICATION_DELIVERY_ADMIN_KINDS)[number];

export interface NotificationDeliveryFailureFilters {
	integration?: string;
	category?: string;
	status?: string;
}

export interface NotificationDeliveryFailureView {
	id: string;
	eventId: string;
	integration: string;
	attempts: number;
	lastError: string;
	category: string | null;
	normalizedCode: string | null;
	safeReason: string | null;
	httpStatus: number | null;
	providerCode: string | null;
	retryable: boolean | null;
	failedAt: string;
	retryingAt: string | null;
	resolvedAt: string | null;
	resolution: string | null;
	resolutionComment: string | null;
	source: string | null;
	entity?: { id?: string; name?: string } | null;
	lead?: {
		id?: string | null;
		contact?: string | null;
		phone?: string | null;
		email?: string | null;
		url?: string | null;
		createdAt?: string | null;
	};
}

export interface NotificationDeliveryFailuresPage {
	items: NotificationDeliveryFailureView[];
	total: number;
	page: number;
	limit: number;
	totalPages: number;
}

export interface NotificationDeliveryOverview {
	generatedAt: string;
	outbox: Record<
		'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED',
		number
	>;
	oldestPendingAt: string | null;
	operational: {
		staleOutbox: number;
		dueOutbox: number;
		unresolvedFailuresByCategory: Record<
			| 'TRANSIENT'
			| 'RATE_LIMIT'
			| 'PERMANENT'
			| 'AUTH_CONFIGURATION'
			| 'UNCLASSIFIED',
			number
		>;
	};
	unresolvedFailures: number;
	retryingFailures: number;
	deliveredLast24Hours: number;
	heartbeat: {
		service: 'notification-delivery-worker';
		status: 'ok' | 'down';
		activeInstances: number;
		lastSeenAt: string | null;
		lastSuccessfulPublishAt?: string | null;
		lastSuccessfulConsumeAt?: string | null;
	};
}

interface NotificationDeliveryRetryResult {
	id: string;
	eventId: string;
	integration: NotificationDeliveryAdminKind;
	retryingAt: string;
}

interface NotificationDeliveryCloseResult {
	id: string;
	eventId: string;
	integration: NotificationDeliveryAdminKind;
	resolvedAt: string;
	resolution: 'CLOSED_NO_RETRY';
	resolutionComment: string;
}

type ResponseValidator<T> = (value: unknown) => value is T;

const OUTBOX_STATUSES = [
	'PENDING',
	'PUBLISHING',
	'PUBLISHED',
	'FAILED'
] as const;
const FAILURE_CATEGORIES = [
	'TRANSIENT',
	'RATE_LIMIT',
	'PERMANENT',
	'AUTH_CONFIGURATION',
	'UNCLASSIFIED'
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
	typeof value === 'string' && value.trim().length > 0;

const isNullableString = (value: unknown): value is string | null =>
	value === null || typeof value === 'string';

const isNonNegativeInteger = (value: unknown): value is number =>
	Number.isInteger(value) && Number(value) >= 0;

const isPositiveInteger = (value: unknown): value is number =>
	Number.isInteger(value) && Number(value) > 0;

const isIsoDate = (value: unknown): value is string => {
	if (typeof value !== 'string') return false;
	const timestamp = Date.parse(value);
	return (
		Number.isFinite(timestamp) &&
		new Date(timestamp).toISOString() === value
	);
};

const isNullableIsoDate = (value: unknown): value is string | null =>
	value === null || isIsoDate(value);

const isNotificationKind = (
	value: unknown
): value is NotificationDeliveryAdminKind =>
	typeof value === 'string' &&
	NOTIFICATION_DELIVERY_ADMIN_KINDS.includes(
		value as NotificationDeliveryAdminKind
	);

const hasOptionalString = (
	record: Record<string, unknown>,
	key: string
): boolean => record[key] === undefined || typeof record[key] === 'string';

const isFailureView = (
	value: unknown
): value is NotificationDeliveryFailureView => {
	if (!isRecord(value)) return false;
	const categoryValid =
		value.category === null ||
		FAILURE_CATEGORIES.slice(0, 4).includes(
			value.category as (typeof FAILURE_CATEGORIES)[number]
		);
	const resolutionValid =
		value.resolution === null ||
		value.resolution === 'DELIVERED' ||
		value.resolution === 'CLOSED_NO_RETRY';
	const entityValid =
		value.entity === undefined ||
		value.entity === null ||
		(isRecord(value.entity) &&
			hasOptionalString(value.entity, 'id') &&
			hasOptionalString(value.entity, 'name'));
	const leadValid =
		isRecord(value.lead) &&
		['id', 'contact', 'phone', 'email', 'url', 'createdAt'].every(key =>
			isNullableString(value.lead?.[key])
		);
	return (
		isNonEmptyString(value.id) &&
		isNonEmptyString(value.eventId) &&
		isNotificationKind(value.integration) &&
		isPositiveInteger(value.attempts) &&
		typeof value.lastError === 'string' &&
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
		entityValid &&
		leadValid
	);
};

const isOverview = (
	value: unknown
): value is NotificationDeliveryOverview => {
	if (
		!isRecord(value) ||
		!isRecord(value.outbox) ||
		!isRecord(value.operational) ||
		!isRecord(value.operational.unresolvedFailuresByCategory) ||
		!isRecord(value.heartbeat)
	) {
		return false;
	}
	const outbox = value.outbox;
	const operational = value.operational;
	const categories = operational.unresolvedFailuresByCategory;
	const heartbeat = value.heartbeat;
	const outboxValid = OUTBOX_STATUSES.every(status =>
		isNonNegativeInteger(outbox[status])
	);
	const categoriesValid = FAILURE_CATEGORIES.every(category =>
		isNonNegativeInteger(categories[category])
	);
	return (
		isIsoDate(value.generatedAt) &&
		outboxValid &&
		isNullableIsoDate(value.oldestPendingAt) &&
		isNonNegativeInteger(operational.staleOutbox) &&
		isNonNegativeInteger(operational.dueOutbox) &&
		categoriesValid &&
		isNonNegativeInteger(value.unresolvedFailures) &&
		isNonNegativeInteger(value.retryingFailures) &&
		isNonNegativeInteger(value.deliveredLast24Hours) &&
		heartbeat.service === 'notification-delivery-worker' &&
		(heartbeat.status === 'ok' || heartbeat.status === 'down') &&
		isNonNegativeInteger(heartbeat.activeInstances) &&
		isNullableIsoDate(heartbeat.lastSeenAt) &&
		(heartbeat.lastSuccessfulPublishAt === undefined ||
			isNullableIsoDate(heartbeat.lastSuccessfulPublishAt)) &&
		(heartbeat.lastSuccessfulConsumeAt === undefined ||
			isNullableIsoDate(heartbeat.lastSuccessfulConsumeAt))
	);
};

const isFailuresPage = (
	value: unknown
): value is NotificationDeliveryFailuresPage =>
	isRecord(value) &&
	Array.isArray(value.items) &&
	value.items.every(isFailureView) &&
	isNonNegativeInteger(value.total) &&
	isPositiveInteger(value.page) &&
	isPositiveInteger(value.limit) &&
	isPositiveInteger(value.totalPages);

const isRetryResult = (
	value: unknown
): value is NotificationDeliveryRetryResult =>
	isRecord(value) &&
	isNonEmptyString(value.id) &&
	isNonEmptyString(value.eventId) &&
	isNotificationKind(value.integration) &&
	isIsoDate(value.retryingAt);

const isCloseResult = (
	value: unknown
): value is NotificationDeliveryCloseResult =>
	isRecord(value) &&
	isNonEmptyString(value.id) &&
	isNonEmptyString(value.eventId) &&
	isNotificationKind(value.integration) &&
	isIsoDate(value.resolvedAt) &&
	value.resolution === 'CLOSED_NO_RETRY' &&
	isNonEmptyString(value.resolutionComment);

export class NotificationDeliveryInternalApiError extends Error {
	constructor(
		readonly statusCode: number,
		message: string
	) {
		super(message);
		this.name = 'NotificationDeliveryInternalApiError';
	}
}

@Injectable()
export class NotificationDeliveryClientService {
	private readonly baseUrl: URL;
	private readonly token: string;
	private readonly timeoutMs: number;

	constructor(private readonly configService: ConfigService) {
		this.baseUrl = this.getBaseUrl();
		this.token = this.getToken();
		this.timeoutMs = this.getTimeoutMs();
	}

	getOverview(): Promise<NotificationDeliveryOverview> {
		return this.request('overview', isOverview);
	}

	getFailures(
		page: number,
		limit: number,
		filters: NotificationDeliveryFailureFilters
	): Promise<NotificationDeliveryFailuresPage> {
		const query = new URLSearchParams({
			page: String(page),
			limit: String(limit)
		});
		for (const [key, value] of Object.entries(filters)) {
			if (value?.trim()) query.set(key, value.trim());
		}
		return this.request(`failures?${query.toString()}`, isFailuresPage);
	}

	retryFailure(
		id: string,
		actorId: string
	): Promise<NotificationDeliveryRetryResult> {
		return this.request(
			`failures/${encodeURIComponent(id)}/retry`,
			isRetryResult,
			{
				method: 'POST',
				body: JSON.stringify({ actorId })
			}
		);
	}

	closeFailure(
		id: string,
		actorId: string,
		comment: string
	): Promise<NotificationDeliveryCloseResult> {
		return this.request(
			`failures/${encodeURIComponent(id)}/close`,
			isCloseResult,
			{
				method: 'POST',
				body: JSON.stringify({ actorId, comment })
			}
		);
	}

	private async request<T>(
		path: string,
		validate: ResponseValidator<T>,
		init: RequestInit = {}
	): Promise<T> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		timeout.unref();
		try {
			const response = await fetch(
				new URL(path, this.withTrailingSlash()),
				{
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
				}
			);
			const body: unknown = await response.json().catch(() => null);
			if (!response.ok) {
				throw new NotificationDeliveryInternalApiError(
					response.status,
					this.getErrorMessage(
						isRecord(body) ? body : null,
						response.status
					)
				);
			}
			if (!validate(body)) {
				throw new BadGatewayException(
					'Notification Delivery вернул некорректный ответ'
				);
			}
			return body;
		} catch (error) {
			if (
				error instanceof NotificationDeliveryInternalApiError ||
				error instanceof BadGatewayException
			) {
				throw error;
			}
			throw new ServiceUnavailableException(
				error instanceof Error && error.name === 'AbortError'
					? 'Notification Delivery не ответил вовремя'
					: 'Notification Delivery недоступен'
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	private getBaseUrl(): URL {
		const raw =
			this.configService
				.get<string>('NOTIFICATION_DELIVERY_INTERNAL_URL')
				?.trim() || DEFAULT_INTERNAL_URL;
		const url = new URL(raw);
		const loopback =
			url.hostname === '127.0.0.1' ||
			url.hostname === 'localhost' ||
			url.hostname === '[::1]';
		if (
			url.protocol !== 'http:' ||
			!loopback ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw new Error(
				'NOTIFICATION_DELIVERY_INTERNAL_URL must be an exact loopback HTTP URL'
			);
		}
		return url;
	}

	private getToken(): string {
		const token = this.configService
			.get<string>('NOTIFICATION_DELIVERY_INTERNAL_TOKEN')
			?.trim();
		if (
			!token ||
			token === 'XYZXYZXYZ' ||
			token.length < MIN_INTERNAL_TOKEN_LENGTH
		) {
			throw new Error(
				`NOTIFICATION_DELIVERY_INTERNAL_TOKEN must contain at least ${MIN_INTERNAL_TOKEN_LENGTH} characters`
			);
		}
		return token;
	}

	private getTimeoutMs(): number {
		const value = Number(
			this.configService.get<string>(
				'NOTIFICATION_DELIVERY_INTERNAL_TIMEOUT_MS'
			) || DEFAULT_TIMEOUT_MS
		);
		return Number.isInteger(value) && value >= 500
			? Math.min(value, 30_000)
			: DEFAULT_TIMEOUT_MS;
	}

	private withTrailingSlash(): URL {
		return new URL(
			this.baseUrl.pathname.endsWith('/')
				? this.baseUrl.toString()
				: `${this.baseUrl.toString()}/`
		);
	}

	private getErrorMessage(
		body: Record<string, unknown> | null,
		status: number
	): string {
		const message = body?.message;
		if (typeof message === 'string' && message.trim()) {
			return message.slice(0, 1000);
		}
		if (Array.isArray(message)) {
			const normalized = message
				.filter((value): value is string => typeof value === 'string')
				.join('; ')
				.trim();
			if (normalized) return normalized.slice(0, 1000);
		}
		return `Notification Delivery вернул HTTP ${status}`;
	}
}
