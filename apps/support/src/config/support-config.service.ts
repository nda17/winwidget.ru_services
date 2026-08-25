import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { SupportRuntimeService } from '../runtime/support-runtime.service';

const PRODUCTION_TELEGRAM_API_BASE_URL =
	'https://tg.winwidget.ru/telegram-api';
const PRODUCTION_TELEGRAM_API_PROXY_IP = '185.184.122.62';
const PRODUCTION_WEBHOOK_URL =
	'https://tg.winwidget.ru/api/v1/telegram-bot/support-webhook';
const PLACEHOLDERS = new Set([
	'change_me',
	'change-me',
	'XYZXYZXYZ',
	'change_me_support_webhook_secret_at_least_32_chars',
	'change_me_support_identity_token_at_least_32_chars'
]);

@Injectable()
export class SupportConfigService {
	readonly mode: string;
	readonly botToken: string;
	readonly botUsername: string;
	readonly webhookSecret: string;
	readonly webhookPublicUrl: string;
	readonly telegramApiBaseUrl: string;
	readonly telegramApiProxyIp: string;

	constructor(
		config: ConfigService,
		private readonly runtime: SupportRuntimeService
	) {
		this.mode =
			config.get<string>('MODE')?.trim().toLowerCase() || 'development';
		this.botToken =
			config.get<string>('TELEGRAM_SUPPORT_BOT_TOKEN')?.trim() || '';
		this.botUsername =
			config
				.get<string>('TELEGRAM_SUPPORT_BOT_USERNAME')
				?.trim()
				.replace(/^@/, '') || '';
		this.webhookSecret =
			config.get<string>('TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET')?.trim() ||
			'';
		this.webhookPublicUrl =
			config.get<string>('SUPPORT_WEBHOOK_PUBLIC_URL')?.trim() || '';
		this.telegramApiBaseUrl =
			config.get<string>('TELEGRAM_API_BASE_URL')?.trim() || '';
		this.telegramApiProxyIp =
			config.get<string>('TELEGRAM_API_PROXY_IP')?.trim() || '';

		if (this.runtime.apiEnabled || this.runtime.workerEnabled) {
			this.assertBotToken();
			this.assertTelegramApiBaseUrl();
			this.assertTelegramProxyIp();
		}
		if (this.runtime.apiEnabled) {
			this.assertBotUsername();
			this.assertSecret(
				this.webhookSecret,
				'TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET'
			);
			this.assertWebhookPublicUrl();
		}
		if (this.runtime.outboxPublisherEnabled) {
			this.assertPublisherHasNoTelegramCredentials();
		}
	}

	assertWebhookSecret(candidate: string | undefined): void {
		const expected = Buffer.from(this.webhookSecret);
		const actual = Buffer.from(candidate || '');
		if (
			actual.length !== expected.length ||
			!timingSafeEqual(actual, expected)
		) {
			throw new Error('SUPPORT_WEBHOOK_SECRET_INVALID');
		}
	}

	private assertSecret(value: string, name: string): void {
		if (
			value.length < 32 ||
			PLACEHOLDERS.has(value) ||
			value.startsWith('ci_') ||
			value.startsWith('change_me')
		) {
			throw new Error(
				`${name} must be a non-placeholder secret with at least 32 characters`
			);
		}
	}

	private assertBotToken(): void {
		if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(this.botToken)) {
			throw new Error('TELEGRAM_SUPPORT_BOT_TOKEN is missing or invalid');
		}
	}

	private assertBotUsername(): void {
		if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(this.botUsername)) {
			throw new Error(
				'TELEGRAM_SUPPORT_BOT_USERNAME is missing or invalid'
			);
		}
	}

	private assertPublisherHasNoTelegramCredentials(): void {
		if (
			this.botToken ||
			this.botUsername ||
			this.webhookSecret ||
			this.webhookPublicUrl ||
			this.telegramApiBaseUrl ||
			this.telegramApiProxyIp
		) {
			throw new Error(
				'Support Outbox publisher must not receive Telegram credentials or transport configuration'
			);
		}
	}

	private assertTelegramApiBaseUrl(): void {
		let url: URL;
		try {
			url = new URL(this.telegramApiBaseUrl);
		} catch {
			throw new Error('TELEGRAM_API_BASE_URL is invalid');
		}
		const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(
			url.hostname.toLowerCase()
		);
		const canonical =
			url.toString().replace(/\/+$/, '') ===
			PRODUCTION_TELEGRAM_API_BASE_URL;
		const localTest =
			this.mode !== 'production' && url.protocol === 'http:' && loopback;
		if (
			(!canonical && !localTest) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			throw new Error('TELEGRAM_API_BASE_URL is not allowed');
		}
		if (this.mode === 'production' && !canonical) {
			throw new Error(
				`TELEGRAM_API_BASE_URL must be ${PRODUCTION_TELEGRAM_API_BASE_URL}`
			);
		}
	}

	private assertTelegramProxyIp(): void {
		if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(this.telegramApiProxyIp)) {
			throw new Error('TELEGRAM_API_PROXY_IP must be an IPv4 address');
		}
		if (
			this.mode === 'production' &&
			this.telegramApiProxyIp !== PRODUCTION_TELEGRAM_API_PROXY_IP
		) {
			throw new Error(
				`TELEGRAM_API_PROXY_IP must be ${PRODUCTION_TELEGRAM_API_PROXY_IP}`
			);
		}
	}

	private assertWebhookPublicUrl(): void {
		let url: URL;
		try {
			url = new URL(this.webhookPublicUrl);
		} catch {
			throw new Error('SUPPORT_WEBHOOK_PUBLIC_URL is invalid');
		}
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			(this.mode === 'production' &&
				url.toString() !== PRODUCTION_WEBHOOK_URL)
		) {
			throw new Error(
				`SUPPORT_WEBHOOK_PUBLIC_URL must be ${PRODUCTION_WEBHOOK_URL} in production`
			);
		}
	}
}

export const SUPPORT_TELEGRAM_API_BASE_URL =
	PRODUCTION_TELEGRAM_API_BASE_URL;
export const SUPPORT_TELEGRAM_API_PROXY_IP =
	PRODUCTION_TELEGRAM_API_PROXY_IP;
