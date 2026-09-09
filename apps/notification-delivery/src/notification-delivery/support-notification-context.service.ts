import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	SUPPORT_NOTIFICATION_KINDS,
	SupportNotificationKind
} from '../messaging/messaging.constants';
import {
	parseSupportNotificationContext,
	SupportNotificationContext,
	SupportNotificationEvent
} from '../messaging/support-notification.contract';
import { TelegramSupportTransportService } from '../telegram/telegram-support-transport.service';
import { validReminderToken } from './wincrm-task-reminder-context.service';

@Injectable()
export class SupportNotificationContextService implements OnModuleInit {
	constructor(
		private readonly config: ConfigService,
		private readonly telegram: TelegramSupportTransportService
	) {}
	onModuleInit(): void {
		if (this.kinds().length) this.assertConfigured();
	}
	private kinds(): SupportNotificationKind[] {
		const enabled =
			this.config
				.get<string>('NOTIFICATION_DELIVERY_KINDS')
				?.split(',')
				.map(kind => kind.trim()) ?? [];
		return SUPPORT_NOTIFICATION_KINDS.filter(kind =>
			enabled.includes(kind)
		);
	}
	assertConfigured(): void {
		const kinds = this.kinds();
		if (!kinds.length)
			throw new Error('Support notification consumers are not enabled');
		this.configuration();
		if (
			kinds.some(kind => kind.endsWith('-email')) &&
			['SMTP_SERVER', 'SMTP_LOGIN', 'SMTP_PASSWORD'].some(
				key => !this.config.get<string>(key)?.trim()
			)
		)
			throw new Error(
				'Support notification email transport is not configured'
			);
		if (kinds.includes('support-team-telegram'))
			this.telegram.assertConfigured();
	}
	private configuration(): { origin: string; token: string } {
		const origin = this.config.get<string>('SUPPORT_INTERNAL_BASE_URL');
		const token = this.config.get<string>(
			'SUPPORT_NOTIFICATION_DELIVERY_TOKEN'
		);
		let url: URL;
		try {
			url = new URL(origin ?? '');
		} catch {
			throw new Error('Invalid Support notification origin');
		}
		const local = ['localhost', '127.0.0.1', '[::1]'].includes(
			url.hostname
		);
		if (
			!origin ||
			origin !== origin.trim() ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== '/' ||
			(url.protocol !== 'https:' &&
				!(local && url.protocol === 'http:')) ||
			!validReminderToken(token) ||
			[
				'SUPPORT_OPERATIONS_TOKEN',
				'NOTIFICATION_DELIVERY_OPERATIONS_TOKEN',
				'IDENTITY_NOTIFICATION_DELIVERY_TOKEN',
				'CRM_SALES_NOTIFICATION_DELIVERY_TOKEN',
				'NOTIFICATION_DELIVERY_CRM_SALES_TOKEN',
				'CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN',
				'NOTIFICATION_DELIVERY_CRM_INTAKE_TOKEN'
			].some(key => this.config.get<string>(key) === token)
		)
			throw new Error('Invalid Support notification caller configuration');
		return { origin: url.origin, token };
	}
	async resolve(
		event: SupportNotificationEvent,
		kind: SupportNotificationKind
	): Promise<SupportNotificationContext> {
		if (!this.kinds().includes(kind))
			throw new Error('Support notification channel is not enabled');
		const { origin, token } = this.configuration();
		const abort = new AbortController();
		const timeout = setTimeout(() => abort.abort(), 5000);
		try {
			const response = await fetch(
				`${origin}/internal/v1/notification-delivery/support-notifications/${event.reference.id}/delivery-context`,
				{
					method: 'POST',
					redirect: 'error',
					signal: abort.signal,
					headers: {
						'content-type': 'application/json',
						'x-winwidget-service': 'notification-delivery',
						'x-winwidget-internal-token': token
					},
					body: JSON.stringify({
						schemaVersion: 1,
						eventId: event.eventId,
						kind
					})
				}
			);
			if (
				response.status !== 200 ||
				!response.headers
					.get('content-type')
					?.toLowerCase()
					.startsWith('application/json') ||
				Number(response.headers.get('content-length') ?? 0) > 8192 ||
				!response.body
			)
				throw new Error('Invalid context response');
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				for (;;) {
					const part = await reader.read();
					if (part.done) break;
					size += part.value.byteLength;
					if (size > 8192) {
						await reader.cancel();
						throw new Error('Oversized context');
					}
					chunks.push(part.value);
				}
			} finally {
				reader.releaseLock();
			}
			return parseSupportNotificationContext(
				JSON.parse(Buffer.concat(chunks).toString('utf8')),
				event,
				kind
			);
		} catch {
			abort.abort();
			// Never expose fetch URLs, tokens, destinations or provider response bodies.
			throw Object.assign(
				new Error('Support notification context is unavailable'),
				{ code: 'ETIMEDOUT' }
			);
		} finally {
			clearTimeout(timeout);
		}
	}
}
