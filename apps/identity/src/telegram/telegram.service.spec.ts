import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
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

function createService(challengeValue: Record<string, any>) {
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
	const service = new TelegramService(
		new ConfigService(),
		prisma as any,
		{ emitUserChanged: jest.fn(), emitBillingRequest: jest.fn() } as any,
		settings as any,
		auth as any
	);
	return { service, prisma, tx, auth, settings };
}

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
