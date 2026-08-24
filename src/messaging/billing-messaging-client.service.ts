import {
	BILLING_INTERNAL_TOKEN_ENV,
	BILLING_INTERNAL_TOKEN_HEADER,
	BILLING_INTERNAL_TOKEN_MIN_LENGTH,
	BILLING_SERVICE_BASE_URL_ENV,
	BILLING_SERVICE_DEFAULT_BASE_URL,
	BILLING_SERVICE_TIMEOUT_ENV
} from '@/billing-boundary/billing-boundary.constants';
import { createMessagingHeaders } from '@/messaging/messaging-context';
import {
	BadGatewayException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

const OVERVIEW_PATH = '/internal/v1/billing/messaging/overview';
const FAILURES_PATH = '/internal/v1/billing/messaging/failures';
const DEFAULT_TIMEOUT_MS = 5_000;
const INSECURE_TOKENS = new Set([
	'XYZXYZXYZ',
	'change-me',
	'change_me',
	'BILLING_INTERNAL_TOKEN',
	'billing_internal_token'
]);
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const BILLING_FAILURE_CONSUMERS = [
	'identity',
	'offer',
	'notification-routing',
	'trial-request',
	'referral-request',
	'lifecycle-repair',
	'auto-renewal-charge',
	'notification-outcome'
] as const;

export type BillingFailureConsumer =
	(typeof BILLING_FAILURE_CONSUMERS)[number];
export type BillingFailureStatus = 'OPEN' | 'RETRY_PENDING' | 'RESOLVED';

export const BILLING_MESSAGING_SERVICES = [
	'billing-api',
	'billing-scheduler',
	'billing-worker',
	'billing-outbox-publisher'
] as const;

export type BillingMessagingService =
	(typeof BILLING_MESSAGING_SERVICES)[number];

export interface BillingMessagingHeartbeat {
	service: BillingMessagingService;
	status: 'ok' | 'down';
	activeInstances: number;
	lastSeenAt: string | null;
	revision: string | null;
}

export interface BillingMessagingOverview {
	schemaVersion: 1;
	generatedAt: string;
	outbox: Record<'PENDING' | 'PROCESSING' | 'PUBLISHED', number>;
	oldestPendingAt: string | null;
	unresolvedFailures: number;
	retryingFailures: number;
	deliveredLast24Hours: number;
	operational?: {
		dueOutbox: number;
		staleOutbox: number;
		unresolvedFailuresByCategory: Record<
			| 'TRANSIENT'
			| 'RATE_LIMIT'
			| 'PERMANENT'
			| 'AUTH_CONFIGURATION'
			| 'UNCLASSIFIED',
			number
		>;
	};
	providers?: {
		yookassa: boolean;
	};
	heartbeats?: BillingMessagingHeartbeat[];
}

export interface BillingMessagingFailureView {
	id: string;
	eventId: string;
	consumer: BillingFailureConsumer;
	routingKey: string;
	errorCode: string | null;
	errorSafe: string | null;
	attempt: number;
	status: BillingFailureStatus;
	category:
		| 'TRANSIENT'
		| 'RATE_LIMIT'
		| 'PERMANENT'
		| 'AUTH_CONFIGURATION'
		| null;
	normalizedCode: string | null;
	safeReason: string | null;
	httpStatus: number | null;
	providerCode: string | null;
	retryable: boolean | null;
	classificationVersion: number | null;
	firstFailedAt: string | null;
	failedAt: string;
	retryingAt: string | null;
	resolvedAt: string | null;
	resolution: 'DELIVERED' | 'CLOSED_NO_RETRY' | null;
	resolutionComment: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface BillingMessagingFailuresPage {
	schemaVersion: 1;
	items: BillingMessagingFailureView[];
	total: number;
	page: number;
	limit: number;
	totalPages: number;
}

export interface BillingMessagingRetryResult {
	schemaVersion: 1;
	id: string;
	eventId: string;
	consumer: BillingFailureConsumer;
	status: 'RETRY_PENDING';
	retryOutboxId: string;
	retryingAt: string;
	duplicate: boolean;
}

export interface BillingMessagingCloseResult {
	schemaVersion: 1;
	id: string;
	eventId: string;
	consumer: BillingFailureConsumer;
	status: 'RESOLVED';
	resolvedAt: string;
	resolution: 'CLOSED_NO_RETRY';
	resolutionComment: string;
	duplicate: boolean;
}

export class BillingMessagingInternalApiError extends Error {
	constructor(
		readonly statusCode: number,
		message: string
	) {
		super(message);
		this.name = 'BillingMessagingInternalApiError';
	}
}

type JsonRecord = Record<string, unknown>;
type Validator<T> = (value: unknown) => value is T;

const isRecord = (value: unknown): value is JsonRecord =>
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
const isUuid = (value: unknown): value is string =>
	isString(value) && UUID_PATTERN.test(value);
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
const hasExactKeys = (
	value: JsonRecord,
	keys: readonly string[]
): boolean => {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === expected[index])
	);
};
const isConsumer = (value: unknown): value is BillingFailureConsumer =>
	isString(value) &&
	BILLING_FAILURE_CONSUMERS.includes(value as BillingFailureConsumer);
