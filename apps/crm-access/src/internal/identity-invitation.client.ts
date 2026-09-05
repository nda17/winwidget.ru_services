import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CrmInvitationIntent } from '@prisma/crm-access-client';
import {
	hasExactKeys,
	isRecord,
	isUuidV4,
	parseInternalBaseUrl,
	parseInternalTimeout,
	parseInternalToken,
	readBoundedJson
} from './internal-http.config';

export class InvitationRejectedError extends Error {
	constructor(readonly code: 'INVITATION_UNAVAILABLE') {
		super(code);
	}
}
export interface IdentityInvitationAcceptance {
	id: string;
	invitationId: string;
	invitationVersion: number;
	workspaceId: string;
	productCode: 'WINCRM';
	subject: string;
	membershipId: string;
	acceptedAt: string;
	emailVerifiedAt: string;
}
export interface IdentityDirectoryEntry {
	membershipId: string;
	subject: string;
	displayName: string | null;
	verifiedEmail: string | null;
}
const date = (value: unknown): value is string =>
	typeof value === 'string' &&
	Number.isFinite(Date.parse(value)) &&
	new Date(value).toISOString() === value;
const version = (value: unknown) =>
	Number.isSafeInteger(value) &&
	Number(value) > 0 &&
	Number(value) <= 2147483647;

