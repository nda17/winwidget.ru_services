import { ConfigService } from '@nestjs/config';
import { SupportProcessRole } from '../runtime/support-runtime.service';
import { SupportConfigService } from './support-config.service';

const canonicalEnvironment = {
	MODE: 'production',
	TELEGRAM_SUPPORT_BOT_TOKEN: `123456:${'A'.repeat(32)}`,
	TELEGRAM_SUPPORT_BOT_USERNAME: 'WinWidgetSupportBot',
	TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET: 'w'.repeat(48),
	SUPPORT_WEBHOOK_PUBLIC_URL:
		'https://tg.winwidget.ru/api/v1/telegram-bot/support-webhook',
	TELEGRAM_API_BASE_URL: 'https://tg.winwidget.ru/telegram-api',
	TELEGRAM_API_PROXY_IP: '185.184.122.62'
};

function build(
	overrides: Record<string, string | undefined> = {},
	role: SupportProcessRole = 'api'
) {
	return new SupportConfigService(
		new ConfigService({ ...canonicalEnvironment, ...overrides }),
		{
			role,
			apiEnabled: role === 'api',
			workerEnabled: role === 'worker',
			outboxPublisherEnabled: role === 'outbox-publisher'
		} as never
	);
}

describe('SupportConfigService', () => {
	it('accepts the exact production Telegram bridge URL and host pin', () => {
		const config = build();
		expect(config.telegramApiBaseUrl).toBe(
			'https://tg.winwidget.ru/telegram-api'
		);
		expect(config.telegramApiProxyIp).toBe('185.184.122.62');
	});

	it.each([
		['TELEGRAM_API_BASE_URL', 'https://api.telegram.org'],
		['TELEGRAM_API_BASE_URL', 'https://185.184.122.62/telegram-api'],
		['TELEGRAM_API_PROXY_IP', '185.184.122.63'],
		['SUPPORT_WEBHOOK_PUBLIC_URL', 'https://example.test/support-webhook']
	])('fails closed for a non-canonical %s', (name, value) => {
		expect(() => build({ [name]: value })).toThrow();
	});

	it.each([
		'TELEGRAM_SUPPORT_BOT_TOKEN',
		'TELEGRAM_SUPPORT_BOT_USERNAME',
		'TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET'
	])('fails closed when %s is missing', name => {
		expect(() => build({ [name]: undefined })).toThrow();
	});

	it('compares webhook secrets without accepting missing or partial values', () => {
		const config = build();
		expect(() => config.assertWebhookSecret(undefined)).toThrow(
			'SUPPORT_WEBHOOK_SECRET_INVALID'
		);
		expect(() => config.assertWebhookSecret('w'.repeat(47))).toThrow(
			'SUPPORT_WEBHOOK_SECRET_INVALID'
		);
		expect(() => config.assertWebhookSecret('w'.repeat(48))).not.toThrow();
	});

	it('requires only Telegram transport values in the worker role', () => {
		expect(() =>
			build(
				{
					TELEGRAM_SUPPORT_BOT_USERNAME: undefined,
					TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET: undefined,
					SUPPORT_WEBHOOK_PUBLIC_URL: undefined
				},
				'worker'
			)
		).not.toThrow();
	});

	it('rejects Telegram credentials in the Outbox publisher role', () => {
		expect(() => build({}, 'outbox-publisher')).toThrow(
			'must not receive Telegram credentials'
		);
		expect(() =>
			build(
				{
					TELEGRAM_SUPPORT_BOT_TOKEN: undefined,
					TELEGRAM_SUPPORT_BOT_USERNAME: undefined,
					TELEGRAM_SUPPORT_BOT_WEBHOOK_SECRET: undefined,
					SUPPORT_WEBHOOK_PUBLIC_URL: undefined,
					TELEGRAM_API_BASE_URL: undefined,
					TELEGRAM_API_PROXY_IP: undefined
				},
				'outbox-publisher'
			)
		).not.toThrow();
	});
});
