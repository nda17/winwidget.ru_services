import {
	ForbiddenException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exactObject } from './support-web.util';

export interface SupportAuthor {
	schemaVersion: 1;
	subject: string;
	role: 'USER' | 'ADMIN' | 'DEV';
	name: string | null;
	workspace: { id: string; membershipId: string } | null;
}
@Injectable()
export class SupportWebIdentityClient {
	constructor(private readonly config: ConfigService) {}
	async author(
		authorization: string,
		workspaceId?: string
	): Promise<SupportAuthor> {
		const value = await this.request(
			'IDENTITY_INTERNAL_BASE_URL',
			'IDENTITY_SUPPORT_TOKEN',
			'/internal/v1/support/author-context',
			{ schemaVersion: 1, ...(workspaceId ? { workspaceId } : {}) },
			authorization
		);
		if (
			!exactObject(value, [
				'schemaVersion',
				'subject',
				'role',
				'name',
				'workspace'
			]) ||
			value.schemaVersion !== 1 ||
			typeof value.subject !== 'string' ||
			!['USER', 'ADMIN', 'DEV'].includes(String(value.role)) ||
			!(value.name === null || typeof value.name === 'string') ||
			!(
				value.workspace === null ||
				(exactObject(value.workspace, ['id', 'membershipId']) &&
					value.workspace.id === workspaceId &&
					typeof value.workspace.membershipId === 'string')
			) ||
			Boolean(workspaceId) !== Boolean(value.workspace)
		)
			throw new ServiceUnavailableException(
				'Некорректный контекст пользователя'
			);
		return value as unknown as SupportAuthor;
	}
	async company(
		authorization: string,
		workspaceId: string,
		subject: string
	): Promise<string | null> {
		const value = await this.request(
			'SUPPORT_CRM_ACCESS_BASE_URL',
			'SUPPORT_CRM_ACCESS_TOKEN',
			'/internal/v1/support/workspace-context',
			{ schemaVersion: 1, workspaceId },
			authorization
		);
		if (
			!exactObject(value, [
				'schemaVersion',
				'subject',
				'workspaceId',
				'companyName'
			]) ||
			value.schemaVersion !== 1 ||
			value.subject !== subject ||
			value.workspaceId !== workspaceId ||
			!(
				value.companyName === null ||
				(typeof value.companyName === 'string' &&
					value.companyName.length <= 255)
			)
		)
			throw new ServiceUnavailableException(
				'Некорректный контекст компании'
			);
		return value.companyName as string | null;
	}
	async recipient(
		subject: string
	): Promise<{ active: boolean; verifiedEmail: string | null }> {
		const value = await this.request(
			'IDENTITY_INTERNAL_BASE_URL',
			'IDENTITY_SUPPORT_TOKEN',
			'/internal/v1/support/recipient-context',
			{ schemaVersion: 1, subject }
		);
		if (
			!exactObject(value, [
				'schemaVersion',
				'subject',
				'active',
				'verifiedEmail'
			]) ||
			value.schemaVersion !== 1 ||
			value.subject !== subject ||
			typeof value.active !== 'boolean' ||
			!(
				value.verifiedEmail === null ||
				(typeof value.verifiedEmail === 'string' &&
					value.verifiedEmail.length <= 254 &&
					/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.verifiedEmail))
			)
		)
			throw new ServiceUnavailableException(
				'Некорректный контекст получателя'
			);
		return value as unknown as {
			active: boolean;
			verifiedEmail: string | null;
		};
	}
	private async request(
		originKey: string,
		tokenKey: string,
		path: string,
		body: unknown,
		authorization?: string
	): Promise<unknown> {
		try {
			const origin = new URL(
				this.config.get<string>(originKey) ||
					(originKey === 'IDENTITY_INTERNAL_BASE_URL'
						? 'http://127.0.0.1:4900'
						: '')
			);
			const token = this.config.get<string>(tokenKey)?.trim() || '';
			if (
				origin.username ||
				origin.password ||
				origin.search ||
				origin.hash ||
				origin.pathname !== '/' ||
				!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
				origin.protocol !== 'http:' ||
				token.length < 32
			)
				throw new Error('Invalid configuration');
			const response = await fetch(`${origin.origin}${path}`, {
				method: 'POST',
				redirect: 'error',
				signal: AbortSignal.timeout(5000),
				headers: {
					'content-type': 'application/json',
					'x-winwidget-service': 'support',
					'x-winwidget-internal-token': token,
					...(authorization ? { authorization } : {})
				},
				body: JSON.stringify(body)
			});
			if ([401, 403, 404].includes(response.status))
				throw new ForbiddenException(
					'Контекст пользователя или компании недоступен'
				);
			if (!response.ok || !response.body)
				throw new Error('Invalid response');
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let bytes = 0;
			try {
				for (;;) {
					const part = await reader.read();
					if (part.done) break;
					bytes += part.value.byteLength;
					if (bytes > 8192) {
						await reader.cancel();
						throw new Error('Oversize');
					}
					chunks.push(part.value);
				}
			} finally {
				reader.releaseLock();
			}
			return JSON.parse(Buffer.concat(chunks).toString('utf8'));
		} catch (error) {
			if (error instanceof ForbiddenException) throw error;
			throw new ServiceUnavailableException(
				'Сервис проверки пользователя временно недоступен'
			);
		}
	}
}
