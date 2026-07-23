import { RolesGuard } from '@/auth/guards/roles.guard';
import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';

describe('RolesGuard', () => {
	const createContext = (rights: Role[]) =>
		({
			getHandler: jest.fn().mockReturnValue(function handler() {}),
			getClass: jest.fn().mockReturnValue(class Controller {}),
			switchToHttp: () => ({
				getRequest: () => ({ user: { rights } })
			})
		}) as unknown as ExecutionContext;

	it('enforces roles declared on a controller class', () => {
		const reflector = {
			getAllAndOverride: jest.fn().mockReturnValue([Role.DEV])
		} as unknown as Reflector;
		const guard = new RolesGuard(reflector);

		expect(() => guard.canActivate(createContext([Role.ADMIN]))).toThrow(
			ForbiddenException
		);
		expect(guard.canActivate(createContext([Role.DEV]))).toBe(true);
		expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
			'roles',
			expect.any(Array)
		);
	});
});
