import { AccessJwtService } from '@/auth/access-jwt.service';
import { PrismaService } from '@/prisma.service';
import { UnauthorizedException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { WidgetsAuthIntrospectionService } from './widgets-auth-introspection.service';

describe('WidgetsAuthIntrospectionService', () => {
	const payload = {
		sub: 'user-1',
		sid: '00000000-0000-4000-8000-000000000001'
	};
	const verifyAccessToken = jest.fn().mockReturnValue(payload);
	const findFirst = jest.fn();
	const service = new WidgetsAuthIntrospectionService(
		{ verifyAccessToken } as unknown as AccessJwtService,
		{ userSession: { findFirst } } as unknown as PrismaService
	);

	beforeEach(() => jest.clearAllMocks());

	it('returns current database roles for an active session', async () => {
		findFirst.mockResolvedValue({
			id: payload.sid,
			user: { id: payload.sub, rights: [Role.ADMIN] }
		});

		await expect(
			service.introspect('Bearer signed-access-token')
		).resolves.toEqual({
			active: true,
			subject: payload.sub,
			sessionId: payload.sid,
			roles: [Role.ADMIN]
		});
		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: payload.sid,
					userId: payload.sub,
					revokedAt: null,
					user: { status: 'ACTIVE', deletedAt: null }
				})
			})
		);
	});

	it('rejects malformed bearer tokens and revoked sessions', async () => {
		await expect(service.introspect(undefined)).rejects.toBeInstanceOf(
			UnauthorizedException
		);
		findFirst.mockResolvedValue(null);
		await expect(
			service.introspect('Bearer signed-access-token')
		).rejects.toBeInstanceOf(UnauthorizedException);
	});
});
