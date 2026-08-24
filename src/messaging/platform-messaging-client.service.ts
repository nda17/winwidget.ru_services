import { createMessagingHeaders } from '@/messaging/messaging-context';
import {
	BadGatewayException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

export const PLATFORM_MESSAGING_HEARTBEAT_SERVICES = [
	'platform-api',
	'platform-outbox-publisher'
] as const;

export type PlatformMessagingHeartbeatService =
	(typeof PLATFORM_MESSAGING_HEARTBEAT_SERVICES)[number];

export interface PlatformMessagingOverview {
	schemaVersion: 1;
	generatedAt: string;
	outbox: {
		PENDING: number;
		PROCESSING: number;
		PUBLISHED: number;
	};
	oldestPendingAt: string | null;
	operational: {
		dueOutbox: number;
		staleOutbox: number;
	};
	heartbeats: Array<{
		service: PlatformMessagingHeartbeatService;
		status: 'ok' | 'down';
		activeInstances: number;
		lastSeenAt: string | null;
		revision: string | null;
	}>;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:5000';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_OVERVIEW_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const PLACEHOLDER_TOKENS = new Set([
	'change_me',
	'change-me',
	'XYZXYZXYZ',
	'platform_core_token'
]);

const isPlaceholderToken = (value: string): boolean =>
	PLACEHOLDER_TOKENS.has(value) ||
	value.startsWith('change_me') ||
	value.startsWith('change-me') ||
	value.startsWith('ci_');

@Injectable()
export class PlatformMessagingClientService {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly timeoutMs: number;

