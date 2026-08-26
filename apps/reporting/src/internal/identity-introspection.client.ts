import type { ReportingActor } from '../auth/reporting-request';
import { createReportingCorrelationId } from '../common/reporting-context';
import { ReportingRuntimeService } from '../runtime/reporting-runtime.service';
import {
	Injectable,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_IDENTITY_BASE_URL = 'http://127.0.0.1:4900';
const DEFAULT_TIMEOUT_MS = 10_000;
const PLACEHOLDER_IDENTITY_TOKENS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'identity_reporting_token',
	'ci_identity_reporting_token_at_least_32_chars',
	'change_me_to_a_unique_identity_secret_with_at_least_32_chars'
]);

@Injectable()
export class IdentityIntrospectionClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly timeoutMs: number;

	constructor(config: ConfigService, runtime: ReportingRuntimeService) {
		this.baseUrl = this.parseBaseUrl(
			config.get<string>('IDENTITY_INTERNAL_BASE_URL')
		);
		this.token =
			config.get<string>('IDENTITY_REPORTING_TOKEN')?.trim() || '';
		if (
			runtime.apiEnabled &&
			(this.token.length < 32 ||
				PLACEHOLDER_IDENTITY_TOKENS.has(this.token))
		) {
			throw new Error(
				'IDENTITY_REPORTING_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		const timeout = Number(
			config.get<string>('IDENTITY_INTERNAL_TIMEOUT_MS') ||
				DEFAULT_TIMEOUT_MS
		);
		if (!Number.isInteger(timeout) || timeout < 500 || timeout > 60_000) {
			throw new Error(
				'IDENTITY_INTERNAL_TIMEOUT_MS must be an integer between 500 and 60000'
			);
		}
		this.timeoutMs = timeout;
	}

	async introspect(
		authorization: string,
		correlationId = createReportingCorrelationId()
	): Promise<ReportingActor> {
		let response: Response;
		try {
			response = await fetch(
				`${this.baseUrl}/internal/v1/auth/introspect`,
				{
					method: 'POST',
					headers: {
						authorization,
						'x-winwidget-service': 'reporting',
						'x-winwidget-internal-token': this.token,
						'x-correlation-id': correlationId,
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
				'Authorization service rejected its Reporting credential'
			);
		}
		if (!response.ok) {
			throw new ServiceUnavailableException(
				'Authorization service is unavailable'
			);
		}
		let value: unknown;
		try {
			value = await response.json();
		} catch {
			throw new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		if (!this.isReportingActor(value)) {
			throw new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		return value;
	}

	private parseBaseUrl(value: string | undefined): string {
		const configured = value?.trim() || DEFAULT_IDENTITY_BASE_URL;
		let url: URL;
		try {
			url = new URL(configured);
		} catch {
			throw new Error('IDENTITY_INTERNAL_BASE_URL must be a valid URL');
		}
		if (url.protocol !== 'http:') {
			throw new Error(
				'IDENTITY_INTERNAL_BASE_URL must use http on the private network'
			);
		}
		if (url.username || url.password || url.search || url.hash) {
			throw new Error(
				'IDENTITY_INTERNAL_BASE_URL must not contain credentials, query, or fragment'
			);
		}
		if (
			!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(
				url.hostname.toLowerCase()
			)
		) {
			throw new Error(
				'IDENTITY_INTERNAL_BASE_URL must use a loopback host'
			);
		}
		if (url.pathname !== '/') {
			throw new Error(
				'IDENTITY_INTERNAL_BASE_URL must be an origin without a path'
			);
		}
		return url.toString().replace(/\/$/, '');
	}

	private isReportingActor(value: unknown): value is ReportingActor {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return false;
		}
		const record = value as Record<string, unknown>;
		const actualKeys = Object.keys(record).sort();
		const expectedKeys = ['active', 'roles', 'sessionId', 'subject'];
		if (
			actualKeys.length !== expectedKeys.length ||
			actualKeys.some((key, index) => key !== expectedKeys[index])
		) {
			return false;
		}
		return (
			record.active === true &&
			typeof record.subject === 'string' &&
			Boolean(record.subject.trim()) &&
			record.subject.length <= 255 &&
			typeof record.sessionId === 'string' &&
			Boolean(record.sessionId.trim()) &&
			record.sessionId.length <= 255 &&
			Array.isArray(record.roles) &&
			record.roles.every(role =>
				['ADMIN', 'DEV', 'USER'].includes(String(role))
			)
		);
	}
}
