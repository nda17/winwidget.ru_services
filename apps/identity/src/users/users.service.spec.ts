import {
	BadRequestException,
	ForbiddenException,
	UnauthorizedException
} from '@nestjs/common';
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
import { UsersService } from './users.service';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-08-14T10:00:00.000Z');

function user(overrides: Record<string, any> = {}) {
	return {
		id: USER_ID,
		name: 'User',
		password: 'hash',
		avatarPath: '/old.png',
		status: UserStatus.ACTIVE,
		personalDataConsentRevokedAt: null,
		deletedAt: null,
		rights: [Role.USER],
		createdAt: NOW,
		updatedAt: NOW,
		authIdentities: [],
		telegramNotificationChannel: null,
		...overrides
	};
}

function request(): Request {
	return {
		header: jest.fn(),
		get: jest.fn(),
		headers: {},
		socket: { remoteAddress: '127.0.0.1' }
	} as unknown as Request;
}

function createService(transaction?: Record<string, any>) {
	const tx = {
		user: {
			findUnique: jest.fn(),
			findUniqueOrThrow: jest.fn(),
			update: jest.fn(),
			findFirst: jest.fn(),
			count: jest.fn()
		},
		userSession: { updateMany: jest.fn() },
		authIdentity: {
			upsert: jest.fn(),
			deleteMany: jest.fn(),
			findUnique: jest.fn()
		},
		verificationChallenge: {
			findUnique: jest.fn(),
			updateMany: jest.fn(),
			deleteMany: jest.fn()
		},
		...transaction
	};
	const prisma = {
		user: {
			findUnique: jest.fn(),
			findMany: jest.fn().mockResolvedValue([]),
			count: jest.fn().mockResolvedValue(0)
		},
		userSession: { updateMany: jest.fn() },
		authIdentity: { findFirst: jest.fn() },
		verificationChallenge: {
			findUnique: jest.fn(),
			updateMany: jest.fn(),
			deleteMany: jest.fn(),
			upsert: jest.fn()
		},
		$transaction: jest.fn(async (input: any) =>
			typeof input === 'function' ? input(tx) : Promise.all(input)
		)
	};
	const events = {
		emitUserChanged: jest.fn(),
		emitAudit: jest.fn(),
		emitBillingRequest: jest.fn()
	};
	const owners = {
		subscriptionUserIds: jest.fn(),
		revokeEntitlements: jest.fn(),
		billingOverview: jest.fn(),
		widgetsOverview: jest.fn(),
		adminOverview: jest.fn()
	};
	const service = new UsersService(
		prisma as any,
		events as any,
		{ emailCode: jest.fn(), smsCode: jest.fn() } as any,
		owners as any
	);
	return { service, prisma, tx, events, owners };
}

describe('UsersService security and frozen contracts', () => {
	it('revokes every other session transactionally on self password change', async () => {
		const value = createService();
		value.tx.user.update.mockResolvedValue(user());
		await expect(
			value.service.updateProfile(
				USER_ID,
				'current-session',
				{ password: 'Secure1' },
				request()
			)
		).resolves.toBe(true);
		expect(value.tx.userSession.updateMany).toHaveBeenCalledWith({
			where: {
				userId: USER_ID,
				id: { not: 'current-session' },
				revokedAt: null
			},
			data: { revokedAt: expect.any(Date) }
		});
		expect(value.events.emitUserChanged).toHaveBeenCalled();
	});

	it('rejects admin PATCH for a soft-deleted user before mutation', async () => {
		const value = createService();
		value.tx.user.findUnique.mockResolvedValue(user({ deletedAt: NOW }));
		await expect(
			value.service.adminUpdate(
				'admin',
				[Role.DEV],
				USER_ID,
				{ name: 'Changed' },
				request()
			)
		).rejects.toEqual(new BadRequestException('Пользователь уже удалён'));
		expect(value.tx.user.update).not.toHaveBeenCalled();
		expect(value.events.emitUserChanged).not.toHaveBeenCalled();
	});

	it('rejects DEV self-demotion even when another DEV exists', async () => {
		const value = createService();
		value.tx.user.findUnique.mockResolvedValue(
			user({ rights: [Role.USER, Role.ADMIN, Role.DEV] })
		);
		value.tx.user.count.mockResolvedValue(2);
		await expect(
			value.service.adminUpdate(
				USER_ID,
				[Role.DEV],
				USER_ID,
				{ isDev: false },
				request()
			)
		).rejects.toEqual(
			new ForbiddenException(
				'Нельзя снять роль DEV с собственной учётной записи'
			)
		);
		expect(value.tx.user.count).not.toHaveBeenCalled();
	});

	it('preserves avatarPath when admin sends an empty string', async () => {
		const value = createService();
		const current = user();
		value.tx.user.findUnique.mockResolvedValue(current);
		value.tx.user.findUniqueOrThrow.mockResolvedValue(current);
		await value.service.adminUpdate(
			'admin',
			[Role.ADMIN],
			USER_ID,
			{ avatarPath: '' },
			request()
		);
		expect(value.tx.user.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ avatarPath: '/old.png' })
			})
		);
	});

	it('searches only name and EMAIL/PHONE identities and clamps unsafe paging', async () => {
		const value = createService();
		const result = await value.service.list({
			page: Number.POSITIVE_INFINITY,
			limit: 1.5,
			searchTerm: 'provider-secret-id'
		});
		expect(result).toMatchObject({ page: 1, limit: 20 });
		const query = value.prisma.user.findMany.mock.calls[0]?.[0];
		expect(query).toMatchObject({
			skip: 0,
			take: 20,
			where: {
				OR: expect.arrayContaining([
					expect.objectContaining({
						authIdentities: {
							some: {
								type: {
									in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE]
								},
								value: {
									contains: 'provider-secret-id',
									mode: 'insensitive'
								}
							}
						}
					})
				])
			}
		});
	});

	it('commits a failed profile-binding attempt outside the success transaction', async () => {
		const value = createService();
		const codeHash = await hash('123456', PASSWORD_SALT_ROUNDS);
		value.prisma.verificationChallenge.findUnique.mockResolvedValue({
			id: 'challenge',
			userId: USER_ID,
			type: VerificationChallengeType.PHONE,
			purpose: VerificationChallengePurpose.BIND_IDENTITY,
			value: '+79991234567',
			codeHash,
			passwordHash: null,
			attempts: 0,
			expiresAt: new Date(Date.now() + 60_000),
			lastSentAt: new Date(),
			telegramUserId: null,
			telegramChatId: null,
			telegramUsername: null,
			telegramFirstName: null,
			telegramLastName: null,
			createdAt: NOW,
			updatedAt: NOW
		});
		value.prisma.verificationChallenge.updateMany.mockResolvedValue({
			count: 1
		});
		await expect(
			value.service.verifyPhoneBinding(USER_ID, {
				phone: '+79991234567',
				code: '654321'
			})
		).rejects.toEqual(
			new UnauthorizedException('Phone verification code invalid')
		);
		expect(
			value.prisma.verificationChallenge.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({ data: { attempts: 1 } })
		);
		expect(value.prisma.$transaction).not.toHaveBeenCalled();
	});
});
