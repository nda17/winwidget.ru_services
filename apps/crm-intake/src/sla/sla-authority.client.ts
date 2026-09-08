import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { parseIntakeAccessOrigin } from '../access/intake-authorization.client';
import {
	slaBinding,
	slaKeys,
	slaRecord,
	slaSubject,
	slaUuid,
	type SlaBinding
} from './sla.contract';

@Injectable()
export class SlaAuthorityClient {
	async owner(
		workspaceId: string,
		actorSubject: string,
		expectedBinding: SlaBinding | null = null
	): Promise<SlaBinding | null> {
		try {
			if (
				!slaUuid(workspaceId) ||
				!slaSubject(actorSubject) ||
				(expectedBinding !== null &&
					(!slaBinding(expectedBinding) ||
						expectedBinding.subject !== actorSubject))
			)
				throw new Error('BINDING');
			const origin = parseIntakeAccessOrigin(
				process.env.CRM_ACCESS_INTERNAL_BASE_URL
			);
			const token = process.env.CRM_ACCESS_CRM_INTAKE_TOKEN || '';
			if (
				token.length < 32 ||
				token.length > 4096 ||
				/\s|change[_-]?me|replace-|<[^>]+>/i.test(token)
			)
				throw new Error('CONFIGURATION');
			const response = await fetch(
				`${origin}/internal/v1/crm-access/intake-sla-authority`,
				{
					method: 'POST',
					redirect: 'error',
					cache: 'no-store',
					signal: AbortSignal.timeout(10000),
					headers: {
						'content-type': 'application/json',
						'x-winwidget-service': 'crm-intake',
						'x-winwidget-internal-token': token
					},
					body: JSON.stringify({
						schemaVersion: 1,
						purpose: 'INTAKE_SLA',
						workspaceId,
						actorSubject,
						expectedBinding
					})
				}
			);
			if (response.status !== 200 || !response.body) {
				await response.body?.cancel();
				throw new Error('DEPENDENCY');
			}
			const reader = response.body.getReader(),
				chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const item = await reader.read();
					if (item.done) break;
					size += item.value.byteLength;
					if (size > 4096) {
						await reader.cancel();
						throw new Error('RESPONSE_SIZE');
					}
					chunks.push(item.value);
				}
			} finally {
				reader.releaseLock();
			}
			const value: unknown = JSON.parse(
				Buffer.concat(chunks).toString('utf8')
			);
			if (
				!slaRecord(value) ||
				!slaKeys(value, [
					'schemaVersion',
					'workspaceId',
					'allowed',
					'binding'
				]) ||
				value.schemaVersion !== 1 ||
				value.workspaceId !== workspaceId ||
				typeof value.allowed !== 'boolean'
			)
				throw new Error('RESPONSE_BINDING');
			if (!value.allowed) {
				if (value.binding !== null) throw new Error('DENIED_BINDING');
				return null;
			}
			if (
				!slaBinding(value.binding) ||
				value.binding.subject !== actorSubject ||
				(expectedBinding !== null &&
					value.binding.membershipId !== expectedBinding.membershipId)
			)
				throw new Error('RESPONSE_BINDING');
			return value.binding;
		} catch {
			throw new ServiceUnavailableException(
				'Intake SLA authority is unavailable'
			);
		}
	}
}
