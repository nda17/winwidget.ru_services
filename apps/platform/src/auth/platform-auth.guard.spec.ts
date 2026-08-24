import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { PlatformAuthGuard } from './platform-auth.guard';

function context(authorization?: string) {
	const request = { headers: { authorization } };
	return {
		value: {
			switchToHttp: () => ({ getRequest: () => request }),
			getHandler: () => 'handler',
			getClass: () => 'controller'
		} as never,
		request
	};
}

describe('PlatformAuthGuard', () => {
	it.each(['ADMIN', 'DEV'] as const)(
		'allows %s for admin mutation',
		async role => {
			const identity = {
				introspect: jest.fn().mockResolvedValue({
					active: true,
					subject: 'actor-1',
					sessionId: 'session-1',
					roles: [role]
				})
			};
			const guard = new PlatformAuthGuard(
				{
					getAllAndOverride: jest.fn().mockReturnValue(['ADMIN', 'DEV'])
				} as never,
				identity as never
			);
			const current = context('Bearer access-token');
			await expect(guard.canActivate(current.value)).resolves.toBe(true);
			expect(current.request).toHaveProperty(
				'platformActor.subject',
				'actor-1'
			);
		}
	);

	it('returns 401 before introspection when bearer is missing', async () => {
		const identity = { introspect: jest.fn() };
		const guard = new PlatformAuthGuard(
			{ getAllAndOverride: jest.fn().mockReturnValue(['ADMIN']) } as never,
			identity as never
		);
		await expect(
			guard.canActivate(context().value)
		).rejects.toBeInstanceOf(UnauthorizedException);
		expect(identity.introspect).not.toHaveBeenCalled();
	});

	it('returns 403 when the exact actor lacks the required role', async () => {
		const guard = new PlatformAuthGuard(
			{
				getAllAndOverride: jest.fn().mockReturnValue(['ADMIN', 'DEV'])
			} as never,
			{
				introspect: jest.fn().mockResolvedValue({
					active: true,
					subject: 'user-1',
					sessionId: 'session-1',
					roles: ['USER']
				})
			} as never
		);
		await expect(
			guard.canActivate(context('Bearer access-token').value)
		).rejects.toBeInstanceOf(ForbiddenException);
	});
});
