import {
	HttpException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BillingActor } from '../auth/billing-request';
import { BillingRuntimeService } from '../runtime/billing-runtime.service';

const DEFAULT_BASE_URL = 'http://127.0.0.1:4200';
const DEFAULT_TIMEOUT_MS = 10_000;
const PLACEHOLDER_TOKENS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'billing_internal_token'
]);

@Injectable()
export class CoreInternalClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly timeoutMs: number;

	constructor(config: ConfigService, runtime: BillingRuntimeService) {
		this.baseUrl = this.parseBaseUrl(
			config.get<string>('BILLING_CORE_INTERNAL_BASE_URL')
		);
		this.token =
			config.get<string>('BILLING_INTERNAL_TOKEN')?.trim() || '';
		if (
			(runtime.apiEnabled || runtime.workerEnabled) &&
			(this.token.length < 32 || PLACEHOLDER_TOKENS.has(this.token))
		) {
			throw new Error(
				'BILLING_INTERNAL_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		const timeout = Number(
			config.get<string>('BILLING_INTERNAL_TIMEOUT_MS') ||
				DEFAULT_TIMEOUT_MS
		);
		if (!Number.isInteger(timeout) || timeout < 500 || timeout > 60_000) {
			throw new Error(
				'BILLING_INTERNAL_TIMEOUT_MS must be an integer between 500 and 60000'
			);
		}
		this.timeoutMs = timeout;
	}

	async introspect(authorization: string): Promise<BillingActor> {
		let response: Response;
		try {
			response = await fetch(
				`${this.baseUrl}/api/v1/internal/billing/auth/introspect`,
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
			throw await this.authException(response);
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
		if (!this.isActor(value)) {
			throw new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		return value;
	}

	async completeLifecycle(input: {
		schemaVersion: 1;
		commandId: string;
		userId: string;
		operation: 'DEACTIVATE' | 'DELETE';
		actorId: string;
		actorRole: 'ADMIN' | 'DEV';
		requestedAt: string;
	}): Promise<Record<string, unknown>> {
		let response: Response;
		try {
			response = await fetch(
				`${this.baseUrl}/api/v1/internal/billing/lifecycle/complete`,
				{
					method: 'POST',
					headers: {
						'x-winwidget-internal-token': this.token,
						accept: 'application/json',
						'content-type': 'application/json'
					},
					body: JSON.stringify(input),
					signal: AbortSignal.timeout(this.timeoutMs)
				}
			);
		} catch {
			throw new ServiceUnavailableException(
				'Identity lifecycle completion is unavailable'
			);
		}
		if (!response.ok) {
			throw new ServiceUnavailableException(
				'Identity lifecycle completion is unavailable'
			);
		}
		let value: unknown;
		try {
			value = await response.json();
		} catch {
			throw new ServiceUnavailableException(
				'Identity lifecycle completion returned an invalid response'
			);
		}
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new ServiceUnavailableException(
				'Identity lifecycle completion returned an invalid response'
			);
		}
		const result = value as Record<string, unknown>;
		const keys = Object.keys(result).sort();
		const expectedKeys = [
			'changed',
			'commandId',
			'completed',
			'duplicate',
			'schemaVersion'
		].sort();
		if (
			keys.length !== expectedKeys.length ||
			keys.some((key, index) => key !== expectedKeys[index]) ||
			result.schemaVersion !== 1 ||
			result.commandId !== input.commandId ||
			result.completed !== true ||
			typeof result.duplicate !== 'boolean' ||
			typeof result.changed !== 'boolean'
		) {
			throw new ServiceUnavailableException(
				'Identity lifecycle completion returned an invalid response'
			);
		}
		return result;
	}

	private parseBaseUrl(value: string | undefined): string {
		const configured = value?.trim() || DEFAULT_BASE_URL;
		let url: URL;
		try {
			url = new URL(configured);
		} catch {
			throw new Error(
				'BILLING_CORE_INTERNAL_BASE_URL must be a valid URL'
			);
		}
		if (url.protocol !== 'http:') {
			throw new Error(
				'BILLING_CORE_INTERNAL_BASE_URL must use http on the private network'
			);
		}
		if (
			!['127.0.0.1', '::1', 'localhost'].includes(url.hostname) ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			throw new Error(
				'BILLING_CORE_INTERNAL_BASE_URL must be an exact loopback origin'
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
		const expectedError =
			response.status === 401 ? 'Unauthorized' : 'Forbidden';
		if (
			!exactKeys ||
			payload.statusCode !== response.status ||
			payload.error !== expectedError ||
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
				statusCode: response.status,
				message: payload.message,
				error: expectedError,
				...(payload.code !== undefined ? { code: payload.code } : {})
			},
			response.status
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
				if (total > maxBytes) throw new Error('RESPONSE_BODY_TOO_LARGE');
				chunks.push(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
		const body = Buffer.concat(
			chunks.map(chunk =>
				Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
			),
			total
		).toString('utf8');
		return JSON.parse(body);
	}

	private isActor(value: unknown): value is BillingActor {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			return false;
		const actor = value as Record<string, unknown>;
		const keys = Object.keys(actor).sort();
		const expected = ['active', 'roles', 'sessionId', 'subject'];
		return (
			keys.length === expected.length &&
			keys.every((key, index) => key === expected[index]) &&
			actor.active === true &&
			typeof actor.subject === 'string' &&
			typeof actor.sessionId === 'string' &&
			Array.isArray(actor.roles) &&
			actor.roles.every(role =>
				['USER', 'ADMIN', 'DEV'].includes(String(role))
			)
		);
	}
}
