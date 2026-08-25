import { createMessagingHeaders } from '@/messaging/messaging-context';
import {
	BadGatewayException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 5_000;
const INTERNAL_TOKEN_MIN_LENGTH = 32;
const INSECURE_TOKENS = new Set([
	'XYZXYZXYZ',
	'change-me',
	'change_me',
	'CAMPAIGNS_INTERNAL_TOKEN',
	'REPORTING_INTERNAL_TOKEN',
	'campaigns_internal_token',
	'reporting_internal_token',
	'ci_campaigns_internal_token_at_least_32_chars',
	'ci_reporting_internal_token_at_least_32_chars',
	'ci_support_core_token_at_least_32_chars'
]);
const OUTBOX_STATUSES = [
	'PENDING',
	'PUBLISHING',
	'PUBLISHED',
	'FAILED'
] as const;

export const CAMPAIGNS_MESSAGING_HEARTBEAT_SERVICES = [
	'campaigns-api',
	'campaigns-worker',
	'campaigns-outbox-publisher'
] as const;
export const REPORTING_MESSAGING_HEARTBEAT_SERVICES = [
	'reporting-api',
	'reporting-worker',
	'reporting-outbox-publisher',
	'reporting-scheduler'
] as const;
export const SUPPORT_MESSAGING_HEARTBEAT_SERVICES = [
	'support-api',
	'support-worker',
	'support-outbox-publisher'
] as const;

type CampaignsMessagingHeartbeatService =
	(typeof CAMPAIGNS_MESSAGING_HEARTBEAT_SERVICES)[number];
type ReportingMessagingHeartbeatService =
	(typeof REPORTING_MESSAGING_HEARTBEAT_SERVICES)[number];
type SupportMessagingHeartbeatService =
	(typeof SUPPORT_MESSAGING_HEARTBEAT_SERVICES)[number];
type ServiceOwnedMessagingHeartbeatService =
	| CampaignsMessagingHeartbeatService
	| ReportingMessagingHeartbeatService
	| SupportMessagingHeartbeatService;

export interface ServiceOwnedMessagingHeartbeat {
	service: ServiceOwnedMessagingHeartbeatService;
	status: 'ok' | 'down';
	activeInstances: number;
	lastSeenAt: string | null;
}

export interface ServiceOwnedMessagingOverview {
	schemaVersion: 1;
	generatedAt: string;
	outbox: Record<(typeof OUTBOX_STATUSES)[number], number>;
	oldestPendingAt: string | null;
	unresolvedFailures: number;
	retryingFailures: number;
	processedLast24Hours: number;
	heartbeats: ServiceOwnedMessagingHeartbeat[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (
	record: Record<string, unknown>,
	keys: readonly string[]
): boolean => {
	const actual = Object.keys(record).sort();
	const expected = [...keys].sort();
	return (
		actual.length === expected.length &&
		actual.every((key, index) => key === expected[index])
	);
};

const isNonNegativeInteger = (value: unknown): value is number =>
	Number.isSafeInteger(value) && Number(value) >= 0;

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

const isOverview = (
	value: unknown,
	expectedServices: readonly ServiceOwnedMessagingHeartbeatService[]
): value is ServiceOwnedMessagingOverview => {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			'schemaVersion',
			'generatedAt',
			'outbox',
			'oldestPendingAt',
			'unresolvedFailures',
			'retryingFailures',
			'processedLast24Hours',
			'heartbeats'
		]) ||
		value.schemaVersion !== 1 ||
		!isIsoDate(value.generatedAt) ||
		!isRecord(value.outbox) ||
		!hasExactKeys(value.outbox, OUTBOX_STATUSES) ||
		!OUTBOX_STATUSES.every(status =>
			isNonNegativeInteger(value.outbox[status])
		) ||
		!isNullableIsoDate(value.oldestPendingAt) ||
		!isNonNegativeInteger(value.unresolvedFailures) ||
		!isNonNegativeInteger(value.retryingFailures) ||
		!isNonNegativeInteger(value.processedLast24Hours) ||
		!Array.isArray(value.heartbeats) ||
		value.heartbeats.length !== expectedServices.length
	) {
		return false;
	}

	const seen = new Set<string>();
	for (const heartbeat of value.heartbeats) {
		if (
			!isRecord(heartbeat) ||
			!hasExactKeys(heartbeat, [
				'service',
				'status',
				'activeInstances',
				'lastSeenAt'
			]) ||
			typeof heartbeat.service !== 'string' ||
			!expectedServices.includes(
				heartbeat.service as ServiceOwnedMessagingHeartbeatService
			) ||
			seen.has(heartbeat.service) ||
			(heartbeat.status !== 'ok' && heartbeat.status !== 'down') ||
			!isNonNegativeInteger(heartbeat.activeInstances) ||
			(heartbeat.status === 'ok') !== heartbeat.activeInstances > 0 ||
			!isNullableIsoDate(heartbeat.lastSeenAt) ||
			(heartbeat.status === 'ok' && heartbeat.lastSeenAt === null)
		) {
			return false;
		}
		seen.add(heartbeat.service);
	}
	return expectedServices.every(service => seen.has(service));
};

