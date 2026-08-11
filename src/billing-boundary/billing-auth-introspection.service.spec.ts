import { BillingAuthIntrospectionService } from './billing-auth-introspection.service';
import type { AccessJwtService } from '@/auth/access-jwt.service';
import type { PrismaService } from '@/prisma.service';
import { USER_DEACTIVATED_MESSAGE } from '@/utils/auth.constants';
import { Role, UserStatus } from '@prisma/client';

describe('BillingAuthIntrospectionService', () => {
	const createService = () => {
		const accessJwt = {
			verifyAccessToken: jest.fn().mockReturnValue({
				sub: 'user-1',
				sid: 'session-1',
				roles: [Role.USER]
			})
		} as unknown as AccessJwtService;
		const prisma = {
			userSession: {
				findFirst: jest.fn().mockResolvedValue({ id: 'session-1' })
			},
			user: {
				findUnique: jest.fn().mockResolvedValue({
					id: 'user-1',
					status: UserStatus.ACTIVE,
					deletedAt: null,
					rights: [Role.USER, Role.ADMIN]
				})
			}
		} as unknown as PrismaService;
		return {
			service: new BillingAuthIntrospectionService(accessJwt, prisma),
			accessJwt,
			prisma
		};
	};

	it('checks the session first and preserves the legacy invalid-session error', async () => {
		const { service, prisma } = createService();
		(prisma.userSession.findFirst as jest.Mock).mockResolvedValue(null);

		await expect(
			service.introspect('Bearer access-token')
		).rejects.toThrow('Invalid session');
		expect(prisma.user.findUnique).not.toHaveBeenCalled();
	});

	it.each([
		{ status: UserStatus.DEACTIVATED, deletedAt: null },
		{ status: UserStatus.ACTIVE, deletedAt: new Date() }
	])(
		'preserves the deactivated-user error after a valid session',
		async state => {
			const { service, prisma } = createService();
			(prisma.user.findUnique as jest.Mock).mockResolvedValue({
				id: 'user-1',
				rights: [Role.USER],
				...state
			});

			await expect(
				service.introspect('Bearer access-token')
			).rejects.toThrow(USER_DEACTIVATED_MESSAGE);
		}
	);

	it('returns current database rights instead of JWT roles', async () => {
		const { service } = createService();

		await expect(
			service.introspect('Bearer access-token')
		).resolves.toEqual({
			active: true,
			subject: 'user-1',
			sessionId: 'session-1',
			roles: [Role.USER, Role.ADMIN]
		});
	});
});
