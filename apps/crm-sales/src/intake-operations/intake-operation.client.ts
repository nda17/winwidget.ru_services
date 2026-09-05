import {
	ConflictException,
	ForbiddenException,
	Injectable,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	parseSalesAccess,
	salesAccessToken,
	serviceOrigin,
	UUID,
	type SalesAccess
} from '../sales/sales-access';
import type { IntakeOperationBinding } from './intake-operation.dto';

export function intakeOperationToken(
	name: 'CRM_SALES_CRM_INTAKE_TOKEN' | 'CRM_CUSTOMERS_CRM_SALES_TOKEN'
) {
	const token = process.env[name];
	if (
		!token ||
		token.length < 32 ||
		token.length > 4096 ||
		/\s/.test(token) ||
		/^(?:replace-|change[_-]?me|ci_)/i.test(token)
	) {
		throw new ServiceUnavailableException(
			'CRM workflow credentials are unavailable'
		);
	}
	return token;
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
		keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
	);
}
export async function boundedOperationJson(
	response: Response
): Promise<unknown> {
	if (
		!/^application\/json\b/i.test(
			response.headers.get('content-type') || ''
		) ||
		!response.body
	)
		throw new Error('Invalid JSON response');
	const length = response.headers.get('content-length');
	if (length && (!/^\d+$/.test(length) || Number(length) > 65536)) {
		await response.body.cancel();
		throw new Error('Oversized response');
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 65536) {
				await reader.cancel();
				throw new Error('Oversized response');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

@Injectable()
export class IntakeOperationClient {
	async authorize(
		binding: IntakeOperationBinding,
		subject = binding.actorSubject
	): Promise<SalesAccess> {
		const value = await this.post(
			serviceOrigin(process.env.CRM_ACCESS_INTERNAL_BASE_URL),
			'/internal/v1/crm-access/authorize-workflow',
			salesAccessToken(),
			{
				schemaVersion: 1,
				workspaceId: binding.workspaceId,
				subject,
				purpose: 'INTAKE_ACCEPT'
			}
		);
		let access: SalesAccess;
		try {
			access = parseSalesAccess(value, binding.workspaceId);
		} catch {
			throw new ServiceUnavailableException(
				'CRM workflow authorization is unavailable'
			);
		}
		if (
			access.subject !== subject ||
			!['ACTIVE', 'GRACE'].includes(access.state) ||
			access.role === 'ANALYST' ||
			!access.permissions.includes('sales:write') ||
			access.dataScope !==
				(access.role === 'MANAGER'
					? 'OWN'
					: access.role === 'TEAM_LEAD'
						? 'TEAM'
						: 'ALL') ||
			access.permissions.some(
				permission => !permission.startsWith('sales:')
			)
		)
			throw new ForbiddenException();
		return access;
	}

	async verifyContact(
		binding: IntakeOperationBinding
	): Promise<{ contactId: string; contactName: string }> {
		const proof = await this.post(
			serviceOrigin(process.env.CRM_CUSTOMERS_INTERNAL_BASE_URL),
			'/internal/v1/crm-customers/intake-operations/verify',
			intakeOperationToken('CRM_CUSTOMERS_CRM_SALES_TOKEN'),
			binding
		);
		try {
			if (
				!exact(proof, [
					...Object.keys(binding),
					'state',
					'result',
					'committedAt'
				]) ||
				Object.entries(binding).some(
					([key, value]) => proof[key] !== value
				)
			)
				throw new Error();
			if (proof.state !== 'COMMITTED')
				throw new ConflictException('Contact operation has not committed');
			const result = proof.result;
			if (
				!exact(result, ['contactId', 'contactName', 'contactVersion']) ||
				typeof result.contactId !== 'string' ||
				!UUID.test(result.contactId) ||
				typeof result.contactName !== 'string' ||
				!result.contactName.trim() ||
				result.contactName.length > 200 ||
				!Number.isSafeInteger(result.contactVersion) ||
				Number(result.contactVersion) < 1 ||
				Number(result.contactVersion) > 2147483647 ||
				typeof proof.committedAt !== 'string' ||
				!Number.isFinite(Date.parse(proof.committedAt)) ||
				new Date(proof.committedAt).toISOString() !== proof.committedAt
			)
				throw new Error();
			return {
				contactId: result.contactId,
				contactName: result.contactName
			};
		} catch (error) {
			if (error instanceof ConflictException) throw error;
			throw new ServiceUnavailableException(
				'CRM contact proof is unavailable'
			);
		}
	}

	private async post(
		origin: string,
		path: string,
		token: string,
		body: unknown
	): Promise<unknown> {
		try {
			const response = await fetch(origin + path, {
				method: 'POST',
				redirect: 'error',
				cache: 'no-store',
				signal: AbortSignal.timeout(10000),
				headers: {
					'content-type': 'application/json',
					'x-winwidget-service': 'crm-sales',
					'x-winwidget-internal-token': token
				},
				body: JSON.stringify(body)
			});
			if (!response.ok) {
				await response.body?.cancel();
				if (response.status === 401 || response.status === 403)
					throw new ForbiddenException();
				if (response.status === 404 || response.status === 409)
					throw new ConflictException(
						'CRM workflow dependency is unavailable'
					);
				throw new Error();
			}
			return await boundedOperationJson(response);
		} catch (error) {
			if (
				error instanceof ForbiddenException ||
				error instanceof ConflictException
			)
				throw error;
			throw new ServiceUnavailableException(
				'CRM workflow dependency is temporarily unavailable'
			);
		}
	}
}
