import {
	Injectable,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_IDENTITY_INTERNAL_BASE_URL = 'http://127.0.0.1:4900';
const DEFAULT_TIMEOUT_MS = 10_000;
const PLACEHOLDER_TOKENS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'identity_core_token',
	'ci_identity_core_token_at_least_32_chars'
]);

export interface IdentityActor {
	active: true;
	subject: string;
	sessionId: string;
	roles: Array<'USER' | 'ADMIN' | 'DEV'>;
}

export interface IdentityAuditSnapshot {
	id: string;
	name: string | null;
	email: string | null;
}

@Injectable()
export class IdentityInternalClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly timeoutMs: number;

	constructor(config: ConfigService) {
		this.baseUrl = this.parseBaseUrl(
			config.get<string>('IDENTITY_INTERNAL_BASE_URL')
		);
		this.token = config.get<string>('IDENTITY_CORE_TOKEN')?.trim() || '';
		if (this.token.length < 32 || PLACEHOLDER_TOKENS.has(this.token)) {
			throw new Error(
				'IDENTITY_CORE_TOKEN must be a non-placeholder secret with at least 32 characters'
			);
		}
		const timeoutMs = Number(
			config.get<string>('IDENTITY_INTERNAL_TIMEOUT_MS') ||
				DEFAULT_TIMEOUT_MS
		);
		if (
			!Number.isInteger(timeoutMs) ||
			timeoutMs < 500 ||
			timeoutMs > 60_000
		) {
			throw new Error(
				'IDENTITY_INTERNAL_TIMEOUT_MS must be an integer between 500 and 60000'
			);
		}
		this.timeoutMs = timeoutMs;
	}

	async introspect(authorization: string): Promise<IdentityActor> {
		let response: Response;
		try {
			response = await fetch(
				`${this.baseUrl}/internal/v1/auth/introspect`,
				{
					method: 'POST',
					headers: {
						authorization,
						accept: 'application/json',
						'x-winwidget-service': 'core',
						'x-winwidget-internal-token': this.token
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
			throw await this.authenticationException(response);
		}
		if (response.status === 403) {
			throw new ServiceUnavailableException(
				'Authorization service rejected its Core credential'
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
		if (!this.isActor(payload)) {
			throw new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		return payload;
	}

	async getAuditSnapshots(
		userIds: string[]
	): Promise<Map<string, IdentityAuditSnapshot>> {
		if (
			userIds.length === 0 ||
			userIds.length > 100 ||
			new Set(userIds).size !== userIds.length ||
			userIds.some(userId => !userId || userId.length > 255)
		) {
			throw new Error('Identity audit snapshot user IDs are invalid');
		}

		let response: Response;
		try {
			response = await fetch(
				`${this.baseUrl}/internal/v1/core/audit-snapshots`,
				{
					method: 'POST',
					headers: {
						accept: 'application/json',
						'content-type': 'application/json',
						'x-winwidget-service': 'core',
						'x-winwidget-internal-token': this.token
					},
					body: JSON.stringify({ userIds }),
					signal: AbortSignal.timeout(this.timeoutMs)
				}
			);
		} catch {
			throw new ServiceUnavailableException(
				'Identity audit directory is unavailable'
			);
		}
		if (!response.ok) {
			throw new ServiceUnavailableException(
				'Identity audit directory is unavailable'
			);
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new ServiceUnavailableException(
				'Identity audit directory returned an invalid response'
			);
		}
		if (!this.isAuditSnapshotResponse(payload, userIds)) {
			throw new ServiceUnavailableException(
				'Identity audit directory returned an invalid response'
			);
		}
		return new Map(payload.items.map(item => [item.id, item]));
	}

	private async authenticationException(
		response: Response
	): Promise<UnauthorizedException | ServiceUnavailableException> {
		const declaredLength = Number(response.headers.get('content-length'));
		if (Number.isFinite(declaredLength) && declaredLength > 16 * 1024) {
			return new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		let body: string;
		try {
			body = await response.text();
		} catch {
			return new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		if (Buffer.byteLength(body, 'utf8') > 16 * 1024) {
			return new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		let value: unknown;
		try {
			value = JSON.parse(body);
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
		const hasStableCode =
			keys.length === 4 &&
			keys.every(
				(key, index) =>
					key === ['code', 'error', 'message', 'statusCode'][index]
			) &&
			payload.code === 'http_error';
		const hasLegacyEnvelope =
			keys.length === 3 &&
			keys.every(
				(key, index) => key === ['error', 'message', 'statusCode'][index]
			);
		if (
			(!hasStableCode && !hasLegacyEnvelope) ||
			payload.statusCode !== 401 ||
			payload.error !== 'Unauthorized' ||
			typeof payload.message !== 'string'
		) {
			return new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		if (
			payload.message === 'Invalid access token' ||
			payload.message === 'Access token not passed' ||
			payload.message === 'Unauthorized'
		) {
			return new UnauthorizedException();
		}
		if (
			payload.message === 'Invalid session' ||
			payload.message === 'User is deactivated'
		) {
			return new UnauthorizedException(payload.message);
		}
		return new ServiceUnavailableException(
			'Authorization service returned an invalid response'
		);
	}

	private parseBaseUrl(value?: string): string {
		const configured = value?.trim() || DEFAULT_IDENTITY_INTERNAL_BASE_URL;
		let url: URL;
		try {
			url = new URL(configured);
		} catch {
			throw new Error('IDENTITY_INTERNAL_BASE_URL must be a valid URL');
		}
		if (
			url.protocol !== 'http:' ||
			!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(
				url.hostname.toLowerCase()
			) ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		) {
			throw new Error(
				'IDENTITY_INTERNAL_BASE_URL must be an exact private loopback HTTP origin'
			);
		}
		return url.toString().replace(/\/$/, '');
	}

	private isActor(value: unknown): value is IdentityActor {
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
			actor.subject.length > 0 &&
			actor.subject.length <= 256 &&
			typeof actor.sessionId === 'string' &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				actor.sessionId
			) &&
			Array.isArray(actor.roles) &&
			actor.roles.length > 0 &&
			new Set(actor.roles).size === actor.roles.length &&
			actor.roles.every(role =>
				['USER', 'ADMIN', 'DEV'].includes(String(role))
			)
		);
	}

	private isAuditSnapshotResponse(
		value: unknown,
		requestedUserIds: string[]
	): value is { items: IdentityAuditSnapshot[] } {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return false;
		}
		const response = value as Record<string, unknown>;
		if (
			Object.keys(response).length !== 1 ||
			!Array.isArray(response.items) ||
			response.items.length > requestedUserIds.length
		) {
			return false;
		}
		const requestedOrder = new Map(
			requestedUserIds.map((userId, index) => [userId, index])
		);
		let previousIndex = -1;
		const seen = new Set<string>();
		for (const item of response.items) {
			if (!item || typeof item !== 'object' || Array.isArray(item)) {
				return false;
			}
			const snapshot = item as Record<string, unknown>;
			const keys = Object.keys(snapshot).sort();
			if (
				keys.length !== 3 ||
				!keys.every(
					(key, index) => key === ['email', 'id', 'name'][index]
				) ||
				typeof snapshot.id !== 'string' ||
				(typeof snapshot.name !== 'string' && snapshot.name !== null) ||
				(typeof snapshot.email !== 'string' && snapshot.email !== null)
			) {
				return false;
			}
			const index = requestedOrder.get(snapshot.id);
			if (
				index === undefined ||
				index <= previousIndex ||
				seen.has(snapshot.id)
			) {
				return false;
			}
			previousIndex = index;
			seen.add(snapshot.id);
		}
		return true;
	}
}
