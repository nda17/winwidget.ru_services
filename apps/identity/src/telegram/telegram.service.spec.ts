import { ConfigService } from '@nestjs/config';
import { ForbiddenException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
	AuthIdentityType,
	Role,
	UserStatus,
	VerificationChallengePurpose,
	VerificationChallengeType
} from '@prisma/identity-client';
import { hash } from 'bcryptjs';
import type { Request } from 'express';
import { PASSWORD_SALT_ROUNDS } from '../common/identity.util';
import { TelegramAdminController } from './telegram.controller';
import { TelegramService } from './telegram.service';

const NOW = new Date('2026-08-14T10:00:00.000Z');

function challenge(overrides: Record<string, any> = {}) {
	return {
		id: 'challenge',
		userId: null,
		type: VerificationChallengeType.TELEGRAM,
		purpose: VerificationChallengePurpose.LOGIN,
		value: 'request-id',
		passwordHash: null,
		codeHash: 'hash',
		attempts: 0,
		expiresAt: new Date(Date.now() + 60_000),
		lastSentAt: NOW,
		telegramUserId: '777',
		telegramChatId: null,
		telegramUsername: 'telegram-user',
		telegramFirstName: 'Telegram',
		telegramLastName: 'User',
		createdAt: NOW,
		updatedAt: NOW,
		...overrides
	};
}

function createService(
	challengeValue: Record<string, any>,
	config: Record<string, string> = {}
) {
	const configValues = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined
		)
	);
	Object.assign(configValues, config);
	for (const key of ['MODE', 'TELEGRAM_API_BASE_URL']) {
		if (!Object.prototype.hasOwnProperty.call(config, key)) {
			delete configValues[key];
		}
	}
	const tx = {
		verificationChallenge: {
			findUnique: jest.fn().mockResolvedValue(challengeValue),
			delete: jest.fn(),
			update: jest.fn()
		},
		authIdentity: { findUnique: jest.fn() },
		user: { create: jest.fn(), findFirst: jest.fn() }
	};
	const prisma = {
		verificationChallenge: {
			deleteMany: jest.fn(),
			create: jest.fn(),
			update: jest.fn(),
			findFirst: jest.fn()
		},
		$transaction: jest.fn(
			(callback: (transaction: typeof tx) => unknown) => callback(tx)
		)
	};
	const auth = { startSession: jest.fn() };
	const settings = { assertProviderEnabled: jest.fn() };
	const events = {
		emitUserChanged: jest.fn(),
		emitBillingRequest: jest.fn(),
		emitAudit: jest.fn()
	};
	const service = new TelegramService(
		{ get: (key: string) => configValues[key] } as ConfigService,
		prisma as any,
		events as any,
		settings as any,
		auth as any
	);
	return { service, prisma, tx, auth, settings, events };
}

describe('Identity Telegram API routing', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('routes bot calls through the pinned HTTPS reverse proxy', async () => {
		const value = createService(challenge(), {
			MODE: 'production',
			TELEGRAM_API_BASE_URL: 'https://tg.winwidget.ru/telegram-api'
		});
		const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: jest.fn().mockResolvedValue({ ok: true })
		} as unknown as Response);

		await (value.service as any).telegramApi('identity-token', 'getMe');

		expect(fetchMock.mock.calls[0][0]).toBe(
			'https://tg.winwidget.ru/telegram-api/botidentity-token/getMe'
		);
	});

	it.each([
		undefined,
		'https://api.telegram.org',
		'https://api.telegram.org:8443',
		'https://tg.winwidget.ru/telegram-api/',
		'https://tg.winwidget.ru/telegram-api?target=other',
		'https://tg.winwidget.ru/telegram-api#fragment'
	])('rejects a direct production endpoint: %s', async apiBaseUrl => {
		const value = createService(challenge(), {
			MODE: 'production',
			...(apiBaseUrl ? { TELEGRAM_API_BASE_URL: apiBaseUrl } : {})
		});

		await expect(
			(value.service as any).telegramApi('identity-token', 'getMe')
		).rejects.toThrow('Telegram API configuration is invalid');
	});
});

