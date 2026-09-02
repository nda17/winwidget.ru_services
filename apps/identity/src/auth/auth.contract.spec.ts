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
import { AuthDto, UpdateUserDto } from './auth.dto';
import { IdentityAuthGuard } from './auth.guard';
import {
	AuthService,
	REFRESH_ROTATION_GRACE_MS,
	RefreshRotationInProgressException
} from './auth.service';
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

function activeUser() {
	const now = new Date('2026-09-02T10:00:00.000Z');
	return {
		id: 'user-id',
		name: 'User',
		password: '',
		avatarPath: null,
		status: UserStatus.ACTIVE,
		personalDataConsentRevokedAt: null,
		deletedAt: null,
		rights: [Role.USER],
		createdAt: now,
		updatedAt: now,
		authIdentities: [],
		telegramNotificationChannel: null
	};
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
	const workspaces = {
		provisionPersonalWorkspace: jest.fn(),
		...overrides.workspaces
	};
	const auth = new AuthService(
		prisma as any,
		users as any,
		jwt as any,
		refreshTokens,
		{ emitUserChanged: jest.fn(), emitBillingRequest: jest.fn() } as any,
		transport as any,
		{ ensureTrial: jest.fn() } as any,
		workspaces as any
	);
	return {
		auth,
		prisma,
		users,
		transport,
		refreshTokens,
		jwt,
		workspaces
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(current => {
		resolve = current;
	});
	return { promise, resolve };
}

function rowMutex() {
	let tail = Promise.resolve();
	return {
		async acquire() {
			const previous = tail;
			let release!: () => void;
			tail = new Promise<void>(current => {
				release = current;
			});
			await previous;
			return release;
		}
	};
}

async function passwordRaceService() {
	const userId = '00000000-0000-4000-8000-000000000002';
	const email = 'user@example.com';
	const now = new Date('2026-08-27T10:00:00.000Z');
	const state = {
		password: await hash('OldPass1', 4),
		sessions: new Map<string, { revokedAt: Date | null }>()
	};
	const mutex = rowMutex();
	const events: string[] = [];
	const hooks: {
		onLoginLocked?: () => void;
		beforeSessionCreate?: () => Promise<void>;
	} = {};
	const currentUser = () => ({
		id: userId,
		name: 'User',
		password: state.password,
		avatarPath: null,
		status: UserStatus.ACTIVE,
		personalDataConsentRevokedAt: null,
		deletedAt: null,
		rights: [Role.USER],
		createdAt: now,
		updatedAt: now,
		authIdentities: [
			{
				id: 'email-identity',
				userId,
				type: 'EMAIL',
				value: email,
				verifiedAt: now,
				createdAt: now,
				updatedAt: now
			}
		],
		telegramNotificationChannel: null
	});
	const transactions: Record<string, any>[] = [];
	const prisma = {
		$transaction: jest.fn(
			async (callback: (transaction: any) => unknown) => {
				let release: () => void = () => undefined;
				const transaction = {
					$queryRaw: jest.fn(async () => {
						release = await mutex.acquire();
						events.push('login-lock');
						hooks.onLoginLocked?.();
						return [{ id: userId }];
					}),
					user: {
						findFirst: jest.fn(async () => {
							events.push('login-read');
							return currentUser();
						})
					},
					userSession: {
						create: jest.fn(async ({ data }: { data: { id: string } }) => {
							await hooks.beforeSessionCreate?.();
							events.push('session-create');
							state.sessions.set(data.id, { revokedAt: null });
							return data;
						})
					}
				};
				transactions.push(transaction);
				try {
					return await callback(transaction);
				} finally {
					release();
				}
			}
		)
	};
	const users = {
		findByIdentity: jest.fn(async () => currentUser())
	};
	const owners = { ensureTrial: jest.fn().mockResolvedValue(undefined) };
	const jwt = { issue: jest.fn().mockReturnValue('access-token') };
	const auth = new AuthService(
		prisma as any,
		users as any,
		jwt as any,
		new RefreshTokenService(),
		{} as any,
		{} as any,
		owners as any,
		{} as any
	);
	const changePassword = async (
		passwordHash: string,
		onLocked?: () => void
	) => {
		const release = await mutex.acquire();
		try {
			events.push('password-lock');
			onLocked?.();
			state.password = passwordHash;
			events.push('password-write');
			for (const session of state.sessions.values()) {
				session.revokedAt = new Date();
			}
			events.push('session-revoke');
		} finally {
			release();
		}
	};
	return {
		auth,
		changePassword,
		events,
		hooks,
		jwt,
		owners,
		state,
		transactions
	};
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

	it('enforces the canonical strong-password policy for an admin reset', async () => {
		const pipe = new ValidationPipe({ whitelist: true, transform: true });
		await expect(
			pipe.transform(
				{ password: '' },
				{ type: 'body', metatype: UpdateUserDto }
			)
		).resolves.toEqual({ password: '' });
		await expect(
			pipe.transform(
				{ password: 'weak' },
				{ type: 'body', metatype: UpdateUserDto }
			)
		).rejects.toThrow();
		await expect(
			pipe.transform(
				{ password: 'Secure1' },
				{ type: 'body', metatype: UpdateUserDto }
			)
		).resolves.toEqual({ password: 'Secure1' });
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

	it.each([
		{
			label: 'email',
			type: VerificationChallengeType.EMAIL,
			value: 'user@example.com',
			register: (auth: AuthService) =>
				auth.registerByEmail({
					email: 'USER@example.com',
					code: '123456'
				})
		},
		{
			label: 'phone',
			type: VerificationChallengeType.PHONE,
			value: '+79991234567',
			register: (auth: AuthService) =>
				auth.registerByPhone({
					phone: '+79991234567',
					password: 'Secure1',
					code: '123456'
				})
		}
	])(
		'provisions the personal workspace inside the $label registration transaction',
		async scenario => {
			const codeHash = await hash('123456', PASSWORD_SALT_ROUNDS);
			const transaction = {
				authIdentity: { findUnique: jest.fn().mockResolvedValue(null) },
				verificationChallenge: {
					deleteMany: jest.fn().mockResolvedValue({ count: 1 })
				},
				user: { create: jest.fn().mockResolvedValue({ id: 'new-user' }) }
			};
			const value = service({
				prisma: {
					$transaction: jest.fn(callback => callback(transaction))
				}
			});
			value.prisma.verificationChallenge.findUnique.mockResolvedValue({
				id: 'challenge',
				type: scenario.type,
				purpose: VerificationChallengePurpose.REGISTER,
				value: scenario.value,
				passwordHash: 'password-hash',
				codeHash,
				attempts: 0,
				expiresAt: new Date(Date.now() + 60_000),
				lastSentAt: new Date()
			});
			jest
				.spyOn(value.auth, 'startSession')
				.mockResolvedValue({ accessToken: 'access' } as never);

			await expect(scenario.register(value.auth)).resolves.toEqual({
				accessToken: 'access'
			});
			expect(
				value.workspaces.provisionPersonalWorkspace
			).toHaveBeenCalledWith(transaction, 'new-user');
			expect(
				transaction.user.create.mock.invocationCallOrder[0]
			).toBeLessThan(
				value.workspaces.provisionPersonalWorkspace.mock
					.invocationCallOrder[0]
			);
		}
	);

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

	it('keeps the shared cookie intact for an in-progress concurrent rotation', async () => {
		const refresh = new RefreshTokenService();
		const auth = {
			refresh: jest
				.fn()
				.mockRejectedValue(new RefreshRotationInProgressException())
		};
		const controller = new AuthController(
			auth as any,
			{} as any,
			refresh,
			{} as any,
			{} as any
		);
		const target = response();

		await expect(
			controller.refreshSession(
				request({ refreshToken: 'old-token' }),
				target
			)
		).rejects.toMatchObject({
			status: 409,
			response: {
				code: 'refresh_rotation_in_progress'
			}
		});
		expect(target.cookie).not.toHaveBeenCalled();
		expect(target.clearCookie).not.toHaveBeenCalled();
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

describe('refresh rotation concurrency contract', () => {
	it('keeps the previous token hash when a refresh rotation wins its CAS', async () => {
		const value = service();
		const token = value.refreshTokens.create(SESSION_ID);
		const currentHash = await hash(
			value.refreshTokens.hashInput(token),
			PASSWORD_SALT_ROUNDS
		);
		value.prisma.userSession.findUnique.mockResolvedValue({
			id: SESSION_ID,
			refreshTokenHash: currentHash,
			previousRefreshTokenHash: null,
			refreshRotatedAt: null,
			revokedAt: null,
			expiresAt: new Date(Date.now() + 60_000),
			user: activeUser()
		});
		value.prisma.userSession.updateMany.mockResolvedValue({ count: 1 });
		value.jwt.issue.mockReturnValue('access-token');

		await expect(value.auth.refresh(token)).resolves.toEqual(
			expect.objectContaining({
				accessToken: 'access-token',
				refreshToken: expect.any(String)
			})
		);
		expect(value.prisma.userSession.updateMany).toHaveBeenCalledWith({
			where: {
				id: SESSION_ID,
				refreshTokenHash: currentHash,
				revokedAt: null,
				expiresAt: { gt: expect.any(Date) }
			},
			data: {
				refreshTokenHash: expect.any(String),
				previousRefreshTokenHash: currentHash,
				refreshRotatedAt: expect.any(Date),
				lastUsedAt: expect.any(Date)
			}
		});
	});

	it('returns 409 without revocation when a concurrent refresh loses its CAS', async () => {
		const value = service();
		const token = value.refreshTokens.create(SESSION_ID);
		const tokenHash = await hash(
			value.refreshTokens.hashInput(token),
			PASSWORD_SALT_ROUNDS
		);
		value.prisma.userSession.findUnique
			.mockResolvedValueOnce({
				id: SESSION_ID,
				refreshTokenHash: tokenHash,
				previousRefreshTokenHash: null,
				refreshRotatedAt: null,
				revokedAt: null,
				expiresAt: new Date(Date.now() + 60_000),
				user: activeUser()
			})
			.mockResolvedValueOnce({
				previousRefreshTokenHash: tokenHash,
				refreshRotatedAt: new Date(),
				revokedAt: null,
				expiresAt: new Date(Date.now() + 60_000)
			});
		value.prisma.userSession.updateMany.mockResolvedValue({ count: 0 });

		await expect(value.auth.refresh(token)).rejects.toBeInstanceOf(
			RefreshRotationInProgressException
		);
		expect(value.prisma.userSession.updateMany).toHaveBeenCalledTimes(1);
		expect(value.jwt.issue).not.toHaveBeenCalled();
	});

	it('returns 409 for the immediately previous token only inside the grace window', async () => {
		const value = service();
		const token = value.refreshTokens.create(SESSION_ID);
		const previousHash = await hash(
			value.refreshTokens.hashInput(token),
			PASSWORD_SALT_ROUNDS
		);
		const currentToken = value.refreshTokens.create(SESSION_ID);
		value.prisma.userSession.findUnique.mockResolvedValue({
			id: SESSION_ID,
			refreshTokenHash: await hash(
				value.refreshTokens.hashInput(currentToken),
				PASSWORD_SALT_ROUNDS
			),
			previousRefreshTokenHash: previousHash,
			refreshRotatedAt: new Date(
				Date.now() - Math.floor(REFRESH_ROTATION_GRACE_MS / 2)
			),
			revokedAt: null,
			expiresAt: new Date(Date.now() + 60_000)
		});

		await expect(value.auth.refresh(token)).rejects.toBeInstanceOf(
			RefreshRotationInProgressException
		);
		expect(value.prisma.userSession.updateMany).not.toHaveBeenCalled();
	});

	it('revokes and fails closed when the previous token is replayed after grace', async () => {
		const value = service();
		const token = value.refreshTokens.create(SESSION_ID);
		const previousHash = await hash(
			value.refreshTokens.hashInput(token),
			PASSWORD_SALT_ROUNDS
		);
		const currentToken = value.refreshTokens.create(SESSION_ID);
		value.prisma.userSession.findUnique.mockResolvedValue({
			id: SESSION_ID,
			refreshTokenHash: await hash(
				value.refreshTokens.hashInput(currentToken),
				PASSWORD_SALT_ROUNDS
			),
			previousRefreshTokenHash: previousHash,
			refreshRotatedAt: new Date(
				Date.now() - REFRESH_ROTATION_GRACE_MS - 1
			),
			revokedAt: null,
			expiresAt: new Date(Date.now() + 60_000)
		});
		value.prisma.userSession.updateMany.mockResolvedValue({ count: 1 });

		await expect(value.auth.refresh(token)).rejects.toEqual(
			new UnauthorizedException('Invalid refresh token')
		);
		expect(value.prisma.userSession.updateMany).toHaveBeenCalledWith({
			where: { id: SESSION_ID, revokedAt: null },
			data: { revokedAt: expect.any(Date) }
		});
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

describe('password login and revocation row-lock contract', () => {
	it('rejects a stale password snapshot when the password mutation locks first', async () => {
		const value = await passwordRaceService();
		const trialStarted = deferred();
		const continueLogin = deferred();
		value.owners.ensureTrial.mockImplementation(async () => {
			trialStarted.resolve();
			await continueLogin.promise;
		});
		const login = value.auth.login({
			email: 'USER@example.com',
			password: 'OldPass1'
		});
		await trialStarted.promise;
		await value.changePassword(await hash('OldPass1', 4));
		continueLogin.resolve();

		await expect(login).rejects.toEqual(
			new UnauthorizedException('Email or password invalid')
		);
		expect(value.state.sessions.size).toBe(0);
		expect(value.jwt.issue).not.toHaveBeenCalled();
		expect(value.events).toEqual([
			'password-lock',
			'password-write',
			'session-revoke',
			'login-lock',
			'login-read'
		]);
		expect(value.transactions[0].$queryRaw).toHaveBeenCalledTimes(1);
	});

	it('lets a password mutation revoke the session when login locks first', async () => {
		const value = await passwordRaceService();
		const loginLocked = deferred();
		const continueSessionCreate = deferred();
		const passwordLocked = deferred();
		let passwordMutationHasLock = false;
		value.hooks.onLoginLocked = loginLocked.resolve;
		value.hooks.beforeSessionCreate = () => continueSessionCreate.promise;
		const login = value.auth.login({
			email: 'user@example.com',
			password: 'OldPass1'
		});
		await loginLocked.promise;
		const passwordChange = value.changePassword(
			await hash('NewPass1', 4),
			() => {
				passwordMutationHasLock = true;
				passwordLocked.resolve();
			}
		);
		await Promise.resolve();
		expect(passwordMutationHasLock).toBe(false);

		continueSessionCreate.resolve();
		await expect(login).resolves.toEqual(
			expect.objectContaining({ accessToken: 'access-token' })
		);
		await passwordLocked.promise;
		await passwordChange;

		expect([...value.state.sessions.values()]).toEqual([
			{ revokedAt: expect.any(Date) }
		]);
		expect(value.events).toEqual([
			'login-lock',
			'login-read',
			'session-create',
			'password-lock',
			'password-write',
			'session-revoke'
		]);
		expect(value.transactions[0].$queryRaw).toHaveBeenCalledTimes(1);
	});
});
