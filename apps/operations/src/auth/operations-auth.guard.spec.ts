import {
	ExecutionContext,
	ForbiddenException,
	ServiceUnavailableException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IdentityIntrospectionClient } from './identity-introspection.client';
import { OperationsAuthGuard } from './operations-auth.guard';

describe('OperationsAuthGuard', () => {
	const activeOwnership = () =>
		({ assertActive: jest.fn().mockResolvedValue(undefined) }) as never;

	const contextFor = (request: Record<string, unknown>) =>
		({
			switchToHttp: () => ({ getRequest: () => request }),
			getHandler: () => function handler() {},
			getClass: () => class Controller {}
		}) as unknown as ExecutionContext;

	it('supports a role array for future Operations endpoints', async () => {
		const reflector = {
			getAllAndOverride: jest.fn().mockReturnValue(['ADMIN', 'DEV'])
		} as unknown as Reflector;
		const identity = {
			introspect: jest.fn().mockResolvedValue({
				active: true,
				subject: 'admin-1',
				sessionId: 'session-1',
				roles: ['DEV']
			})
		} as unknown as IdentityIntrospectionClient;
		const request = { headers: { authorization: 'Bearer token' } };
		const guard = new OperationsAuthGuard(
			reflector,
			identity,
			activeOwnership()
		);

		await expect(guard.canActivate(contextFor(request))).resolves.toBe(
			true
		);
		expect(request).toHaveProperty('operationsActor.subject', 'admin-1');
	});

	it('rejects a DEV actor from the ADMIN-only Notes policy', async () => {
		const reflector = {
			getAllAndOverride: jest.fn().mockReturnValue(['ADMIN'])
		} as unknown as Reflector;
		const identity = {
			introspect: jest.fn().mockResolvedValue({
				active: true,
				subject: 'dev-1',
				sessionId: 'session-1',
				roles: ['DEV']
			})
		} as unknown as IdentityIntrospectionClient;
		const guard = new OperationsAuthGuard(
			reflector,
			identity,
			activeOwnership()
		);

		await expect(
			guard.canActivate(
				contextFor({ headers: { authorization: 'Bearer token' } })
			)
		).rejects.toBeInstanceOf(ForbiddenException);
	});

	it('rejects an endpoint with no declared access policy', async () => {
		const reflector = {
			getAllAndOverride: jest.fn().mockReturnValue(undefined)
		} as unknown as Reflector;
		const identity = {
			introspect: jest.fn()
		} as unknown as IdentityIntrospectionClient;
		const guard = new OperationsAuthGuard(
			reflector,
			identity,
			activeOwnership()
		);

		await expect(
			guard.canActivate(
				contextFor({ headers: { authorization: 'Bearer token' } })
			)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(identity.introspect).not.toHaveBeenCalled();
	});

	it('rejects business traffic while Operations ownership is staged', async () => {
		const reflector = {
			getAllAndOverride: jest.fn().mockReturnValue(['ADMIN'])
		} as unknown as Reflector;
		const identity = {
			introspect: jest.fn()
		} as unknown as IdentityIntrospectionClient;
		const ownership = {
			assertActive: jest
				.fn()
				.mockRejectedValue(
					new ServiceUnavailableException(
						'Operations ownership is not active'
					)
				)
		};
		const guard = new OperationsAuthGuard(
			reflector,
			identity,
			ownership as never
		);

		await expect(
			guard.canActivate(
				contextFor({ headers: { authorization: 'Bearer token' } })
			)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(identity.introspect).not.toHaveBeenCalled();
	});
});