describe('Telegram Auth confirmation contract', () => {
	it('does not create a session after /start until callback confirmation', async () => {
		const value = createService(challenge());
		await expect(
			value.service.completeLogin('request-id', undefined, {} as Request)
		).resolves.toEqual({ confirmed: false });
		expect(value.auth.startSession).not.toHaveBeenCalled();
		expect(value.tx.verificationChallenge.delete).not.toHaveBeenCalled();
	});

	it('keeps the explicit code verification path consumable without callback', async () => {
		const codeHash = await hash('123456', PASSWORD_SALT_ROUNDS);
		const value = createService(challenge({ codeHash }));
		const existingUser = {
			id: 'user',
			name: 'User',
			password: '',
			avatarPath: null,
			status: UserStatus.ACTIVE,
			personalDataConsentRevokedAt: null,
			deletedAt: null,
			rights: [Role.USER],
			createdAt: NOW,
			updatedAt: NOW,
			authIdentities: [
				{
					type: AuthIdentityType.TELEGRAM,
					value: '777',
					verifiedAt: NOW
				}
			],
			telegramNotificationChannel: null
		};
		value.tx.authIdentity.findUnique.mockResolvedValue({
			userId: 'user',
			user: existingUser
		});
		value.auth.startSession.mockResolvedValue({ accessToken: 'access' });
		await expect(
			value.service.verifyLogin(
				'request-id',
				'123456',
				undefined,
				{} as Request
			)
		).resolves.toEqual({ accessToken: 'access' });
		expect(value.tx.verificationChallenge.delete).toHaveBeenCalledWith({
			where: { id: 'challenge' }
		});
	});

	it('commits a failed code attempt before returning the 401 error', async () => {
		const codeHash = await hash('123456', PASSWORD_SALT_ROUNDS);
		const value = createService(challenge({ codeHash }));
		await expect(
			value.service.verifyLogin(
				'request-id',
				'654321',
				undefined,
				{} as Request
			)
		).rejects.toThrow('Telegram verification code invalid');
		expect(value.tx.verificationChallenge.update).toHaveBeenCalledWith({
			where: { id: 'challenge' },
			data: { attempts: 1 }
		});
		expect(value.prisma.$transaction).toHaveBeenCalledTimes(1);
	});

	it('rejects verify and complete when disabled during the flow but leaves cancel available', async () => {
		const value = createService(challenge());
		value.settings.assertProviderEnabled.mockRejectedValue(
			new ForbiddenException('Telegram auth is disabled')
		);

		await expect(
			value.service.verifyLogin(
				'request-id',
				'123456',
				undefined,
				{} as Request
			)
		).rejects.toThrow('Telegram auth is disabled');
		await expect(
			value.service.completeLogin('request-id', undefined, {} as Request)
		).rejects.toThrow('Telegram auth is disabled');
		await expect(value.service.cancelLogin('request-id')).resolves.toEqual(
			{
				cancelled: true
			}
		);

		expect(value.settings.assertProviderEnabled).toHaveBeenCalledTimes(2);
		expect(value.prisma.$transaction).not.toHaveBeenCalled();
		expect(
			value.prisma.verificationChallenge.deleteMany
		).toHaveBeenCalledWith({
			where: {
				type: VerificationChallengeType.TELEGRAM,
				purpose: VerificationChallengePurpose.LOGIN,
				value: 'request-id'
			}
		});
	});

	it('returns the frozen admin settings DTO and public start shape', async () => {
		const previousToken = process.env.TELEGRAM_AUTH_BOT_TOKEN;
		const previousUsername = process.env.TELEGRAM_AUTH_BOT_USERNAME;
		process.env.TELEGRAM_AUTH_BOT_TOKEN = 'configured-token';
		process.env.TELEGRAM_AUTH_BOT_USERNAME = '@Auth_bot';
		try {
			const value = createService(challenge());
			expect(value.service.adminSettings()).toEqual({
				authTelegramBotTokenConfigured: true,
				authTelegramBotUsernameConfigured: true
			});
			const started = await value.service.startLogin();
			expect(started).toEqual({
				requestId: expect.any(String),
				botUrl: expect.stringMatching(
					/^https:\/\/t\.me\/Auth_bot\?start=/
				),
				expiresAt: expect.stringMatching(/Z$/)
			});
		} finally {
			if (previousToken === undefined)
				delete process.env.TELEGRAM_AUTH_BOT_TOKEN;
			else process.env.TELEGRAM_AUTH_BOT_TOKEN = previousToken;
			if (previousUsername === undefined)
				delete process.env.TELEGRAM_AUTH_BOT_USERNAME;
			else process.env.TELEGRAM_AUTH_BOT_USERNAME = previousUsername;
		}
	});
});