const isFailureStatus = (value: unknown): value is BillingFailureStatus =>
	value === 'OPEN' || value === 'RETRY_PENDING' || value === 'RESOLVED';
const isNullableNonNegativeInteger = (
	value: unknown
): value is number | null => value === null || isNonNegativeInteger(value);
const isBillingMessagingHeartbeat = (
	value: unknown
): value is BillingMessagingHeartbeat =>
	isRecord(value) &&
	hasExactKeys(value, [
		'service',
		'status',
		'activeInstances',
		'lastSeenAt',
		'revision'
	]) &&
	BILLING_MESSAGING_SERVICES.includes(
		value.service as BillingMessagingService
	) &&
	(value.status === 'ok' || value.status === 'down') &&
	isNonNegativeInteger(value.activeInstances) &&
	isNullableIsoDate(value.lastSeenAt) &&
	isNullableString(value.revision) &&
	(value.status === 'ok'
		? value.activeInstances === 1 &&
			isIsoDate(value.lastSeenAt) &&
			isNonEmptyString(value.revision)
		: value.activeInstances === 0 &&
			value.lastSeenAt === null &&
			value.revision === null);
const isBillingOperational = (
	value: unknown
): value is NonNullable<BillingMessagingOverview['operational']> => {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			'dueOutbox',
			'staleOutbox',
			'unresolvedFailuresByCategory'
		]) ||
		!isRecord(value.unresolvedFailuresByCategory) ||
		!hasExactKeys(value.unresolvedFailuresByCategory, [
			'TRANSIENT',
			'RATE_LIMIT',
			'PERMANENT',
			'AUTH_CONFIGURATION',
			'UNCLASSIFIED'
		])
	) {
		return false;
	}
	return (
		isNonNegativeInteger(value.dueOutbox) &&
		isNonNegativeInteger(value.staleOutbox) &&
		Object.values(value.unresolvedFailuresByCategory).every(
			isNonNegativeInteger
		)
	);
};

const isBillingProviders = (
	value: unknown
): value is NonNullable<BillingMessagingOverview['providers']> =>
	isRecord(value) &&
	hasExactKeys(value, ['yookassa']) &&
	typeof value.yookassa === 'boolean';

const isOverview = (value: unknown): value is BillingMessagingOverview => {
	const overviewKeys = [
		'schemaVersion',
		'generatedAt',
		'outbox',
		'oldestPendingAt',
		'unresolvedFailures',
		'retryingFailures',
		'deliveredLast24Hours'
	] as const;
	const expectedKeys: string[] = [...overviewKeys];
	if (isRecord(value)) {
		if (Object.prototype.hasOwnProperty.call(value, 'operational')) {
			expectedKeys.push('operational');
		}
		if (Object.prototype.hasOwnProperty.call(value, 'heartbeats')) {
			expectedKeys.push('heartbeats');
		}
		if (Object.prototype.hasOwnProperty.call(value, 'providers')) {
			expectedKeys.push('providers');
		}
	}
	if (
		!isRecord(value) ||
		!hasExactKeys(value, expectedKeys) ||
		!isRecord(value.outbox) ||
		!hasExactKeys(value.outbox, ['PENDING', 'PROCESSING', 'PUBLISHED'])
	) {
		return false;
	}
	return (
		value.schemaVersion === 1 &&
		isIsoDate(value.generatedAt) &&
		['PENDING', 'PROCESSING', 'PUBLISHED'].every(status =>
			isNonNegativeInteger((value.outbox as JsonRecord)[status])
		) &&
		isNullableIsoDate(value.oldestPendingAt) &&
		isNonNegativeInteger(value.unresolvedFailures) &&
		isNonNegativeInteger(value.retryingFailures) &&
		isNonNegativeInteger(value.deliveredLast24Hours) &&
		(value.operational === undefined ||
			(isBillingOperational(value.operational) &&
				Object.values(
					value.operational.unresolvedFailuresByCategory
				).reduce((total, count) => total + count, 0) ===
					value.unresolvedFailures)) &&
		(value.providers === undefined ||
			isBillingProviders(value.providers)) &&
		(value.heartbeats === undefined ||
			(Array.isArray(value.heartbeats) &&
				value.heartbeats.length === BILLING_MESSAGING_SERVICES.length &&
				value.heartbeats.every(isBillingMessagingHeartbeat) &&
				new Set(value.heartbeats.map(item => item.service)).size ===
					BILLING_MESSAGING_SERVICES.length))
	);
};

