import {
	ForbiddenException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import {
	salesAccessToken,
	serviceOrigin,
	UUID,
	type SalesAccess
} from '../sales/sales-access';
import type { TaskAssigneeDto } from './workday.dto';

export interface SalesAssignee extends TaskAssigneeDto {
	role: Exclude<SalesAccess['role'], 'ANALYST'>;
	dataScope: SalesAccess['dataScope'];
	teamIds: string[];
}
function exact(
	value: unknown,
	keys: string[]
): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every(key => key in value)
	);
}

@Injectable()
export class SalesAssigneeClient {
	async authorize(
		authorization: string,
		access: SalesAccess,
		assignee: TaskAssigneeDto,
		teamId?: string
	): Promise<SalesAssignee> {
		if (!/^Bearer [^\s]{1,16384}$/.test(authorization))
			throw new UnauthorizedException();
		const origin = serviceOrigin(process.env.CRM_ACCESS_INTERNAL_BASE_URL);
		const token = salesAccessToken();
		try {
			const response = await fetch(
				`${origin}/internal/v1/crm-access/authorize-assignee`,
				{
					method: 'POST',
					headers: {
						Authorization: authorization,
						'content-type': 'application/json',
						'x-winwidget-service': 'crm-sales',
						'x-winwidget-internal-token': token
					},
					body: JSON.stringify({
						schemaVersion: 1,
						purpose: 'SALES_ASSIGNMENT',
						workspaceId: access.workspaceId,
						subject: assignee.subject,
						membershipId: assignee.membershipId,
						...(teamId ? { teamId } : {})
					}),
					redirect: 'error',
					cache: 'no-store',
					signal: AbortSignal.timeout(5000)
				}
			);
			if (!response.ok) {
				await response.body?.cancel();
				if (response.status === 401) throw new UnauthorizedException();
				if (response.status === 403) throw new ForbiddenException();
				if (response.status === 404)
					throw new NotFoundException('Ответственный недоступен');
				throw new Error();
			}
			if (
				!response.headers
					.get('content-type')
					?.toLowerCase()
					.startsWith('application/json') ||
				!response.body
			)
				throw new Error();
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let bytes = 0;
			try {
				for (;;) {
					const part = await reader.read();
					if (part.done) break;
					bytes += part.value.byteLength;
					if (bytes > 512 * 1024) throw new Error();
					chunks.push(part.value);
				}
			} finally {
				await reader.cancel().catch(() => undefined);
				reader.releaseLock();
			}
			const value: unknown = JSON.parse(
				Buffer.concat(chunks).toString('utf8')
			);
			if (
				!exact(value, [
					'schemaVersion',
					'workspaceId',
					'subject',
					'assignee'
				]) ||
				value.schemaVersion !== 1 ||
				value.workspaceId !== access.workspaceId ||
				value.subject !== access.subject
			)
				throw new Error();
			const target = value.assignee;
			if (
				!exact(target, [
					'subject',
					'membershipId',
					'role',
					'dataScope',
					'teamIds'
				]) ||
				target.subject !== assignee.subject ||
				target.membershipId !== assignee.membershipId ||
				!['OWNER', 'CRM_ADMIN', 'TEAM_LEAD', 'MANAGER'].includes(
					String(target.role)
				) ||
				!['ALL', 'TEAM', 'OWN'].includes(String(target.dataScope)) ||
				!Array.isArray(target.teamIds) ||
				target.teamIds.length > 10000 ||
				target.teamIds.some(
					id => typeof id !== 'string' || !UUID.test(id)
				) ||
				new Set(target.teamIds).size !== target.teamIds.length
			)
				throw new Error();
			return target as unknown as SalesAssignee;
		} catch (error) {
			if (
				error instanceof UnauthorizedException ||
				error instanceof ForbiddenException ||
				error instanceof NotFoundException
			)
				throw error;
			throw new ServiceUnavailableException(
				'Не удалось проверить ответственного'
			);
		}
	}
}
