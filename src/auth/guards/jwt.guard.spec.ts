import type { IdentityInternalClient } from '@/identity-boundary/identity-internal.client';
import type { ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from './jwt.guard';

const context = (authorization?: string) => {
	const request = { headers: { authorization }, user: undefined };
	return {
		request,
		context: {
			switchToHttp: () => ({ getRequest: () => request })
		} as unknown as ExecutionContext
	};
};

describe('JwtAuthGuard Identity boundary', () => {
	it('fails before introspection for a malformed bearer header', async () => {
		const identity = { introspect: jest.fn() };
		const guard = new JwtAuthGuard(
			identity as unknown as IdentityInternalClient
		);
		await expect(
			guard.canActivate(context('Basic value').context)
		).rejects.toMatchObject({ response: { message: 'Unauthorized' } });
		expect(identity.introspect).not.toHaveBeenCalled();
	});

	it('uses live Identity state and exposes only the residual Core actor', async () => {
		const identity = {
			introspect: jest.fn().mockResolvedValue({
				active: true,
				subject: 'user-id',
				sessionId: '22222222-2222-4222-8222-222222222222',
				roles: ['DEV']
			})
		};
		const guard = new JwtAuthGuard(
			identity as unknown as IdentityInternalClient
		);
		const fixture = context('Bearer access-token');
		await expect(guard.canActivate(fixture.context)).resolves.toBe(true);
		expect(identity.introspect).toHaveBeenCalledWith(
			'Bearer access-token'
		);
		expect(fixture.request.user).toEqual({
			id: 'user-id',
			rights: ['DEV'],
			sessionId: '22222222-2222-4222-8222-222222222222'
		});
	});
});
