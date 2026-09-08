import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	WINCRM_INTAKE_SLA_EMAIL_EVENT_TYPE,
	WINCRM_INTAKE_SLA_KINDS
} from '../messaging/messaging.constants';
import type { WincrmIntakeSlaEventPayload } from '../messaging/delivery-event.types';
import {
	parseSlaDeliveryContext,
	SlaDeliveryContext
} from '../messaging/wincrm-intake-sla.contract';
import { TelegramInfoTransportService } from '../telegram/telegram-info-transport.service';

export function validSlaToken(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length >= 32 &&
		value.length <= 4096 &&
		!/[\s\x00-\x1f\x7f]/.test(value) &&
		!/^(?:change|replace|example|placeholder)/i.test(value)
	);
}

@Injectable()
export class WincrmIntakeSlaContextService implements OnModuleInit {
	constructor(
		private readonly config: ConfigService,
		private readonly telegram: TelegramInfoTransportService
	) {}
	onModuleInit(): void {
		if (this.kinds().length) this.assertConfigured();
	}
	private kinds() {
		const configured =
			this.config
				.get<string>('NOTIFICATION_DELIVERY_KINDS')
				?.split(',')
				.map(kind => kind.trim()) ?? [];
		return WINCRM_INTAKE_SLA_KINDS.filter(kind =>
			configured.includes(kind)
		);
	}
	assertConfigured(requireBoth = false): void {
		const kinds = this.kinds();
		if (!kinds.length || (requireBoth && kinds.length !== 2))
			throw new Error('WinCRM Intake SLA consumers are not enabled');
		this.configuration();
		if (
			kinds.includes('wincrm-intake-sla-email') &&
			['SMTP_SERVER', 'SMTP_LOGIN', 'SMTP_PASSWORD'].some(
				key => !this.config.get<string>(key)?.trim()
			)
		)
			throw new Error(
				'WinCRM Intake SLA email transport is not configured'
			);
		if (kinds.includes('wincrm-intake-sla-telegram'))
			this.telegram.assertConfigured();
	}
	private configuration(): { origin: string; token: string } {
		const rawOrigin = this.config.get<string>(
			'CRM_INTAKE_INTERNAL_BASE_URL'
		);
		const token = this.config.get<string>(
			'CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN'
		);
		const reverse = this.config.get<string>(
			'NOTIFICATION_DELIVERY_CRM_INTAKE_TOKEN'
		);
		let url: URL;
		try {
			url = new URL(rawOrigin ?? '');
		} catch {
			throw new Error('Invalid CRM Intake reminder origin configuration');
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
			!validSlaToken(token) ||
			!validSlaToken(reverse) ||
			token === reverse ||
			[token, reverse].some(value =>
				[
					'NOTIFICATION_DELIVERY_OPERATIONS_TOKEN',
					'CRM_SALES_NOTIFICATION_DELIVERY_TOKEN',
					'NOTIFICATION_DELIVERY_CRM_SALES_TOKEN',
					'IDENTITY_NOTIFICATION_DELIVERY_TOKEN'
				].some(key => this.config.get<string>(key) === value)
			)
		)
			throw new Error('Invalid CRM Intake reminder caller configuration');
		return { origin: url.origin, token };
	}
	async resolve(
		event: WincrmIntakeSlaEventPayload
	): Promise<SlaDeliveryContext> {
		const channel =
			event.eventType === WINCRM_INTAKE_SLA_EMAIL_EVENT_TYPE
				? 'EMAIL'
				: 'TELEGRAM';
		const kind =
			channel === 'EMAIL'
				? 'wincrm-intake-sla-email'
				: 'wincrm-intake-sla-telegram';
		if (!this.kinds().includes(kind))
			throw new Error('WinCRM Intake SLA channel is not enabled');
		const { origin, token } = this.configuration();
		const abort = new AbortController();
		const timeout = setTimeout(() => abort.abort(), 5000);
		try {
			const response = await fetch(
				`${origin}/internal/v1/notification-delivery/intake-sla/${event.reference.id}/delivery-context`,
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
						workspaceId: event.reference.workspaceId,
						channel
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
			return parseSlaDeliveryContext(
				JSON.parse(Buffer.concat(chunks).toString('utf8')),
				event,
				channel
			);
		} catch {
			// Never forward fetch errors, URLs, credentials, destinations or task content.
			abort.abort();
			throw Object.assign(
				new Error('WinCRM Intake SLA context is unavailable'),
				{ code: 'ETIMEDOUT' }
			);
		} finally {
			clearTimeout(timeout);
		}
	}
}