describe('Telegram Info admin webhook contract', () => {
	const environmentKeys = [
		'TELEGRAM_INFO_BOT_TOKEN',
		'TELEGRAM_INFO_BOT_USERNAME',
		'TELEGRAM_INFO_BOT_WEBHOOK_SECRET',
		'TELEGRAM_WEBHOOK_HOST'
	] as const;
	let previousEnvironment: Record<string, string | undefined>;

	beforeEach(() => {
		previousEnvironment = Object.fromEntries(
			environmentKeys.map(key => [key, process.env[key]])
		);
		process.env.TELEGRAM_INFO_BOT_TOKEN = 'configured-info-token';
		process.env.TELEGRAM_INFO_BOT_USERNAME = '@winwidget_info_bot';
		process.env.TELEGRAM_INFO_BOT_WEBHOOK_SECRET =
			'configured-info-webhook-secret';
		process.env.TELEGRAM_WEBHOOK_HOST = 'https://api.winwidget.ru';
	});

	afterEach(() => {
		jest.restoreAllMocks();
		for (const key of environmentKeys) {
			const value = previousEnvironment[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it('reads Info_bot status without changing the Telegram webhook', async () => {
		const fetchMock = jest
			.spyOn(global, 'fetch')
			.mockImplementation(async input => {
				const url = String(input);
				const result = url.endsWith('/getWebhookInfo')
					? {
							url: 'https://api.winwidget.ru/api/v1/telegram-bot/webhook',
							pending_update_count: 0,
							allowed_updates: ['message']
						}
					: { username: 'winwidget_info_bot' };
				return new Response(JSON.stringify({ ok: true, result }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			});
		const value = createService(challenge());

		await expect(value.service.infoWebhookStatus()).resolves.toEqual(
			expect.objectContaining({
				bot: 'info',
				title: 'Info_bot',
				configured: true,
				ok: true,
				expectedWebhookUrl:
					'https://api.winwidget.ru/api/v1/telegram-bot/webhook',
				webhookMatchesExpected: true,
				secretConfigured: true,
				configuredUsername: 'winwidget_info_bot',
				actualUsername: 'winwidget_info_bot',
				usernameMatchesConfigured: true,
				allowedUpdates: ['message']
			})
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(
			fetchMock.mock.calls.some(([input]) =>
				String(input).endsWith('/setWebhook')
			)
		).toBe(false);
	});

	it('reinstalls Info_bot through Identity and emits the audit event', async () => {
		const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(
			async () =>
				new Response(JSON.stringify({ ok: true, result: {} }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
		);
		const value = createService(challenge());
		const request = {
			headers: {},
			header: jest.fn(),
			get: jest.fn(),
			ip: '127.0.0.1'
		} as unknown as Request;

		await expect(
			value.service.reinstallInfoWebhook('admin-id', request)
		).resolves.toEqual(
			expect.objectContaining({
				bot: 'info',
				title: 'Info_bot',
				webhookUrl: 'https://api.winwidget.ru/api/v1/telegram-bot/webhook',
				dropPendingUpdates: true,
				allowedUpdates: ['message'],
				secretConfigured: true
			})
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
			url: 'https://api.winwidget.ru/api/v1/telegram-bot/webhook',
			drop_pending_updates: true,
			max_connections: 40,
			allowed_updates: ['message'],
			secret_token: 'configured-info-webhook-secret'
		});
		expect(value.events.emitAudit).toHaveBeenCalledWith(
			value.tx,
			expect.objectContaining({
				actorId: 'admin-id',
				entityId: 'info',
				entityLabel: 'Info_bot',
				description: 'Переустановлен webhook Info_bot',
				metadata: {
					bot: 'info',
					title: 'Info_bot',
					dropPendingUpdates: true,
					allowedUpdates: ['message'],
					secretConfigured: true,
					installedAt: expect.stringMatching(/Z$/)
				}
			})
		);
	});
});

describe('Telegram Info admin route contract', () => {
	it('keeps Info_bot admin operations under the routed Identity prefix', () => {
		expect(
			Reflect.getMetadata(PATH_METADATA, TelegramAdminController)
		).toBe('telegram-auth/admin');
		expect(
			Reflect.getMetadata(
				PATH_METADATA,
				TelegramAdminController.prototype.infoStatus
			)
		).toBe('info-webhook/status');
		expect(
			Reflect.getMetadata(
				METHOD_METADATA,
				TelegramAdminController.prototype.infoStatus
			)
		).toBe(RequestMethod.GET);
		expect(
			Reflect.getMetadata(
				PATH_METADATA,
				TelegramAdminController.prototype.reinstallInfo
			)
		).toBe('info-webhook/reinstall');
		expect(
			Reflect.getMetadata(
				METHOD_METADATA,
				TelegramAdminController.prototype.reinstallInfo
			)
		).toBe(RequestMethod.POST);
	});
});