const isFailure = (
	value: unknown
): value is BillingMessagingFailureView => {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			'id',
			'eventId',
			'consumer',
			'routingKey',
			'errorCode',
			'errorSafe',
			'attempt',
			'status',
			'category',
			'normalizedCode',
			'safeReason',
			'httpStatus',
			'providerCode',
			'retryable',
			'classificationVersion',
			'firstFailedAt',
			'failedAt',
			'retryingAt',
			'resolvedAt',
			'resolution',
			'resolutionComment',
			'createdAt',
			'updatedAt'
		])
	) {
		return false;
	}
	return (
		isUuid(value.id) &&
		isUuid(value.eventId) &&
		isConsumer(value.consumer) &&
		isNonEmptyString(value.routingKey) &&
		isNullableString(value.errorCode) &&
		isNullableString(value.errorSafe) &&
		isNonNegativeInteger(value.attempt) &&
		isFailureStatus(value.status) &&
		(value.category === null ||
			value.category === 'TRANSIENT' ||
			value.category === 'RATE_LIMIT' ||
			value.category === 'PERMANENT' ||
			value.category === 'AUTH_CONFIGURATION') &&
		isNullableString(value.normalizedCode) &&
		isNullableString(value.safeReason) &&
		isNullableNonNegativeInteger(value.httpStatus) &&
		isNullableString(value.providerCode) &&
		(value.retryable === null || typeof value.retryable === 'boolean') &&
		isNullableNonNegativeInteger(value.classificationVersion) &&
		isNullableIsoDate(value.firstFailedAt) &&
		isIsoDate(value.failedAt) &&
		isNullableIsoDate(value.retryingAt) &&
		isNullableIsoDate(value.resolvedAt) &&
		(value.resolution === null ||
			value.resolution === 'DELIVERED' ||
			value.resolution === 'CLOSED_NO_RETRY') &&
		isNullableString(value.resolutionComment) &&
		isIsoDate(value.createdAt) &&
		isIsoDate(value.updatedAt)
	);
};

const isFailuresPage = (
	value: unknown
): value is BillingMessagingFailuresPage =>
	isRecord(value) &&
	hasExactKeys(value, [
		'schemaVersion',
		'items',
		'total',
		'page',
		'limit',
		'totalPages'
	]) &&
	value.schemaVersion === 1 &&
	Array.isArray(value.items) &&
	value.items.every(isFailure) &&
	isNonNegativeInteger(value.total) &&
	isPositiveInteger(value.page) &&
	isPositiveInteger(value.limit) &&
	isPositiveInteger(value.totalPages);

const isRetryResult = (
	value: unknown
): value is BillingMessagingRetryResult =>
	isRecord(value) &&
	hasExactKeys(value, [
		'schemaVersion',
		'id',
		'eventId',
		'consumer',
		'status',
		'retryOutboxId',
		'retryingAt',
		'duplicate'
	]) &&
	value.schemaVersion === 1 &&
	isUuid(value.id) &&
	isUuid(value.eventId) &&
	isConsumer(value.consumer) &&
	value.status === 'RETRY_PENDING' &&
	isNonEmptyString(value.retryOutboxId) &&
	isIsoDate(value.retryingAt) &&
	typeof value.duplicate === 'boolean';

const isCloseResult = (
	value: unknown
): value is BillingMessagingCloseResult =>
	isRecord(value) &&
	hasExactKeys(value, [
		'schemaVersion',
		'id',
		'eventId',
		'consumer',
		'status',
		'resolvedAt',
		'resolution',
		'resolutionComment',
		'duplicate'
	]) &&
	value.schemaVersion === 1 &&
	isUuid(value.id) &&
	isUuid(value.eventId) &&
	isConsumer(value.consumer) &&
	value.status === 'RESOLVED' &&
	isIsoDate(value.resolvedAt) &&
	value.resolution === 'CLOSED_NO_RETRY' &&
	isNonEmptyString(value.resolutionComment) &&
	typeof value.duplicate === 'boolean';

@Injectable()
export class BillingMessagingClientService {
	constructor(private readonly config: ConfigService) {}

	getOverview(): Promise<BillingMessagingOverview> {
		return this.request(OVERVIEW_PATH, isOverview);
	}

