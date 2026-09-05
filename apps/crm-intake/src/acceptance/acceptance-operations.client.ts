import {
	ConflictException,
	ForbiddenException,
	HttpException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { parseIntakeAccessOrigin } from '../access/intake-authorization.client';
import {
	ACCEPTANCE_UUID,
	type OperationBinding,
	type OperationProof
} from './acceptance.contract';

export function parseOperationProof(
	value: unknown,
	binding: OperationBinding,
	target: 'customers' | 'sales'
): OperationProof {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('INVALID_PROOF');
	const proof = value as Record<string, unknown>;
	if (
		Object.keys(proof).sort().join(',') !==
			'actorSubject,committedAt,operationId,payloadHash,result,schemaVersion,state,workflowId,workspaceId' ||
		Object.entries(binding).some(([key, item]) => proof[key] !== item) ||
		!['COMMITTED', 'CANCELLED', 'ABSENT'].includes(String(proof.state))
	)
		throw new Error('INVALID_PROOF');
	if (proof.state !== 'COMMITTED') {
		if (proof.result !== null || proof.committedAt !== null)
			throw new Error('INVALID_PROOF');
	} else {
		if (
			typeof proof.committedAt !== 'string' ||
			!Number.isFinite(Date.parse(proof.committedAt)) ||
			new Date(proof.committedAt).toISOString() !== proof.committedAt ||
			!proof.result ||
			typeof proof.result !== 'object' ||
			Array.isArray(proof.result)
		)
			throw new Error('INVALID_PROOF');
		const result = proof.result as Record<string, unknown>;
		const keys =
			target === 'customers'
				? ['contactId', 'contactName', 'contactVersion']
				: ['contactId', 'dealId', 'firstTaskId'];
		if (
			Object.keys(result).length !== keys.length ||
			keys.some(key => !(key in result)) ||
			typeof result.contactId !== 'string' ||
			!ACCEPTANCE_UUID.test(result.contactId)
		)
			throw new Error('INVALID_PROOF');
		if (
			target === 'customers'
				? typeof result.contactName !== 'string' ||
					!result.contactName.trim() ||
					result.contactName.length > 200 ||
					!Number.isInteger(result.contactVersion) ||
					Number(result.contactVersion) < 1
				: !['dealId', 'firstTaskId'].every(
						key =>
							typeof result[key] === 'string' &&
							ACCEPTANCE_UUID.test(result[key])
					)
		)
			throw new Error('INVALID_PROOF');
	}
	return proof as unknown as OperationProof;
}

@Injectable()
export class AcceptanceOperationsClient {
	async request(
		target: 'customers' | 'sales',
		action: 'read' | 'execute' | 'close',
		binding: OperationBinding,
		command?: {
			commandId: string;
			payload?: unknown;
			recoverySubject?: string;
		}
	): Promise<OperationProof> {
		try {
			const prefix =
				target === 'customers' ? 'CRM_CUSTOMERS' : 'CRM_SALES';
			const origin = parseIntakeAccessOrigin(
				process.env[`${prefix}_INTERNAL_BASE_URL`]
			);
			const token = process.env[`${prefix}_CRM_INTAKE_TOKEN`] || '';
			if (
				token.length < 32 ||
				token.length > 4096 ||
				/\s|change[_-]?me|replace-|<[^>]+>/i.test(token)
			)
				throw new Error('CONFIGURATION');
			const response = await fetch(
				`${origin}/internal/v1/crm-${target}/intake-operations/${action}`,
				{
					method: 'POST',
					redirect: 'error',
					cache: 'no-store',
					signal: AbortSignal.timeout(10000),
					headers: {
						'content-type': 'application/json',
						'x-winwidget-service': 'crm-intake',
						'x-winwidget-internal-token': token,
						...(command ? { 'idempotency-key': command.commandId } : {})
					},
					body: JSON.stringify({ ...binding, ...command })
				}
			);
			if (response.status !== 200 || !response.body) {
				await response.body?.cancel();
				if (response.status === 403)
					throw new ForbiddenException(
						'Workflow authority is not available'
					);
				if (response.status === 404)
					throw new NotFoundException(
						'Workflow reference is not available'
					);
				if (response.status === 409 || response.status === 400)
					throw new ConflictException('Workflow operation conflicts');
				throw new Error('DEPENDENCY');
			}
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const item = await reader.read();
					if (item.done) break;
					size += item.value.byteLength;
					if (size > 65536) {
						await reader.cancel();
						throw new Error('RESPONSE_SIZE');
					}
					chunks.push(item.value);
				}
			} finally {
				reader.releaseLock();
			}
			return parseOperationProof(
				JSON.parse(Buffer.concat(chunks, size).toString('utf8')),
				binding,
				target
			);
		} catch (error) {
			if (error instanceof HttpException) throw error;
			throw new ServiceUnavailableException(
				'Workflow dependency is temporarily unavailable'
			);
		}
	}
}