@Injectable()
export class IdentityInvitationClient {
	private readonly origin: string;
	private readonly token: string;
	private readonly timeout: number;
	constructor(config: ConfigService) {
		this.origin = parseInternalBaseUrl(
			'IDENTITY_INTERNAL_BASE_URL',
			config.get<string>('IDENTITY_INTERNAL_BASE_URL'),
			'http://127.0.0.1:4900'
		);
		this.token = parseInternalToken(
			'IDENTITY_CRM_ACCESS_TOKEN',
			config.get<string>('IDENTITY_CRM_ACCESS_TOKEN'),
			[
				'identity_crm_access_token',
				'ci_identity_crm_access_token_at_least_32_chars'
			]
		);
		this.timeout = parseInternalTimeout(
			'IDENTITY_INTERNAL_TIMEOUT_MS',
			config.get<string>('IDENTITY_INTERNAL_TIMEOUT_MS')
		);
	}
	async create(intent: CrmInvitationIntent) {
		const response = await this.post(
			'',
			{
				schemaVersion: 1,
				commandId: intent.provisioningCommandId,
				invitationId: intent.id,
				workspaceId: intent.workspaceId,
				inviterSubject: intent.inviterSubject,
				email: intent.email,
				expiresAt: intent.expiresAt.toISOString()
			},
			intent.provisioningCommandId
		);
		return this.invitation(response, intent);
	}
	async directory(
		workspaceId: string,
		members: { membershipId: string; subject: string }[]
	): Promise<IdentityDirectoryEntry[]> {
		if (members.length === 0) return [];
		if (members.length > 100)
			throw new ServiceUnavailableException(
				'Identity directory request is invalid'
			);
		const response = await this.post(
			`/workspaces/${workspaceId}/member-directory`,
			{
				schemaVersion: 1,
				membershipIds: members.map(member => member.membershipId)
			},
			undefined,
			true
		);
		if (
			!isRecord(response) ||
			!hasExactKeys(response, ['schemaVersion', 'workspaceId', 'items']) ||
			response.schemaVersion !== 1 ||
			response.workspaceId !== workspaceId ||
			!Array.isArray(response.items) ||
			response.items.length !== members.length
		)
			throw new ServiceUnavailableException(
				'Identity directory contract is invalid'
			);
		const expected = new Map(
			members.map(member => [member.membershipId, member.subject])
		);
		for (const item of response.items) {
			if (
				!isRecord(item) ||
				!hasExactKeys(item, [
					'membershipId',
					'subject',
					'displayName',
					'verifiedEmail'
				]) ||
				!isUuidV4(item.membershipId) ||
				!expected.has(item.membershipId) ||
				expected.get(item.membershipId) !== item.subject ||
				!(
					item.displayName === null ||
					(typeof item.displayName === 'string' &&
						item.displayName.length <= 1000)
				) ||
				!(
					item.verifiedEmail === null ||
					(typeof item.verifiedEmail === 'string' &&
						item.verifiedEmail.length <= 254 &&
						item.verifiedEmail ===
							item.verifiedEmail.trim().toLowerCase() &&
						/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.verifiedEmail))
				)
			)
				throw new ServiceUnavailableException(
					'Identity directory contract is invalid'
				);
			expected.delete(item.membershipId);
		}
		return response.items as IdentityDirectoryEntry[];
	}
	async revoke(intent: CrmInvitationIntent) {
		if (!intent.revokeCommandId)
			throw new Error('INVITATION_REVOKE_COMMAND_MISSING');
		const response = await this.post(
			`/${intent.id}/revoke`,
			{
				schemaVersion: 1,
				commandId: intent.revokeCommandId,
				workspaceId: intent.workspaceId
			},
			intent.revokeCommandId
		);
		const result = this.invitation(response, intent);
		if (result.status !== 'REVOKED')
			throw new ServiceUnavailableException(
				'Identity invitation acknowledgment is invalid'
			);
		return result;
	}
	async acceptance(
		invitationId: string,
		workspaceId: string
	): Promise<IdentityInvitationAcceptance> {
		const result = await this.post(`/${invitationId}/acceptance-context`, {
			schemaVersion: 1,
			workspaceId
		});
		if (
			!isRecord(result) ||
			!hasExactKeys(result, ['schemaVersion', 'acceptance']) ||
			result.schemaVersion !== 1 ||
			!isRecord(result.acceptance)
		)
			throw new ServiceUnavailableException(
				'Identity acceptance contract is invalid'
			);
		const value = result.acceptance;
		if (
			!hasExactKeys(value, [
				'id',
				'invitationId',
				'invitationVersion',
				'workspaceId',
				'productCode',
				'subject',
				'membershipId',
				'acceptedAt',
				'emailVerifiedAt'
			]) ||
			!isUuidV4(value.id) ||
			value.invitationId !== invitationId ||
			value.workspaceId !== workspaceId ||
			value.productCode !== 'WINCRM' ||
			!isUuidV4(value.membershipId) ||
			!version(value.invitationVersion) ||
			typeof value.subject !== 'string' ||
			!/^[^\s\x00-\x1f\x7f]{1,256}$/.test(value.subject) ||
			!date(value.acceptedAt) ||
			!date(value.emailVerifiedAt)
		)
			throw new ServiceUnavailableException(
				'Identity acceptance contract is invalid'
			);
		return value as unknown as IdentityInvitationAcceptance;
	}
	private invitation(response: unknown, intent: CrmInvitationIntent) {
		if (
			!isRecord(response) ||
			!hasExactKeys(response, ['schemaVersion', 'invitation']) ||
			response.schemaVersion !== 1 ||
			!isRecord(response.invitation)
		)
			throw new ServiceUnavailableException(
				'Identity invitation contract is invalid'
			);
		const value = response.invitation;
		if (
			!hasExactKeys(value, [
				'id',
				'workspaceId',
				'productCode',
				'version',
				'status',
				'expiresAt',
				'acceptedAt'
			]) ||
			value.id !== intent.id ||
			value.workspaceId !== intent.workspaceId ||
			value.productCode !== 'WINCRM' ||
			!version(value.version) ||
			!['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'].includes(
				String(value.status)
			) ||
			value.expiresAt !== intent.expiresAt.toISOString() ||
			!(value.acceptedAt === null || date(value.acceptedAt))
		)
			throw new ServiceUnavailableException(
				'Identity invitation contract is invalid'
			);
		return value as {
			id: string;
			workspaceId: string;
			productCode: 'WINCRM';
			version: number;
			status: string;
			expiresAt: string;
			acceptedAt: string | null;
		};
	}
	private async post(
		path: string,
		body: unknown,
		commandId?: string,
		directory = false
	): Promise<unknown> {
		let response: Response;
		try {
			response = await fetch(
				`${this.origin}/internal/v1/crm-access${directory ? '' : '/invitations'}${path}`,
				{
					method: 'POST',
					redirect: 'error',
					cache: 'no-store',
					signal: AbortSignal.timeout(this.timeout),
					headers: {
						'x-winwidget-service': 'crm-access',
						'x-winwidget-internal-token': this.token,
						'content-type': 'application/json',
						accept: 'application/json',
						...(commandId ? { 'Idempotency-Key': commandId } : {})
					},
					body: JSON.stringify(body)
				}
			);
		} catch {
			throw new ServiceUnavailableException(
				'Identity invitation service is unavailable'
			);
		}
		if (
			(!directory && response.status === 404) ||
			(response.status === 409 && path.endsWith('/acceptance-context'))
		)
			throw new InvitationRejectedError('INVITATION_UNAVAILABLE');
		if (!response.ok)
			throw new ServiceUnavailableException(
				'Identity invitation service is unavailable'
			);
		try {
			return await readBoundedJson(response);
		} catch {
			throw new ServiceUnavailableException(
				'Identity invitation contract is invalid'
			);
		}
	}
}
