import { AccessJwtService } from '@/auth/access-jwt.service';
import { PrismaService } from '@/prisma.service';
import { UnauthorizedException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CampaignsAuthIntrospectionService } from './campaigns-auth-introspection.service';

describe('CampaignsAuthIntrospectionService', () => {
	const payload = {
		sub: 'user-1',
		sid: '00000000-0000-4000-8000-000000000001'
	};
	const verifyAccessToken = jest.fn().mockReturnValue(payload);
	const findFirst = jest.fn();
	const service = new CampaignsAuthIntrospectionService(
		{ verifyAccessToken } as unknown as AccessJwtService,
		{
			userSession: { findFirst }
		} as unknown as PrismaService
	);

	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('returns current database roles for an active session', async () => {
		findFirst.mockResolvedValue({
			id: payload.sid,
			user: {
				id: payload.sub,
				rights: [Role.USER, Role.ADMIN]
			}
		});

		await expect(
			service.introspect('Bearer signed-access-token')
		).resolves.toEqual({
			active: true,
			subject: payload.sub,
			sessionId: payload.sid,
			roles: [Role.USER, Role.ADMIN]
		});
		expect(verifyAccessToken).toHaveBeenCalledWith('signed-access-token');
		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: payload.sid,
					userId: payload.sub,
					revokedAt: null
				})
			})
		);
	});

	it('does not trust roles embedded in the access token', async () => {
		verifyAccessToken.mockReturnValueOnce({
			...payload,
			roles: [Role.ADMIN]
		});
		findFirst.mockResolvedValue({
			id: payload.sid,
			user: {
				id: payload.sub,
				rights: [Role.USER]
			}
		});

		await expect(
			service.introspect('Bearer signed-access-token')
		).resolves.toMatchObject({ roles: [Role.USER] });
	});

	it('rejects malformed authorization and inactive sessions', async () => {
		await expect(service.introspect(undefined)).rejects.toBeInstanceOf(
			UnauthorizedException
		);
		await expect(
			service.introspect('Bearer token extra')
		).rejects.toBeInstanceOf(UnauthorizedException);

		findFirst.mockResolvedValue(null);
		await expect(
			service.introspect('Bearer signed-access-token')
		).rejects.toBeInstanceOf(UnauthorizedException);
	});
});
