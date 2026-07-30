import {
	ServiceUnavailableException,
	UnauthorizedException,
	Injectable
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
	CampaignAudience,
	CampaignDeliveryChannel
} from '@prisma/campaigns-client';
import { CampaignsRuntimeService } from '../runtime/campaigns-runtime.service';

const DEFAULT_INTERNAL_BASE_URL = 'http://127.0.0.1:4200';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_AUDIENCE_EXPORT_TIMEOUT_MS = 5 * 60 * 1000;
const PLACEHOLDER_INTERNAL_TOKENS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'campaigns_internal_token',
	'ci_campaigns_internal_token_at_least_32_chars'
]);

export interface IntrospectedActor {
	active: true;
	subject: string;
	sessionId: string;
	roles: Array<'ADMIN' | 'DEV' | 'USER'>;
}

export interface AudienceExportRequest {
	schemaVersion: 1;
	channel: CampaignDeliveryChannel;
	audience: 'ALL' | 'ACTIVE_SUBSCRIBERS';
}

@Injectable()
export class CoreInternalClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly timeoutMs: number;
	private readonly audienceExportTimeoutMs: number;

	constructor(config: ConfigService, runtime: CampaignsRuntimeService) {
		this.baseUrl = this.parseBaseUrl(
			config.get<string>('CAMPAIGNS_CORE_INTERNAL_BASE_URL')
		);
		this.token =
			config.get<string>('CAMPAIGNS_INTERNAL_TOKEN')?.trim() || '';
		if (
			(runtime.apiEnabled || runtime.workerEnabled) &&
			(this.token.length < 32 ||
				PLACEHOLDER_INTERNAL_TOKENS.has(this.token))
		) {
			throw new Error(
				'CAMPAIGNS_INTERNAL_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		const configuredTimeout = Number(
			config.get<string>('CAMPAIGNS_INTERNAL_TIMEOUT_MS') ||
				DEFAULT_TIMEOUT_MS
		);
		if (
			!Number.isInteger(configuredTimeout) ||
			configuredTimeout < 500 ||
			configuredTimeout > 60_000
		) {
			throw new Error(
				'CAMPAIGNS_INTERNAL_TIMEOUT_MS must be an integer between 500 and 60000'
			);
		}
		this.timeoutMs = configuredTimeout;
		const configuredAudienceTimeout = Number(
			config.get<string>('CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS') ||
				DEFAULT_AUDIENCE_EXPORT_TIMEOUT_MS
		);
		if (
			!Number.isInteger(configuredAudienceTimeout) ||
			configuredAudienceTimeout < 30_000 ||
			configuredAudienceTimeout > 15 * 60 * 1000
		) {
			throw new Error(
				'CAMPAIGNS_AUDIENCE_EXPORT_TIMEOUT_MS must be an integer between 30000 and 900000'
			);
		}
		this.audienceExportTimeoutMs = configuredAudienceTimeout;
	}

	async introspect(authorization: string): Promise<IntrospectedActor> {
		let response: Response;
		try {
			response = await fetch(
				`${this.baseUrl}/internal/v1/auth/introspect`,
				{
					method: 'POST',
					headers: {
						authorization,
						'x-winwidget-internal-token': this.token,
						accept: 'application/json'
					},
					signal: AbortSignal.timeout(this.timeoutMs)
				}
			);
		} catch {
			throw new ServiceUnavailableException(
				'Authorization service is unavailable'
			);
		}

		if (response.status === 401 || response.status === 403) {
			throw new UnauthorizedException('Authentication is no longer valid');
		}
		if (!response.ok) {
			throw new ServiceUnavailableException(
				'Authorization service is unavailable'
			);
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		if (!this.isIntrospectedActor(payload)) {
			throw new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		return payload;
	}

	async exportAudience(
		channel: CampaignDeliveryChannel,
		audience: CampaignAudience
	): Promise<Response> {
		const request: AudienceExportRequest = {
			schemaVersion: 1,
			channel,
			audience:
				audience === 'ACTIVE_SUBSCRIPTION' ? 'ACTIVE_SUBSCRIBERS' : 'ALL'
		};

		try {
			const response = await fetch(
				`${this.baseUrl}/internal/v1/campaigns/audience-export`,
				{
					method: 'POST',
					headers: {
						'x-winwidget-internal-token': this.token,
						accept: 'application/x-ndjson',
						'content-type': 'application/json'
					},
					body: JSON.stringify(request),
					signal: AbortSignal.timeout(this.audienceExportTimeoutMs)
				}
			);
			if (!response.ok) {
				throw new Error(
					`Audience service responded with HTTP ${response.status}`
				);
			}
			if (
				!response.headers
					.get('content-type')
					?.toLowerCase()
					.includes('application/x-ndjson')
			) {
				throw new Error(
					'Audience service returned an invalid content type'
				);
			}
			if (!response.body) {
				throw new Error('Audience service returned an empty body');
			}
			return response;
		} catch (error) {
			throw new Error(
				`Audience export is unavailable: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	private parseBaseUrl(value: string | undefined): string {
		const configured = value?.trim() || DEFAULT_INTERNAL_BASE_URL;
		let url: URL;
		try {
			url = new URL(configured);
		} catch {
			throw new Error(
				'CAMPAIGNS_CORE_INTERNAL_BASE_URL must be a valid URL'
			);
		}
		if (url.protocol !== 'http:') {
			throw new Error(
				'CAMPAIGNS_CORE_INTERNAL_BASE_URL must use http on the private network'
			);
		}
		if (url.username || url.password || url.search || url.hash) {
			throw new Error(
				'CAMPAIGNS_CORE_INTERNAL_BASE_URL must not contain credentials, query, or fragment'
			);
		}
		if (
			!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(
				url.hostname.toLowerCase()
			)
		) {
			throw new Error(
				'CAMPAIGNS_CORE_INTERNAL_BASE_URL must use a loopback host'
			);
		}
		if (url.pathname !== '/' || url.search || url.hash) {
			throw new Error(
				'CAMPAIGNS_CORE_INTERNAL_BASE_URL must be an origin without a path'
			);
		}
		return url.toString().replace(/\/$/, '');
	}

	private isIntrospectedActor(value: unknown): value is IntrospectedActor {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return false;
		}
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		if (
			keys.length !== 4 ||
			keys.some(
				(key, index) =>
					key !== ['active', 'roles', 'sessionId', 'subject'][index]
			)
		) {
			return false;
		}
		if (
			record.active !== true ||
			typeof record.subject !== 'string' ||
			!record.subject.trim() ||
			typeof record.sessionId !== 'string' ||
			!record.sessionId.trim() ||
			!Array.isArray(record.roles)
		) {
			return false;
		}
		return record.roles.every(role =>
			['ADMIN', 'DEV', 'USER'].includes(String(role))
		);
	}
}
