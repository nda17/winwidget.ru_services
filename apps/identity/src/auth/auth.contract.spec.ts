import {
	NotFoundException,
	UnauthorizedException,
	ValidationPipe
} from '@nestjs/common';
import {
	Role,
	UserStatus,
	VerificationChallengePurpose,
	VerificationChallengeType
} from '@prisma/identity-client';
import { hash } from 'bcryptjs';
import type { Request, Response } from 'express';
import { PASSWORD_SALT_ROUNDS } from '../common/identity.util';
import { AuthController } from './auth.controller';
import { AuthDto } from './auth.dto';
import { IdentityAuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { RefreshTokenService } from './refresh-token.service';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';

function request(cookies: Record<string, string> = {}) {
	return { cookies } as Request;
}

function response() {
	return {
		cookie: jest.fn(),
		clearCookie: jest.fn()
	} as unknown as Response;
}

function service(overrides: Record<string, any> = {}) {
	const prisma = {
		verificationChallenge: {
			findUnique: jest.fn(),
			upsert: jest.fn(),
			update: jest.fn(),
			updateMany: jest.fn(),
			deleteMany: jest.fn()
		},
		userSession: {
			findUnique: jest.fn(),
			updateMany: jest.fn()
		},
		$transaction: jest.fn(),
		...overrides.prisma
	};
	const users = {
		findByIdentity: jest.fn().mockResolvedValue(null),
		...overrides.users
	};
	const transport = {
		emailCode: jest.fn(),
		smsCode: jest.fn(),
		newPassword: jest.fn(),
		smsPassword: jest.fn(),
		...overrides.transport
	};
	const refreshTokens = new RefreshTokenService();
	const jwt = { issue: jest.fn(), ...overrides.jwt };
	const auth = new AuthService(
		prisma as any,
		users as any,
		jwt as any,
		refreshTokens,
		{ emitUserChanged: jest.fn(), emitBillingRequest: jest.fn() } as any,
		transport as any,
		{ ensureTrial: jest.fn() } as any
	);
	return { auth, prisma, users, transport, refreshTokens, jwt };
}

describe('public auth frozen contracts', () => {
	it('strips unknown auth fields without globally forbidding them', async () => {
		const pipe = new ValidationPipe({ whitelist: true, transform: true });
		await expect(
			pipe.transform(
				{
					email: 'user@example.com',
					password: 'Secure1',
					unexpected: 'legacy-client-field'
				},
				{ type: 'body', metatype: AuthDto }
			)
		).resolves.toEqual({
			email: 'user@example.com',
			password: 'Secure1'
		});
	});

	it('returns registration and resend timing DTOs instead of booleans', async () => {
		const first = service();
		first.prisma.verificationChallenge.findUnique.mockResolvedValue(null);
		const registered = await first.auth.register({
			email: 'USER@Example.COM',
			password: 'Secure1'
		});
		expect(registered).toEqual({
			email: 'user@example.com',
			expiresAt: expect.any(Date),
			resendAvailableAt: expect.any(Date)
		});
		expect(first.transport.emailCode).toHaveBeenCalledTimes(1);

		const second = service();
		second.prisma.verificationChallenge.findUnique.mockResolvedValue({
			id: 'challenge',
			type: VerificationChallengeType.EMAIL,
			purpose: VerificationChallengePurpose.REGISTER,
			value: 'user@example.com',
			passwordHash: 'hash',
			codeHash: 'hash',
			attempts: 0,
			expiresAt: new Date(Date.now() + 60_000),
			lastSentAt: new Date(Date.now() - 61_000)
		});
		const resent = await second.auth.resendEmailCode({
			email: 'USER@example.com'
		});
		expect(resent).toEqual({
			email: 'user@example.com',
			expiresAt: expect.any(Date),
			resendAvailableAt: expect.any(Date)
		});
	});

	it('persists an invalid verification attempt before throwing', async () => {
		const codeHash = await hash('123456', PASSWORD_SALT_ROUNDS);
		const value = service();
		value.prisma.verificationChallenge.findUnique.mockResolvedValue({
			id: 'challenge',
			type: VerificationChallengeType.EMAIL,
			purpose: VerificationChallengePurpose.REGISTER,
			value: 'user@example.com',
			passwordHash: 'password-hash',
			codeHash,
			attempts: 0,
			expiresAt: new Date(Date.now() + 60_000),
			lastSentAt: new Date()
		});
		value.prisma.verificationChallenge.updateMany.mockResolvedValue({
			count: 1
		});

		await expect(
			value.auth.registerByEmail({
				email: 'user@example.com',
				code: '654321'
			})
		).rejects.toThrow('Email verification code invalid');
		expect(
			value.prisma.verificationChallenge.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({ data: { attempts: { increment: 1 } } })
		);
		expect(value.prisma.$transaction).not.toHaveBeenCalled();
	});

	it('preserves the empty restore request 404 contract', async () => {
		const value = service();
		await expect(value.auth.restorePassword({})).rejects.toEqual(
			new NotFoundException('Email or phone not passed')
		);
	});

	it('atomically updates the password and revokes every active session on restore', async () => {
		const userId = '00000000-0000-4000-8000-000000000002';
		const transaction = {
			user: { update: jest.fn() },
			userSession: { updateMany: jest.fn() }
		};
		const rootUserUpdate = jest.fn();
		const value = service({
			users: {
				findByIdentity: jest.fn().mockResolvedValue({
					id: userId,
					status: UserStatus.ACTIVE,
					deletedAt: null,
					authIdentities: []
				})
			},
			prisma: {
				user: { update: rootUserUpdate },
				$transaction: jest.fn(async callback => callback(transaction))
			}
		});

		await expect(
			value.auth.restorePassword({ email: 'USER@example.com' })
		).resolves.toBeUndefined();

		expect(value.prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(transaction.user.update).toHaveBeenCalledWith({
			where: { id: userId },
			data: { password: expect.any(String) }
		});
		expect(transaction.userSession.updateMany).toHaveBeenCalledWith({
			where: { userId, revokedAt: null },
			data: { revokedAt: expect.any(Date) }
		});
		expect(rootUserUpdate).not.toHaveBeenCalled();
		expect(value.prisma.userSession.updateMany).not.toHaveBeenCalled();
	});
});

describe('refresh cookie fail-closed contract', () => {
	const previousMode = process.env.MODE;
	const previousDomain = process.env.AUTH_COOKIE_DOMAIN;

	beforeEach(() => {
		process.env.MODE = 'production';
		process.env.AUTH_COOKIE_DOMAIN = '.winwidget.ru';
	});

	afterEach(() => {
		if (previousMode === undefined) delete process.env.MODE;
		else process.env.MODE = previousMode;
		if (previousDomain === undefined)
			delete process.env.AUTH_COOKIE_DOMAIN;
		else process.env.AUTH_COOKIE_DOMAIN = previousDomain;
	});

	it('clears the canonical domain cookie on rejected refresh and logout', async () => {
		const refresh = new RefreshTokenService();
		const auth = {
			refresh: jest
				.fn()
				.mockRejectedValue(
					new UnauthorizedException('Invalid refresh token')
				),
			logout: jest.fn().mockResolvedValue(true)
		};
		const controller = new AuthController(
			auth as any,
			{} as any,
			refresh,
			{} as any,
			{} as any
		);
		const rejectedResponse = response();
		await expect(
			controller.refreshSession(
				request({ refreshToken: 'old-token' }),
				rejectedResponse
			)
		).rejects.toThrow('Invalid refresh token');
		expect(rejectedResponse.cookie).toHaveBeenCalledWith(
			'refreshToken',
			'',
			expect.objectContaining({
				domain: '.winwidget.ru',
				httpOnly: true,
				secure: true,
				sameSite: 'none',
				path: '/'
			})
		);
		expect(rejectedResponse.cookie).toHaveBeenCalledTimes(1);

		const logoutResponse = response();
		await expect(
			controller.logout(
				request({ refreshToken: 'old-token' }),
				logoutResponse
			)
		).resolves.toBe(true);
		expect(logoutResponse.cookie).toHaveBeenCalledTimes(1);
	});

	it('clears the canonical cookie when the current session is revoked', async () => {
		const refresh = new RefreshTokenService();
		const auth = {
			revokeSession: jest
				.fn()
				.mockResolvedValue({ currentSessionRevoked: true }),
			revokeAll: jest.fn().mockResolvedValue(true)
		};
		const controller = new AuthController(
			auth as any,
			{} as any,
			refresh,
			{} as any,
			{} as any
		);
		const one = response();
		await expect(
			controller.revoke('user', 'current', 'current', one)
		).resolves.toEqual({ currentSessionRevoked: true });
		expect(one.cookie).toHaveBeenCalledTimes(1);

		const all = response();
		await expect(controller.revokeAll('user', all)).resolves.toBe(true);
		expect(all.cookie).toHaveBeenCalledTimes(1);
	});
});

describe('revoked session fail-closed contract', () => {
	it('rejects the pre-change refresh token after its session is revoked', async () => {
		const value = service();
		const token = value.refreshTokens.create(SESSION_ID);
		value.prisma.userSession.findUnique.mockResolvedValue({
			id: SESSION_ID,
			revokedAt: new Date(),
			expiresAt: new Date(Date.now() + 60_000),
			refreshTokenHash: 'revoked-token-hash'
		});

		await expect(value.auth.refresh(token)).rejects.toEqual(
			new UnauthorizedException('Invalid refresh token')
		);
		expect(value.prisma.userSession.updateMany).not.toHaveBeenCalled();
		expect(value.jwt.issue).not.toHaveBeenCalled();
	});

	it('rejects the pre-change bearer token when its session is revoked', async () => {
		const prisma = {
			userSession: { findFirst: jest.fn().mockResolvedValue(null) }
		};
		const jwt = {
			verify: jest.fn().mockReturnValue({
				sub: 'user-id',
				sid: SESSION_ID
			})
		};
		const guard = new IdentityAuthGuard(
			{
				getAllAndOverride: jest.fn().mockReturnValue([Role.USER])
			} as any,
			jwt as any,
			prisma as any
		);
		const context = {
			getHandler: jest.fn(),
			getClass: jest.fn(),
			switchToHttp: () => ({
				getRequest: () => ({
					headers: { authorization: 'Bearer access-token' }
				})
			})
		};

		await expect(guard.canActivate(context as any)).rejects.toEqual(
			new UnauthorizedException('Invalid session')
		);
		expect(prisma.userSession.findFirst).toHaveBeenCalledWith({
			where: {
				id: SESSION_ID,
				userId: 'user-id',
				revokedAt: null,
				expiresAt: { gt: expect.any(Date) }
			},
			include: { user: true }
		});
	});
});
