import {
	Injectable,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	hasExactKeys,
	isRecord,
	isUuidV4,
	parseInternalBaseUrl,
	parseInternalTimeout,
	parseInternalToken,
	readBoundedJson
} from './internal-http.config';

export type CrmWorkspaceRole = 'OWNER' | 'MEMBER';

export interface CrmWorkspaceMembership {
	membershipId: string;
	workspaceId: string;
	role: CrmWorkspaceRole;
}

export interface CrmIdentityAuthContext {
	schemaVersion: 1;
	subject: string;
	sessionId: string;
	memberships: CrmWorkspaceMembership[];
}

export interface CrmIdentitySourceContext {
	schemaVersion: 1;
	workspaceId: string;
	subject: string;
	membership: CrmWorkspaceMembership | null;
}

const IDENTITY_TOKEN_PLACEHOLDERS = [
	'identity_crm_access_token',
	'ci_identity_crm_access_token_at_least_32_chars'
];

@Injectable()
export class IdentityAuthContextClient {
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly token: string;

	constructor(config: ConfigService) {
		this.baseUrl = parseInternalBaseUrl(
			'IDENTITY_INTERNAL_BASE_URL',
			config.get<string>('IDENTITY_INTERNAL_BASE_URL'),
			'http://127.0.0.1:4900'
		);
		this.timeoutMs = parseInternalTimeout(
			'IDENTITY_INTERNAL_TIMEOUT_MS',
			config.get<string>('IDENTITY_INTERNAL_TIMEOUT_MS')
		);
		this.token = parseInternalToken(
			'IDENTITY_CRM_ACCESS_TOKEN',
			config.get<string>('IDENTITY_CRM_ACCESS_TOKEN'),
			IDENTITY_TOKEN_PLACEHOLDERS
		);
	}

	async authContext(
		authorization: string | undefined,
		correlationId: string
	): Promise<CrmIdentityAuthContext> {
		if (
			!authorization ||
			!/^Bearer [^\s,]{1,16384}$/.test(authorization)
		) {
			throw new UnauthorizedException('Invalid access token');
		}

		let response: Response;
		try {
			response = await fetch(
				`${this.baseUrl}/internal/v1/crm-access/auth-context`,
				{
					method: 'POST',
					redirect: 'error',
					headers: {
						authorization,
						'x-winwidget-service': 'crm-access',
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
		if (!response.ok) {
			throw new ServiceUnavailableException(
				'Authorization service is unavailable'
			);
		}

		let value: unknown;
		try {
			value = await readBoundedJson(response);
		} catch {
			throw new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		if (!this.isAuthContext(value)) {
			throw new ServiceUnavailableException(
				'Authorization service returned an invalid response'
			);
		}
		return value;
	}

	async sourceContext(
		workspaceId: string,
		subject: string,
		correlationId: string
	): Promise<CrmIdentitySourceContext> {
		try {
			const response = await fetch(
				`${this.baseUrl}/internal/v1/crm-access/source-context`,
				{
					method: 'POST',
					redirect: 'error',
					headers: {
						'x-winwidget-service': 'crm-access',
						'x-winwidget-internal-token': this.token,
						'x-correlation-id': correlationId,
						'content-type': 'application/json',
						accept: 'application/json'
					},
					body: JSON.stringify({ schemaVersion: 1, workspaceId, subject }),
					signal: AbortSignal.timeout(this.timeoutMs)
				}
			);
			if (response.status !== 200) {
				await response.body?.cancel();
				throw new Error('SOURCE_CONTEXT_RESPONSE');
			}
			const value = await readBoundedJson(response);
			if (
				!isRecord(value) ||
				!hasExactKeys(value, [
					'schemaVersion',
					'workspaceId',
					'subject',
					'membership'
				]) ||
				value.schemaVersion !== 1 ||
				value.workspaceId !== workspaceId ||
				value.subject !== subject
			)
				throw new Error('SOURCE_CONTEXT_CONTRACT');
			const membership = value.membership;
			if (
				membership !== null &&
				(!isRecord(membership) ||
					!hasExactKeys(membership, [
						'membershipId',
						'workspaceId',
						'role'
					]) ||
					!isUuidV4(membership.membershipId) ||
					membership.workspaceId !== workspaceId ||
					(membership.role !== 'OWNER' && membership.role !== 'MEMBER'))
			)
				throw new Error('SOURCE_CONTEXT_MEMBERSHIP');
			return value as unknown as CrmIdentitySourceContext;
		} catch {
			throw new ServiceUnavailableException(
				'Source authorization service is unavailable'
			);
		}
	}

	private isAuthContext(value: unknown): value is CrmIdentityAuthContext {
		if (!isRecord(value)) return false;
		if (
			!hasExactKeys(value, [
				'memberships',
				'schemaVersion',
				'sessionId',
				'subject'
			]) ||
			value.schemaVersion !== 1 ||
			typeof value.subject !== 'string' ||
			!value.subject.trim() ||
			value.subject !== value.subject.trim() ||
			value.subject.length > 256 ||
			!isUuidV4(value.sessionId) ||
			!Array.isArray(value.memberships) ||
			value.memberships.length > 1000
		) {
			return false;
		}

		const membershipIds = new Set<string>();
		const workspaceIds = new Set<string>();
		for (const membership of value.memberships) {
			if (
				!isRecord(membership) ||
				!hasExactKeys(membership, [
					'membershipId',
					'role',
					'workspaceId'
				]) ||
				!isUuidV4(membership.membershipId) ||
				!isUuidV4(membership.workspaceId) ||
				!['OWNER', 'MEMBER'].includes(String(membership.role)) ||
				membershipIds.has(membership.membershipId) ||
				workspaceIds.has(membership.workspaceId)
			) {
				return false;
			}
			membershipIds.add(membership.membershipId);
			workspaceIds.add(membership.workspaceId);
		}
		return true;
	}
}
