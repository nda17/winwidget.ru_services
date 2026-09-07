import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
	salesAccessToken,
	serviceOrigin,
	UUID
} from '../sales/sales-access';
import type { ReminderBinding, ReminderRuleV1 } from './reminder-rule';

export interface ReminderTaskAuthority {
	id: string;
	assignedToSubject: string;
	assignedToMembershipId: string | null;
	teamId: string | null;
	deal: { assignedToSubject: string; teamId: string | null } | null;
}
export interface ReminderRecipient {
	binding: ReminderBinding;
	email: string | null;
	telegramChatId: string | null;
}
export function exactReminderObject(
	value: unknown,
	keys: readonly string[]
): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
	);
}
export async function readReminderJson(
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
		throw new Error('REMINDER_HTTP_RESPONSE');
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > maximum) {
				await reader.cancel();
				throw new Error('REMINDER_HTTP_SIZE');
			}
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function binding(value: unknown): value is ReminderBinding {
	return (
		exactReminderObject(value, ['subject', 'membershipId']) &&
		typeof value.subject === 'string' &&
		/^[^\s\x00-\x1f\x7f]{1,256}$/.test(value.subject) &&
		(value.membershipId === null ||
			(typeof value.membershipId === 'string' &&
				UUID.test(value.membershipId)))
	);
}
@Injectable()
export class ReminderRecipientsClient {
	async read(
		workspaceId: string,
		rule: ReminderRuleV1,
		task: ReminderTaskAuthority,
		recipientBinding: ReminderBinding | null,
		cursor: string | null = null
	): Promise<{
		allowed: boolean;
		items: ReminderRecipient[];
		nextCursor: string | null;
	}> {
		try {
			const origin = serviceOrigin(
				process.env.CRM_ACCESS_INTERNAL_BASE_URL
			);
			const response = await fetch(
				`${origin}/internal/v1/crm-access/task-reminder-recipients`,
				{
					method: 'POST',
					redirect: 'error',
					cache: 'no-store',
					signal: AbortSignal.timeout(10_000),
					headers: {
						'content-type': 'application/json',
						'x-winwidget-service': 'crm-sales',
						'x-winwidget-internal-token': salesAccessToken()
					},
					body: JSON.stringify({
						schemaVersion: 1,
						workspaceId,
						ruleOwnerBinding: rule.ownerBinding,
						scope: rule.scope,
						task,
						recipients: rule.recipients,
						recipientBinding,
						cursor
					})
				}
			);
			const value = await readReminderJson(response);
			if (
				!exactReminderObject(value, [
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
				(value.nextCursor !== null &&
					(typeof value.nextCursor !== 'string' ||
						!UUID.test(value.nextCursor))) ||
				(!value.allowed &&
					(value.items.length > 0 || value.nextCursor !== null)) ||
				(recipientBinding && value.nextCursor !== null)
			)
				throw new Error('REMINDER_AUTHORITY_CONTRACT');
			const seen = new Set<string>();
			for (const item of value.items) {
				if (
					!exactReminderObject(item, [
						'binding',
						'email',
						'telegramChatId'
					]) ||
					!binding(item.binding) ||
					(item.email !== null &&
						(typeof item.email !== 'string' ||
							item.email.length > 254 ||
							!/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(
								item.email
							))) ||
					(item.telegramChatId !== null &&
						(typeof item.telegramChatId !== 'string' ||
							!/^[1-9][0-9]{0,19}$/.test(item.telegramChatId))) ||
					(recipientBinding &&
						(item.binding.subject !== recipientBinding.subject ||
							item.binding.membershipId !== recipientBinding.membershipId))
				)
					throw new Error('REMINDER_RECIPIENT_CONTRACT');
				const key = JSON.stringify(item.binding);
				if (seen.has(key)) throw new Error('REMINDER_RECIPIENT_DUPLICATE');
				seen.add(key);
			}
			return {
				allowed: value.allowed,
				items: value.items as unknown as ReminderRecipient[],
				nextCursor: value.nextCursor as string | null
			};
		} catch {
			throw new ServiceUnavailableException(
				'CRM reminder recipient authority is unavailable'
			);
		}
	}
}