	getFailures(
		page: number,
		limit: number,
		filters: { consumer?: string; category?: string; status?: string }
	): Promise<BillingMessagingFailuresPage> {
		const query = new URLSearchParams({
			page: String(page),
			limit: String(limit)
		});
		if (filters.consumer?.trim()) {
			query.set('consumer', filters.consumer.trim());
		}
		if (filters.category?.trim()) {
			query.set('category', filters.category.trim());
		}
		if (filters.status?.trim()) query.set('status', filters.status.trim());
		return this.request(
			`${FAILURES_PATH}?${query.toString()}`,
			isFailuresPage
		);
	}

	retryFailure(
		id: string,
		actorId: string
	): Promise<BillingMessagingRetryResult> {
		const commandId = randomUUID();
		return this.request(
			`${FAILURES_PATH}/${encodeURIComponent(id)}/retry`,
			isRetryResult,
			{
				method: 'POST',
				body: JSON.stringify({
					schemaVersion: 1,
					commandId,
					actorId,
					actorRole: 'DEV',
					occurredAt: new Date().toISOString()
				}),
				headers: { 'idempotency-key': commandId }
			}
		);
	}

	closeFailure(
		id: string,
		actorId: string,
		comment: string
	): Promise<BillingMessagingCloseResult> {
		const commandId = randomUUID();
		return this.request(
			`${FAILURES_PATH}/${encodeURIComponent(id)}/close`,
			isCloseResult,
			{
				method: 'POST',
				body: JSON.stringify({
					schemaVersion: 1,
					commandId,
					actorId,
					actorRole: 'DEV',
					occurredAt: new Date().toISOString(),
					comment
				}),
				headers: { 'idempotency-key': commandId }
			}
		);
	}

	private async request<T>(
		path: string,
		validate: Validator<T>,
		init: RequestInit = {}
	): Promise<T> {
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			this.getTimeoutMs()
		);
		timeout.unref();
		try {
			const response = await fetch(`${this.getBaseUrl()}${path}`, {
				...init,
				redirect: 'error',
				headers: {
					Accept: 'application/json',
					...createMessagingHeaders({ messageId: randomUUID() }),
					[BILLING_INTERNAL_TOKEN_HEADER]: this.getToken(),
					...(init.body ? { 'Content-Type': 'application/json' } : {}),
					...(init.headers || {})
				},
				signal: controller.signal
			});
			const body: unknown = await response.json().catch(() => null);
			if (!response.ok) {
				throw new BillingMessagingInternalApiError(
					response.status,
					this.getErrorMessage(body, response.status)
				);
			}
			if (!validate(body)) {
				throw new BadGatewayException(
					'Billing вернул некорректный messaging-ответ'
				);
			}
			return body;
		} catch (error) {
			if (
				error instanceof BillingMessagingInternalApiError ||
				error instanceof BadGatewayException ||
				error instanceof ServiceUnavailableException
			) {
				throw error;
			}
			throw new ServiceUnavailableException(
				error instanceof Error && error.name === 'AbortError'
					? 'Billing не ответил вовремя'
					: 'Billing недоступен'
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	private getBaseUrl(): string {
		const raw =
			this.config.get<string>(BILLING_SERVICE_BASE_URL_ENV)?.trim() ||
			BILLING_SERVICE_DEFAULT_BASE_URL;
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new ServiceUnavailableException(
				'Billing internal URL is invalid'
			);
		}
		if (
			url.protocol !== 'http:' ||
			!this.isLoopbackHost(url.hostname) ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			throw new ServiceUnavailableException(
				'Billing internal URL must be an exact loopback HTTP origin'
			);
		}
		return url.origin;
	}

	private getToken(): string {
		const token =
			this.config.get<string>(BILLING_INTERNAL_TOKEN_ENV)?.trim() || '';
		if (
			token.length < BILLING_INTERNAL_TOKEN_MIN_LENGTH ||
			INSECURE_TOKENS.has(token)
		) {
			throw new ServiceUnavailableException(
				'Billing internal token is not configured securely'
			);
		}
		return token;
	}

	private getTimeoutMs(): number {
		const value = Number(
			this.config.get<string>(BILLING_SERVICE_TIMEOUT_ENV) ||
				DEFAULT_TIMEOUT_MS
		);
		return Number.isInteger(value) && value >= 500
			? Math.min(value, 30_000)
			: DEFAULT_TIMEOUT_MS;
	}

	private getErrorMessage(body: unknown, status: number): string {
		if (isRecord(body)) {
			if (isNonEmptyString(body.message)) {
				return body.message.slice(0, 1000);
			}
			if (Array.isArray(body.message)) {
				const message = body.message.filter(isString).join('; ').trim();
				if (message) return message.slice(0, 1000);
			}
		}
		return `Billing вернул HTTP ${status}`;
	}

	private isLoopbackHost(hostname: string): boolean {
		return (
			hostname === 'localhost' ||
			hostname === '::1' ||
			/^127(?:\.\d{1,3}){3}$/.test(hostname)
		);
	}
}