@Injectable()
export class ServiceOwnedMessagingOverviewClientService {
	constructor(private readonly config: ConfigService) {}

	getCampaignsOverview(): Promise<ServiceOwnedMessagingOverview> {
		return this.request(
			'Campaigns',
			'http://127.0.0.1:4500/internal/v1/campaigns/messaging/overview',
			'CAMPAIGNS_INTERNAL_TOKEN',
			CAMPAIGNS_MESSAGING_HEARTBEAT_SERVICES
		);
	}

	getReportingOverview(): Promise<ServiceOwnedMessagingOverview> {
		return this.request(
			'Reporting',
			'http://127.0.0.1:4600/internal/v1/reporting/messaging/overview',
			'REPORTING_INTERNAL_TOKEN',
			REPORTING_MESSAGING_HEARTBEAT_SERVICES
		);
	}

	getSupportOverview(): Promise<ServiceOwnedMessagingOverview> {
		const baseUrl =
			this.config.get<string>('SUPPORT_INTERNAL_BASE_URL')?.trim() || '';
		if (baseUrl !== 'http://127.0.0.1:5100') {
			throw new ServiceUnavailableException(
				'Support internal endpoint is not configured securely'
			);
		}
		return this.request(
			'Support',
			`${baseUrl}/internal/v1/support/messaging/overview`,
			'SUPPORT_CORE_TOKEN',
			SUPPORT_MESSAGING_HEARTBEAT_SERVICES
		);
	}

	private async request(
		owner: 'Campaigns' | 'Reporting' | 'Support',
		url: string,
		tokenName:
			| 'CAMPAIGNS_INTERNAL_TOKEN'
			| 'REPORTING_INTERNAL_TOKEN'
			| 'SUPPORT_CORE_TOKEN',
		expectedServices: readonly ServiceOwnedMessagingHeartbeatService[]
	): Promise<ServiceOwnedMessagingOverview> {
		const token = this.getToken(tokenName, owner);
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			DEFAULT_TIMEOUT_MS
		);
		timeout.unref();
		try {
			const response = await fetch(url, {
				redirect: 'error',
				headers: {
					Accept: 'application/json',
					...createMessagingHeaders({ messageId: randomUUID() }),
					'x-winwidget-service': 'core',
					'x-winwidget-internal-token': token
				},
				signal: controller.signal
			});
			if (!response.ok) {
				throw new ServiceUnavailableException(
					`${owner} messaging overview вернул HTTP ${response.status}`
				);
			}
			const body: unknown = await response.json().catch(() => null);
			if (!isOverview(body, expectedServices)) {
				throw new BadGatewayException(
					`${owner} вернул некорректный messaging overview`
				);
			}
			return body;
		} catch (error) {
			if (
				error instanceof BadGatewayException ||
				error instanceof ServiceUnavailableException
			) {
				throw error;
			}
			throw new ServiceUnavailableException(
				error instanceof Error && error.name === 'AbortError'
					? `${owner} messaging overview не ответил вовремя`
					: `${owner} messaging overview недоступен`
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	private getToken(
		name:
			| 'CAMPAIGNS_INTERNAL_TOKEN'
			| 'REPORTING_INTERNAL_TOKEN'
			| 'SUPPORT_CORE_TOKEN',
		owner: 'Campaigns' | 'Reporting' | 'Support'
	): string {
		const token = this.config.get<string>(name)?.trim() || '';
		if (
			token.length < INTERNAL_TOKEN_MIN_LENGTH ||
			INSECURE_TOKENS.has(token)
		) {
			throw new ServiceUnavailableException(
				`${owner} internal token is not configured securely`
			);
		}
		return token;
	}
}
