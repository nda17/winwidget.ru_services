import {
	HttpException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OperationsRuntimeService } from '../runtime/operations-runtime.service';
import type { OperationsActor } from './operations-request';

const DEFAULT_IDENTITY_BASE_URL = 'http://127.0.0.1:4900';
const DEFAULT_TIMEOUT_MS = 10_000;
const PLACEHOLDER_TOKENS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'identity_operations_token',
	'change_me_operations_identity_token_at_least_32_chars',
	'ci_identity_operations_token_at_least_32_chars'
]);

@Injectable()
export class IdentityIntrospectionClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly timeoutMs: number;

	constructor(config: ConfigService, runtime: OperationsRuntimeService) {
		this.baseUrl = this.parseBaseUrl(
			config.get<string>('IDENTITY_INTERNAL_BASE_URL')
		);
		this.token =
			config.get<string>('IDENTITY_OPERATIONS_TOKEN')?.trim() || '';
		if (
			runtime.apiEnabled &&
			(this.token.length < 32 || PLACEHOLDER_TOKENS.has(this.token))
		) {
			throw new Error(
				'IDENTITY_OPERATIONS_TOKEN must be a non-placeholder secret with at least 32 characters'
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

	async introspect(authorization: string): Promise<OperationsActor> {
		let response: Response;
		try {
			response = await fetch(
				`${this.baseUrl}/internal/v1/auth/introspect`,
				{
					method: 'POST',
					headers: {
						authorization,
						'x-winwidget-service': 'operations',
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
		if (response.status === 401) {
			throw await this.authException(response);
		}
		if (response.status === 403) {
			throw new ServiceUnavailableException(
				'Authorization service rejected its Operations credential'
			);
		}
		if (!response.ok) {
			throw new ServiceUnavailableException(
				'Authorization service is unavailable'
			);
		}
		let value: unknown;
		try {
			value = await this.readBoundedJson(response, 16 * 1024);
		} catch {
			throw new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		if (!this.isActor(value)) {
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
				'IDENTITY_INTERNAL_BASE_URL must be an exact loopback http origin'
			);
		}
		return url.toString().replace(/\/$/, '');
	}

	private async authException(response: Response): Promise<HttpException> {
		let value: unknown;
		try {
			value = await this.readBoundedJson(response, 16 * 1024);
		} catch {
			return new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		const payload = value as Record<string, unknown>;
		const keys = Object.keys(payload).sort();
		const withCode = ['code', 'error', 'message', 'statusCode'];
		const withoutCode = ['error', 'message', 'statusCode'];
		const exactKeys =
			(keys.length === withCode.length &&
				keys.every((key, index) => key === withCode[index])) ||
			(keys.length === withoutCode.length &&
				keys.every((key, index) => key === withoutCode[index]));
		if (
			!exactKeys ||
			payload.statusCode !== 401 ||
			payload.error !== 'Unauthorized' ||
			typeof payload.message !== 'string' ||
			!payload.message ||
			payload.message.length > 2_000 ||
			(payload.code !== undefined &&
				(typeof payload.code !== 'string' || payload.code.length > 160))
		) {
			return new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		return new HttpException(
			{
				statusCode: 401,
				message: payload.message,
				error: 'Unauthorized',
				...(payload.code !== undefined ? { code: payload.code } : {})
			},
			401
		);
	}

	private async readBoundedJson(
		response: Response,
		maxBytes: number
	): Promise<unknown> {
		if (!response.body) throw new Error('EMPTY_RESPONSE_BODY');
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				total += chunk.value.byteLength;
				if (total > maxBytes) {
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

	private isActor(value: unknown): value is OperationsActor {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return false;
		}
		const actor = value as Record<string, unknown>;
		const keys = Object.keys(actor).sort();
		const expected = ['active', 'roles', 'sessionId', 'subject'];
		return (
			keys.length === expected.length &&
			keys.every((key, index) => key === expected[index]) &&
			actor.active === true &&
			typeof actor.subject === 'string' &&
			Boolean(actor.subject.trim()) &&
			actor.subject.length <= 255 &&
			typeof actor.sessionId === 'string' &&
			Boolean(actor.sessionId.trim()) &&
			actor.sessionId.length <= 255 &&
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
