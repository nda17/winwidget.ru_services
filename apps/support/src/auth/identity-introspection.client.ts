import {
	HttpException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SupportActor } from './support-request';

@Injectable()
export class IdentityIntrospectionClient {
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly serviceToken: string;

	constructor(config: ConfigService) {
		this.baseUrl = this.parseBaseUrl(
			config.get<string>('IDENTITY_INTERNAL_BASE_URL')
		);
		const timeout = Number(
			config.get<string>('IDENTITY_INTERNAL_TIMEOUT_MS') || 10_000
		);
		if (!Number.isInteger(timeout) || timeout < 500 || timeout > 60_000) {
			throw new Error(
				'IDENTITY_INTERNAL_TIMEOUT_MS must be between 500 and 60000'
			);
		}
		this.timeoutMs = timeout;
		this.serviceToken =
			config.get<string>('IDENTITY_SUPPORT_TOKEN')?.trim() || '';
		if (
			this.serviceToken.length < 32 ||
			this.serviceToken.startsWith('change_me') ||
			this.serviceToken.startsWith('ci_')
		) {
			throw new Error(
				'IDENTITY_SUPPORT_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
	}

	async introspect(authorization: string): Promise<SupportActor> {
		let response: Response;
		try {
			response = await fetch(
				`${this.baseUrl}/internal/v1/auth/introspect`,
				{
					method: 'POST',
					headers: {
						authorization,
						'x-winwidget-service': 'support',
						'x-winwidget-internal-token': this.serviceToken,
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
			throw new HttpException(await this.safeAuthError(response), 401);
		}
		if (!response.ok) {
			throw new ServiceUnavailableException(
				'Authorization service is unavailable'
			);
		}
		const value = await this.readBoundedJson(response);
		if (!this.isActor(value)) {
			throw new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		return value;
	}

	private parseBaseUrl(value: string | undefined): string {
		const url = new URL(value?.trim() || 'http://127.0.0.1:4900');
		if (
			url.protocol !== 'http:' ||
			!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(
				url.hostname.toLowerCase()
			) ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			throw new Error(
				'IDENTITY_INTERNAL_BASE_URL must be an exact loopback HTTP origin'
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
				if (total > 16 * 1024) throw new Error('RESPONSE_BODY_TOO_LARGE');
				chunks.push(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
		return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
	}

	private async safeAuthError(
		response: Response
	): Promise<Record<string, unknown>> {
		try {
			const value = await this.readBoundedJson(response);
			if (
				value &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				(value as Record<string, unknown>).statusCode === 401
			) {
				return value as Record<string, unknown>;
			}
		} catch {
			// Fail closed with a generic shape.
		}
		return {
			statusCode: 401,
			message: 'Unauthorized',
			error: 'Unauthorized'
		};
	}

	private isActor(value: unknown): value is SupportActor {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			return false;
		const actor = value as Record<string, unknown>;
		return (
			actor.active === true &&
			typeof actor.subject === 'string' &&
			Boolean(actor.subject) &&
			typeof actor.sessionId === 'string' &&
			Boolean(actor.sessionId) &&
			Array.isArray(actor.roles) &&
			actor.roles.length <= 3 &&
			new Set(actor.roles).size === actor.roles.length &&
			actor.roles.every(
				role =>
					typeof role === 'string' &&
					['USER', 'ADMIN', 'DEV'].includes(role)
			)
		);
	}
}
