import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isWincrmInvitationDeliveryEnabled } from '../messaging/messaging.constants';
import type { WincrmInvitationEmailRequestedEventPayload } from '../messaging/delivery-event.types';
import {
	hasExactInvitationKeys,
	isCanonicalInvitationDate,
	isNormalizedInvitationEmail
} from '../messaging/wincrm-invitation.contract';

const MAX_RESPONSE_BYTES = 4096;
const CONTEXT_TIMEOUT_MS = 5000;

@Injectable()
export class WincrmInvitationContextService implements OnModuleInit {
	constructor(private readonly config: ConfigService) {}

	onModuleInit(): void {
		if (this.enabled()) this.configuration();
	}

	private enabled(): boolean {
		return isWincrmInvitationDeliveryEnabled(
			this.config.get<string>('NOTIFICATION_DELIVERY_KINDS')
		);
	}

	private configuration(): { origin: string; token: string } {
		if (!this.enabled())
			throw new Error('WinCRM invitation delivery is not enabled');
		const rawOrigin = this.config.get<string>(
			'IDENTITY_INTERNAL_BASE_URL'
		);
		const token = this.config.get<string>(
			'IDENTITY_NOTIFICATION_DELIVERY_TOKEN'
		);
		let url: URL;
		try {
			url = new URL(rawOrigin ?? '');
		} catch {
			throw new Error('Invalid Identity invitation origin configuration');
		}
		const local = ['localhost', '127.0.0.1', '[::1]'].includes(
			url.hostname
		);
		if (
			!rawOrigin ||
			rawOrigin !== rawOrigin.trim() ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== '/' ||
			(url.protocol !== 'https:' &&
				!(local && url.protocol === 'http:')) ||
			!token ||
			token ===
				this.config.get<string>(
					'NOTIFICATION_DELIVERY_OPERATIONS_TOKEN'
				) ||
			token.length < 32 ||
			token.length > 4096 ||
			token !== token.trim() ||
			/[\s\x00-\x1f\x7f]/.test(token) ||
			/^(?:change|replace|example|placeholder)/i.test(token)
		) {
			throw new Error(
				'Invalid Identity invitation delivery configuration'
			);
		}
		return { origin: url.origin, token };
	}

	async canDeliver(
		event: WincrmInvitationEmailRequestedEventPayload
	): Promise<boolean> {
		const { origin, token } = this.configuration();
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			CONTEXT_TIMEOUT_MS
		);
		try {
			const response = await fetch(
				`${origin}/internal/v1/notification-delivery/wincrm-invitations/${event.reference.id}/delivery-context`,
				{
					method: 'POST',
					redirect: 'error',
					signal: controller.signal,
					headers: {
						'content-type': 'application/json',
						'x-winwidget-service': 'notification-delivery',
						'x-winwidget-internal-token': token
					},
					body: JSON.stringify({
						schemaVersion: 1,
						eventId: event.eventId,
						workspaceId: event.reference.workspaceId
					})
				}
			);
			if (
				response.status !== 200 ||
				!response.headers
					.get('content-type')
					?.toLowerCase()
					.startsWith('application/json') ||
				Number(response.headers.get('content-length') ?? 0) >
					MAX_RESPONSE_BYTES ||
				!response.body
			)
				throw new Error('Invalid context response');
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					size += chunk.value.byteLength;
					if (size > MAX_RESPONSE_BYTES) {
						await reader.cancel();
						throw new Error('Oversized context response');
					}
					chunks.push(chunk.value);
				}
			} finally {
				reader.releaseLock();
			}
			const value: unknown = JSON.parse(
				Buffer.concat(chunks).toString('utf8')
			);
			if (
				!hasExactInvitationKeys(value, [
					'schemaVersion',
					'invitationId',
					'workspaceId',
					'eventId',
					'deliver',
					'email',
					'expiresAt'
				]) ||
				value.schemaVersion !== 1 ||
				value.invitationId !== event.reference.id ||
				value.workspaceId !== event.reference.workspaceId ||
				value.eventId !== event.eventId ||
				!isCanonicalInvitationDate(value.expiresAt) ||
				value.expiresAt !== event.content.expiresAt ||
				typeof value.deliver !== 'boolean' ||
				(value.deliver
					? !isNormalizedInvitationEmail(value.email) ||
						value.email !== event.destination.email
					: value.email !== null)
			) {
				throw new Error('Invalid context binding');
			}
			return value.deliver;
		} catch {
			// Fetch errors may contain credentials, response bodies or URLs. Do not propagate them.
			throw new Error('WinCRM invitation eligibility is unavailable');
		} finally {
			clearTimeout(timeout);
		}
	}
}
