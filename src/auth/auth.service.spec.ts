import { AuthService } from '@/auth/auth.service';
import {
	createOpaqueRefreshToken,
	getOpaqueRefreshTokenHashInput,
	parseOpaqueRefreshToken
} from '@/auth/opaque-refresh-token';
import { UnauthorizedException } from '@nestjs/common';
import { Role, UserStatus, type UserSession } from '@prisma/client';
import { compare, hash } from 'bcryptjs';
import { randomBytes, randomUUID } from 'node:crypto';

describe('AuthService opaque refresh sessions', () => {
	it('rotates the opaque refresh token and its bcrypt hash', async () => {
		const fixture = await createFixture();

		const result = await fixture.service.refreshSession(
			fixture.refreshToken
		);

		expect(result).toMatchObject({
			user: { id: fixture.user.id },
			accessToken: 'new-access-token'
		});
		expect(result.refreshToken).not.toBe(fixture.refreshToken);
		expect(parseOpaqueRefreshToken(result.refreshToken)).toEqual({
			sessionId: fixture.session.id
		});
		const rotation = fixture.updateMany.mock.calls[0][0];
		expect(rotation.where).toMatchObject({
			id: fixture.session.id,
			userId: fixture.user.id,
			refreshTokenHash: fixture.session.refreshTokenHash,
			revokedAt: null
		});
		expect(rotation.data.lastUsedAt).toBeInstanceOf(Date);
		expect(
			await compare(
				getOpaqueRefreshTokenHashInput(result.refreshToken),
				rotation.data.refreshTokenHash
			)
		).toBe(true);
		expect(fixture.accessJwtService.issueAccessToken).toHaveBeenCalledWith(
			fixture.user.id,
			fixture.user.rights,
			fixture.session.id
		);
	});

	it('rejects a stale or forged refresh token without allowing session-id DoS', async () => {
		const fixture = await createFixture();
		const result = await fixture.service.refreshSession(
			fixture.refreshToken
		);
		const rotation = fixture.updateMany.mock.calls[0][0];

		fixture.session.refreshTokenHash = rotation.data.refreshTokenHash;

		await expect(
			fixture.service.refreshSession(fixture.refreshToken)
		).rejects.toBeInstanceOf(UnauthorizedException);
		expect(result.refreshToken).not.toBe(fixture.refreshToken);
		expect(fixture.updateMany).toHaveBeenCalledTimes(1);
	});

	it('revokes the session when refresh rotation loses the CAS race', async () => {
		const fixture = await createFixture();
		fixture.updateMany
			.mockResolvedValueOnce({ count: 0 })
			.mockResolvedValueOnce({ count: 1 });

		await expect(
			fixture.service.refreshSession(fixture.refreshToken)
		).rejects.toBeInstanceOf(UnauthorizedException);
		expect(fixture.updateMany).toHaveBeenCalledTimes(2);
		expect(fixture.updateMany).toHaveBeenLastCalledWith({
			where: {
				id: fixture.session.id,
				revokedAt: null
			},
			data: {
				revokedAt: expect.any(Date)
			}
		});
	});

	it('compares the current refresh hash before logout revokes a session', async () => {
		const fixture = await createFixture();
		const invalidToken = `${fixture.session.id}.${randomBytes(32).toString(
			'base64url'
		)}`;

		await expect(fixture.service.logout(invalidToken)).resolves.toBe(true);
		expect(fixture.updateMany).not.toHaveBeenCalled();

		await expect(
			fixture.service.logout(fixture.refreshToken)
		).resolves.toBe(true);
		expect(fixture.updateMany).toHaveBeenCalledWith({
			where: {
				id: fixture.session.id,
				refreshTokenHash: fixture.session.refreshTokenHash,
				revokedAt: null
			},
			data: {
				revokedAt: expect.any(Date)
			}
		});
	});

	it('hashes all refresh-token bytes before bcrypt', async () => {
		const fixture = await createFixture();
		const lastCharacter = fixture.refreshToken.at(-1);
		const forgedToken = `${fixture.refreshToken.slice(0, -1)}${
			lastCharacter === 'A' ? 'B' : 'A'
		}`;

		expect(forgedToken.slice(0, 72)).toBe(
			fixture.refreshToken.slice(0, 72)
		);
		await expect(
			fixture.service.refreshSession(forgedToken)
		).rejects.toBeInstanceOf(UnauthorizedException);
		expect(fixture.updateMany).not.toHaveBeenCalled();
	});

	it('rejects legacy JWT refresh tokens before querying a session', async () => {
		const fixture = await createFixture();

		await expect(
			fixture.service.refreshSession('legacy.jwt.refresh')
		).rejects.toBeInstanceOf(UnauthorizedException);
		expect(fixture.findUnique).not.toHaveBeenCalled();
	});
});

const createFixture = async () => {
	const sessionId = randomUUID();
	const refreshToken = createOpaqueRefreshToken(sessionId);
	const session: UserSession = {
		id: sessionId,
		userId: 'user-id',
		refreshTokenHash: await hash(
			getOpaqueRefreshTokenHashInput(refreshToken),
			4
		),
		userAgent: null,
		ipAddress: null,
		expiresAt: new Date(Date.now() + 60_000),
		lastUsedAt: new Date(),
		revokedAt: null,
		createdAt: new Date()
	};
	const user = {
		id: session.userId,
		status: UserStatus.ACTIVE,
		rights: [Role.USER]
	};
	const findUnique = jest.fn().mockImplementation(async ({ where }) => {
		return where.id === session.id ? session : null;
	});
	const updateMany = jest.fn().mockResolvedValue({ count: 1 });
	const prisma = {
		userSession: {
			findUnique,
			updateMany
		}
	};
	const accessJwtService = {
		issueAccessToken: jest.fn().mockReturnValue('new-access-token')
	};
	const userService = {
		getUserById: jest.fn().mockResolvedValue(user),
		toPublicUser: jest.fn().mockReturnValue({ id: user.id })
	};
	const service = new AuthService(
		accessJwtService as never,
		userService as never,
		{} as never,
		prisma as never,
		{} as never,
		{} as never
	);

	return {
		service,
		session,
		user,
		refreshToken,
		findUnique,
		updateMany,
		accessJwtService
	};
};
