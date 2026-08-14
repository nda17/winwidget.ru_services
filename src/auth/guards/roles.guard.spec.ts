import { RolesGuard } from '@/auth/guards/roles.guard';
import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { PlatformRole } from '../decorators/roles.decorator';

describe('RolesGuard', () => {
	const createContext = (rights: PlatformRole[]) =>
		({
			getHandler: jest.fn().mockReturnValue(function handler() {}),
			getClass: jest.fn().mockReturnValue(class Controller {}),
			switchToHttp: () => ({
				getRequest: () => ({ user: { rights } })
			})
		}) as unknown as ExecutionContext;

	it('enforces roles declared on a controller class', () => {
		const reflector = {
			getAllAndOverride: jest.fn().mockReturnValue(['DEV'])
		} as unknown as Reflector;
		const guard = new RolesGuard(reflector);

		expect(() => guard.canActivate(createContext(['ADMIN']))).toThrow(
			ForbiddenException
		);
		expect(guard.canActivate(createContext(['DEV']))).toBe(true);
		expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
			'roles',
			expect.any(Array)
		);
	});

	it('fails closed when no authenticated platform actor is attached', () => {
		const reflector = {
			getAllAndOverride: jest.fn().mockReturnValue(['ADMIN'])
		} as unknown as Reflector;
		const guard = new RolesGuard(reflector);
		const context = {
			getHandler: jest.fn().mockReturnValue(function handler() {}),
			getClass: jest.fn().mockReturnValue(class Controller {}),
			switchToHttp: () => ({ getRequest: () => ({}) })
		} as unknown as ExecutionContext;

		expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
	});
});
