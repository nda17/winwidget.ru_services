import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { parseIntakeAccessOrigin } from '../access/intake-authorization.client';
import {
	slaBinding,
	slaKeys,
	slaRecord,
	slaUuid,
	type SlaBinding,
	type SlaRuleConfig
} from './sla.contract';

export interface SlaEntryAuthority {
	id: string;
	createdBySubject: string;
	teamId: string | null;
}
export interface SlaRecipient {
	binding: SlaBinding;
	email: string | null;
	telegramChatId: string | null;
}
export function slaInternalToken(
	name:
		| 'CRM_ACCESS_CRM_INTAKE_TOKEN'
		| 'CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN'
		| 'NOTIFICATION_DELIVERY_CRM_INTAKE_TOKEN'
) {
	const token = process.env[name];
	if (
		!token ||
		token.length < 32 ||
		token.length > 4096 ||
		/[\s\x00-\x1f\x7f]|change[_-]?me|replace-|<[^>]+>/i.test(token)
	)
		throw new Error('SLA_INTERNAL_CONFIGURATION');
	if (
		[
			'CRM_ACCESS_CRM_INTAKE_TOKEN',
			'CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN',
			'NOTIFICATION_DELIVERY_CRM_INTAKE_TOKEN',
			'CRM_SALES_NOTIFICATION_DELIVERY_TOKEN',
			'NOTIFICATION_DELIVERY_CRM_SALES_TOKEN'
		]
			.filter(key => key !== name)
			.some(key => process.env[key] === token)
	)
		throw new Error('SLA_CREDENTIAL_ALIAS');
	return token;
}
export async function readSlaJson(
	response: Response,
	maximum = 65536
): Promise<unknown> {
	if (
		response.status !== 200 ||
		!response.body ||
		!response.headers
			.get('content-type')
			?.toLowerCase()
			.startsWith('application/json') ||
		Number(response.headers.get('content-length') ?? 0) > maximum
	) {
		await response.body?.cancel();
		throw new Error('SLA_HTTP_RESPONSE');
	}
	const reader = response.body.getReader(),
		chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > maximum) {
				await reader.cancel();
				throw new Error('SLA_HTTP_SIZE');
			}
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
@Injectable()
export class SlaRecipientsClient {
	async read(
		workspaceId: string,
		ruleOwnerBinding: SlaBinding,
		config: SlaRuleConfig,
		entry: SlaEntryAuthority,
		recipientBinding: SlaBinding | null = null,
		cursor: string | null = null
	): Promise<{
		allowed: boolean;
		items: SlaRecipient[];
		nextCursor: string | null;
	}> {
		try {
			const origin = parseIntakeAccessOrigin(
				process.env.CRM_ACCESS_INTERNAL_BASE_URL
			);
			const value = await readSlaJson(
				await fetch(
					`${origin}/internal/v1/crm-access/intake-sla-recipients`,
					{
						method: 'POST',
						redirect: 'error',
						cache: 'no-store',
						signal: AbortSignal.timeout(10000),
						headers: {
							'content-type': 'application/json',
							'x-winwidget-service': 'crm-intake',
							'x-winwidget-internal-token': slaInternalToken(
								'CRM_ACCESS_CRM_INTAKE_TOKEN'
							)
						},
						body: JSON.stringify({
							schemaVersion: 1,
							purpose: 'INTAKE_SLA',
							workspaceId,
							ruleOwnerBinding,
							entry,
							responsibleBinding: config.responsibleBinding,
							notifyManagers: config.notifyManagers,
							recipientBinding,
							cursor
						})
					}
				)
			);
			if (
				!slaRecord(value) ||
				!slaKeys(value, [
					'schemaVersion',
					'workspaceId',
					'allowed',
					'items',
					'nextCursor'
				]) ||
				value.schemaVersion !== 1 ||
				value.workspaceId !== workspaceId ||
				typeof value.allowed !== 'boolean' ||
				!Array.isArray(value.items) ||
				value.items.length > (recipientBinding ? 1 : 100) ||
				!(value.nextCursor === null || slaUuid(value.nextCursor)) ||
				(!value.allowed &&
					(value.items.length !== 0 || value.nextCursor !== null)) ||
				(recipientBinding !== null && value.nextCursor !== null) ||
				(cursor !== null &&
					value.nextCursor !== null &&
					value.nextCursor <= cursor)
			)
				throw new Error('SLA_RECIPIENT_CONTRACT');
			const seen = new Set<string>();
			for (const item of value.items) {
				if (
					!slaRecord(item) ||
					!slaKeys(item, ['binding', 'email', 'telegramChatId']) ||
					!slaBinding(item.binding) ||
					!(
						item.email === null ||
						(typeof item.email === 'string' &&
							item.email.length <= 254 &&
							/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(
								item.email
							))
					) ||
					!(
						item.telegramChatId === null ||
						(typeof item.telegramChatId === 'string' &&
							/^[1-9][0-9]{0,19}$/.test(item.telegramChatId))
					) ||
					(recipientBinding &&
						(item.binding.subject !== recipientBinding.subject ||
							item.binding.membershipId !== recipientBinding.membershipId))
				)
					throw new Error('SLA_RECIPIENT_BINDING');
				const key = JSON.stringify(item.binding);
				if (seen.has(key)) throw new Error('SLA_RECIPIENT_DUPLICATE');
				seen.add(key);
			}
			return {
				allowed: value.allowed,
				items: value.items as unknown as SlaRecipient[],
				nextCursor: value.nextCursor as string | null
			};
		} catch {
			throw new ServiceUnavailableException(
				'Intake SLA recipient authority is unavailable'
			);
		}
	}
}
