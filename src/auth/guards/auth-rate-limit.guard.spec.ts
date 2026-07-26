import { AuthRateLimitGuard } from '@/auth/guards/auth-rate-limit.guard';
import {
	HttpException,
	HttpStatus,
	type ExecutionContext
} from '@nestjs/common';
import type { Request } from 'express';

interface IAuthRateLimitGuardStatics {
	storage: Map<string, { count: number; expiresAt: number }>;
	cleanupInterval: ReturnType<typeof setInterval> | null;
}

const guardStatics =
	AuthRateLimitGuard as unknown as IAuthRateLimitGuardStatics;

const resetGuardState = () => {
	guardStatics.storage.clear();

	if (guardStatics.cleanupInterval) {
		clearInterval(guardStatics.cleanupInterval);
		guardStatics.cleanupInterval = null;
	}
};

const createContext = (
	spoofedIp: string,
	path = '/auth/login'
): ExecutionContext =>
	({
		switchToHttp: () => ({
			getRequest: () =>
				({
					ip: '203.0.113.10',
					headers: {
						'x-forwarded-for': spoofedIp,
						'x-real-ip': spoofedIp,
						'cf-connecting-ip': spoofedIp
					},
					route: {
						path
					},
					path,
					socket: {
						remoteAddress: '127.0.0.1'
					}
				}) as unknown as Request
		})
	}) as unknown as ExecutionContext;

describe('AuthRateLimitGuard', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		resetGuardState();
	});

	afterEach(() => {
		resetGuardState();
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	it('does not allow rotating spoofed headers to bypass the IP limit', () => {
		const guard = new AuthRateLimitGuard();

		for (let index = 0; index < 10; index += 1) {
			expect(
				guard.canActivate(createContext(`198.51.100.${index + 1}`))
			).toBe(true);
		}

		try {
			guard.canActivate(createContext('198.51.100.11'));
			throw new Error('Expected the rate limit to reject the request');
		} catch (error) {
			expect(error).toBeInstanceOf(HttpException);
			expect((error as HttpException).getStatus()).toBe(
				HttpStatus.TOO_MANY_REQUESTS
			);
		}
	});

	it('uses the refresh-specific limit for the new endpoint', () => {
		const guard = new AuthRateLimitGuard();

		for (let index = 0; index < 20; index += 1) {
			expect(
				guard.canActivate(createContext('198.51.100.1', '/auth/refresh'))
			).toBe(true);
		}

		expect(() =>
			guard.canActivate(createContext('198.51.100.1', '/auth/refresh'))
		).toThrow(HttpException);
	});
});
