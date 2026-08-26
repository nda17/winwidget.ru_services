import {
	ServiceUnavailableException,
	UnauthorizedException,
	Injectable
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CampaignDeliveryChannel } from '@prisma/campaigns-client';
import { CampaignsRuntimeService } from '../runtime/campaigns-runtime.service';

const DEFAULT_IDENTITY_BASE_URL = 'http://127.0.0.1:4900';
const DEFAULT_BILLING_BASE_URL = 'http://127.0.0.1:4800';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_AUDIENCE_EXPORT_TIMEOUT_MS = 5 * 60 * 1000;
const PLACEHOLDER_INTERNAL_TOKENS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'identity_campaigns_token',
	'ci_identity_campaigns_token_at_least_32_chars',
	'billing_campaigns_token',
	'ci_billing_campaigns_token_at_least_32_chars',
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
}

@Injectable()
export class CampaignsDependenciesClient {
	private readonly identityBaseUrl: string;
	private readonly identityToken: string;
	private readonly billingBaseUrl: string;
	private readonly billingToken: string;
	private readonly timeoutMs: number;
	private readonly audienceExportTimeoutMs: number;

	constructor(config: ConfigService, runtime: CampaignsRuntimeService) {
		this.identityBaseUrl = this.parseBaseUrl(
			config.get<string>('IDENTITY_INTERNAL_BASE_URL'),
			'IDENTITY_INTERNAL_BASE_URL'
		);
		this.identityToken =
			config.get<string>('IDENTITY_CAMPAIGNS_TOKEN')?.trim() || '';
		this.billingBaseUrl = this.parseBaseUrl(
			config.get<string>('BILLING_INTERNAL_BASE_URL'),
			'BILLING_INTERNAL_BASE_URL',
			DEFAULT_BILLING_BASE_URL
		);
		this.billingToken =
			config.get<string>('BILLING_CAMPAIGNS_TOKEN')?.trim() || '';
		if (
			(runtime.apiEnabled || runtime.workerEnabled) &&
			(this.identityToken.length < 32 ||
				PLACEHOLDER_INTERNAL_TOKENS.has(this.identityToken))
		) {
			throw new Error(
				'IDENTITY_CAMPAIGNS_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		if (
			runtime.workerEnabled &&
			(this.billingToken.length < 32 ||
				PLACEHOLDER_INTERNAL_TOKENS.has(this.billingToken))
		) {
			throw new Error(
				'BILLING_CAMPAIGNS_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		const configuredTimeout = Number(
			config.get<string>('IDENTITY_INTERNAL_TIMEOUT_MS') ||
				DEFAULT_TIMEOUT_MS
		);
		if (
			!Number.isInteger(configuredTimeout) ||
			configuredTimeout < 500 ||
			configuredTimeout > 60_000
		) {
			throw new Error(
				'IDENTITY_INTERNAL_TIMEOUT_MS must be an integer between 500 and 60000'
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
				`${this.identityBaseUrl}/internal/v1/auth/introspect`,
				{
					method: 'POST',
					headers: {
						authorization,
						'x-winwidget-service': 'campaigns',
						'x-winwidget-internal-token': this.identityToken,
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

		if (response.status === 401) {
			throw new UnauthorizedException('Authentication is no longer valid');
		}
		if (response.status === 403) {
			throw new ServiceUnavailableException(
				'Authorization service rejected its Campaigns credential'
			);
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
		abortSignal?: AbortSignal
	): Promise<Response> {
		const request: AudienceExportRequest = {
			schemaVersion: 1,
			channel
		};

		try {
			const response = await fetch(
				`${this.identityBaseUrl}/internal/v1/campaigns/eligible-contacts`,
				{
					method: 'POST',
					headers: {
						'x-winwidget-service': 'campaigns',
						'x-winwidget-internal-token': this.identityToken,
						accept: 'application/x-ndjson',
						'content-type': 'application/json'
					},
					body: JSON.stringify(request),
					signal: this.requestSignal(abortSignal)
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

	async exportActiveSubscriberIds(
		abortSignal?: AbortSignal
	): Promise<Response> {
		try {
			const response = await fetch(
				`${this.billingBaseUrl}/internal/v1/billing/campaigns/active-subscriber-ids`,
				{
					method: 'POST',
					headers: {
						'x-winwidget-service': 'campaigns',
						'x-winwidget-internal-token': this.billingToken,
						accept: 'application/x-ndjson'
					},
					signal: this.requestSignal(abortSignal)
				}
			);
			if (!response.ok) {
				throw new Error(
					`Billing audience service responded with HTTP ${response.status}`
				);
			}
			if (
				!response.headers
					.get('content-type')
					?.toLowerCase()
					.includes('application/x-ndjson') ||
				!response.body
			) {
				throw new Error(
					'Billing audience service returned an invalid response'
				);
			}
			return response;
		} catch (error) {
			throw new Error(
				`Active subscriber export is unavailable: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	private requestSignal(abortSignal?: AbortSignal): AbortSignal {
		const timeout = AbortSignal.timeout(this.audienceExportTimeoutMs);
		return abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
	}

	private parseBaseUrl(
		value: string | undefined,
		name: string,
		fallback = DEFAULT_IDENTITY_BASE_URL
	): string {
		const configured = value?.trim() || fallback;
		let url: URL;
		try {
			url = new URL(configured);
		} catch {
			throw new Error(`${name} must be a valid URL`);
		}
		if (url.protocol !== 'http:') {
			throw new Error(`${name} must use http on the private network`);
		}
		if (url.username || url.password || url.search || url.hash) {
			throw new Error(
				`${name} must not contain credentials, query, or fragment`
			);
		}
		if (
			!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(
				url.hostname.toLowerCase()
			)
		) {
			throw new Error(`${name} must use a loopback host`);
		}
		if (url.pathname !== '/' || url.search || url.hash) {
			throw new Error(`${name} must be an origin without a path`);
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
