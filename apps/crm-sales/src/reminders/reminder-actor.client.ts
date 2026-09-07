import {
	ForbiddenException,
	Injectable,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import {
	serviceOrigin,
	UUID,
	type SalesAccess
} from '../sales/sales-access';
import type { ReminderBinding } from './reminder-rule';

const exact = (
	value: unknown,
	keys: string[]
): value is Record<string, unknown> =>
	!!value &&
	typeof value === 'object' &&
	!Array.isArray(value) &&
	Object.keys(value).length === keys.length &&
	keys.every(key => Object.prototype.hasOwnProperty.call(value, key));

@Injectable()
export class ReminderActorClient {
	/** Existing read-only Access directory verifies Identity and current local
	 * membership, including in READ_ONLY. It is never used to grant new rights. */
	async verify(
		token: string,
		access: SalesAccess,
		membershipId: string | null
	): Promise<ReminderBinding> {
		if (!/^Bearer [^\s]{1,16384}$/.test(token))
			throw new UnauthorizedException();
		if (
			access.role === 'ANALYST' ||
			(access.role === 'OWNER'
				? membershipId !== null
				: typeof membershipId !== 'string' || !UUID.test(membershipId))
		)
			throw new ForbiddenException(
				'CRM reminder membership is unavailable'
			);
		const binding = { subject: access.subject, membershipId };
		try {
			const response = await fetch(
				`${serviceOrigin(process.env.CRM_ACCESS_INTERNAL_BASE_URL)}/api/v1/crm/access/team/assignee-labels`,
				{
					method: 'POST',
					headers: {
						Authorization: token,
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						schemaVersion: 1,
						workspaceId: access.workspaceId,
						bindings: [binding]
					}),
					redirect: 'error',
					cache: 'no-store',
					signal: AbortSignal.timeout(5000)
				}
			);
			if (!response.ok) {
				await response.body?.cancel();
				if (response.status === 401) throw new UnauthorizedException();
				if ([403, 404, 409].includes(response.status))
					throw new ForbiddenException('CRM reminder membership changed');
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
			const reader = response.body.getReader(),
				chunks: Uint8Array[] = [];
			let size = 0;
			try {
				for (;;) {
					const part = await reader.read();
					if (part.done) break;
					size += part.value.byteLength;
					if (size > 32768) throw new Error();
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
					'items'
				]) ||
				value.schemaVersion !== 1 ||
				value.workspaceId !== access.workspaceId ||
				value.subject !== access.subject ||
				!Array.isArray(value.items) ||
				value.items.length !== 1
			)
				throw new Error();
			const item: unknown = value.items[0];
			if (
				!exact(item, ['binding', 'employee']) ||
				!exact(item.binding, ['subject', 'membershipId']) ||
				item.binding.subject !== binding.subject ||
				item.binding.membershipId !== binding.membershipId
			)
				throw new Error();
			if (item.employee === null)
				throw new ForbiddenException('CRM reminder membership changed');
			const employee = item.employee;
			if (
				!exact(employee, [
					'subject',
					'membershipId',
					'displayName',
					'verifiedEmail',
					'role'
				]) ||
				employee.subject !== access.subject ||
				employee.role !== access.role ||
				typeof employee.membershipId !== 'string' ||
				!UUID.test(employee.membershipId)
			)
				throw new Error();
			// Directory null lookup is display-only for legacy tasks. Here null is
			// accepted exclusively after BOTH Access and Identity prove OWNER.
			if (membershipId !== null && employee.membershipId !== membershipId)
				throw new ForbiddenException('CRM reminder membership changed');
			return Object.freeze(binding);
		} catch (error) {
			if (
				error instanceof UnauthorizedException ||
				error instanceof ForbiddenException
			)
				throw error;
			throw new ServiceUnavailableException(
				'CRM reminder membership is temporarily unavailable'
			);
		}
	}
}