	constructor(config: ConfigService) {
		this.baseUrl = this.parseBaseUrl(
			config.get<string>('PLATFORM_INTERNAL_BASE_URL')
		);
		this.token = config.get<string>('PLATFORM_CORE_TOKEN')?.trim() || '';
		if (this.token.length < 32 || isPlaceholderToken(this.token)) {
			throw new Error(
				'PLATFORM_CORE_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		const timeout = Number(
			config.get<string>('PLATFORM_INTERNAL_TIMEOUT_MS') ||
				DEFAULT_TIMEOUT_MS
		);
		if (!Number.isInteger(timeout) || timeout < 500 || timeout > 60_000) {
			throw new Error(
				'PLATFORM_INTERNAL_TIMEOUT_MS must be an integer between 500 and 60000'
			);
		}
		this.timeoutMs = timeout;
	}

	async getOverview(): Promise<PlatformMessagingOverview> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		timeout.unref();
		try {
			const response = await fetch(
				`${this.baseUrl}/internal/v1/platform/messaging/overview`,
				{
					redirect: 'error',
					headers: {
						Accept: 'application/json',
						...createMessagingHeaders({ messageId: randomUUID() }),
						'x-winwidget-service': 'core',
						'x-winwidget-internal-token': this.token
					},
					signal: controller.signal
				}
			);
			if (!response.ok) {
				throw new ServiceUnavailableException(
					`Platform messaging overview returned HTTP ${response.status}`
				);
			}
			if (
				!response.headers
					.get('content-type')
					?.toLowerCase()
					.startsWith('application/json')
			) {
				throw new BadGatewayException(
					'Platform returned a non-JSON messaging overview'
				);
			}
			const body = await this.readBoundedJson(response);
			if (!this.isOverview(body)) {
				throw new BadGatewayException(
					'Platform returned an invalid messaging overview'
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
					? 'Platform messaging overview timed out'
					: 'Platform messaging overview is unavailable'
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	private parseBaseUrl(value: string | undefined): string {
		const configured = value?.trim() || DEFAULT_BASE_URL;
		let url: URL;
		try {
			url = new URL(configured);
		} catch {
			throw new Error('PLATFORM_INTERNAL_BASE_URL must be a valid URL');
		}
		if (
			url.protocol !== 'http:' ||
			!['127.0.0.1', '[::1]', '::1', 'localhost'].includes(
				url.hostname.toLowerCase()
			) ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			throw new Error(
				'PLATFORM_INTERNAL_BASE_URL must be an exact loopback HTTP origin'
			);
		}
		return url.toString().replace(/\/$/, '');
	}

	private async readBoundedJson(response: Response): Promise<unknown> {
		if (!response.body) throw new Error('EMPTY_RESPONSE_BODY');
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				total += chunk.value.byteLength;
				if (total > MAX_RESPONSE_BYTES) {
					throw new Error('RESPONSE_BODY_TOO_LARGE');
				}
				chunks.push(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
		return JSON.parse(
			Buffer.concat(
				chunks.map(chunk =>
					Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
				),
				total
			).toString('utf8')
		);
	}

	private isOverview(value: unknown): value is PlatformMessagingOverview {
		if (!this.isRecord(value)) return false;
		if (
			!this.hasExactKeys(value, [
				'generatedAt',
				'heartbeats',
				'oldestPendingAt',
				'operational',
				'outbox',
				'schemaVersion'
			]) ||
			value.schemaVersion !== 1 ||
			!this.isFreshIsoDate(value.generatedAt) ||
			(value.oldestPendingAt !== null &&
				!this.isIsoDate(value.oldestPendingAt)) ||
			!this.isRecord(value.outbox) ||
			!this.hasExactKeys(value.outbox, [
				'PENDING',
				'PROCESSING',
				'PUBLISHED'
			]) ||
			!this.isCount(value.outbox.PENDING) ||
			!this.isCount(value.outbox.PROCESSING) ||
			!this.isCount(value.outbox.PUBLISHED) ||
			!this.isRecord(value.operational) ||
			!this.hasExactKeys(value.operational, [
				'dueOutbox',
				'staleOutbox'
			]) ||
			!this.isCount(value.operational.dueOutbox) ||
			!this.isCount(value.operational.staleOutbox) ||
			!Array.isArray(value.heartbeats) ||
			value.heartbeats.length !==
				PLATFORM_MESSAGING_HEARTBEAT_SERVICES.length
		) {
			return false;
		}
		const services = new Set<PlatformMessagingHeartbeatService>();
		for (const valueHeartbeat of value.heartbeats) {
			if (
				!this.isRecord(valueHeartbeat) ||
				!this.hasExactKeys(valueHeartbeat, [
					'activeInstances',
					'lastSeenAt',
					'revision',
					'service',
					'status'
				]) ||
				!PLATFORM_MESSAGING_HEARTBEAT_SERVICES.includes(
					valueHeartbeat.service as PlatformMessagingHeartbeatService
				) ||
				(valueHeartbeat.status !== 'ok' &&
					valueHeartbeat.status !== 'down') ||
				!this.isCount(valueHeartbeat.activeInstances)
			) {
				return false;
			}
			const service =
				valueHeartbeat.service as PlatformMessagingHeartbeatService;
			if (services.has(service)) return false;
			services.add(service);
			if (valueHeartbeat.status === 'ok') {
				if (
					valueHeartbeat.activeInstances !== 1 ||
					!this.isIsoDate(valueHeartbeat.lastSeenAt) ||
					typeof valueHeartbeat.revision !== 'string' ||
					valueHeartbeat.revision.length < 1 ||
					valueHeartbeat.revision.length > 128
				) {
					return false;
				}
			} else if (
				valueHeartbeat.activeInstances !== 0 ||
				valueHeartbeat.lastSeenAt !== null ||
				valueHeartbeat.revision !== null
			) {
				return false;
			}
		}
		return PLATFORM_MESSAGING_HEARTBEAT_SERVICES.every(service =>
			services.has(service)
		);
	}

	private isFreshIsoDate(value: unknown): value is string {
		if (!this.isIsoDate(value)) return false;
		const timestamp = Date.parse(value);
		const now = Date.now();
		return (
			timestamp >= now - MAX_OVERVIEW_AGE_MS &&
			timestamp <= now + MAX_FUTURE_SKEW_MS
		);
	}

	private isIsoDate(value: unknown): value is string {
		if (typeof value !== 'string') return false;
		const timestamp = Date.parse(value);
		return (
			Number.isFinite(timestamp) &&
			new Date(timestamp).toISOString() === value
		);
	}

	private isCount(value: unknown): value is number {
		return Number.isSafeInteger(value) && Number(value) >= 0;
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return (
			Boolean(value) && typeof value === 'object' && !Array.isArray(value)
		);
	}

	private hasExactKeys(
		value: Record<string, unknown>,
		expected: readonly string[]
	): boolean {
		const keys = Object.keys(value).sort();
		const sortedExpected = [...expected].sort();
		return (
			keys.length === sortedExpected.length &&
			keys.every((key, index) => key === sortedExpected[index])
		);
	}
}
