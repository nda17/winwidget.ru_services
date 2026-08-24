import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PlatformRuntimeService } from '../runtime/platform-runtime.service';
import { PlatformInternalGuard } from './platform-internal.guard';

const TOKEN = 'platform-core-monitor-token-at-least-32-characters';

const createGuard = (token = TOKEN) =>
	new PlatformInternalGuard(
		{ get: jest.fn().mockReturnValue(token) } as unknown as ConfigService,
		{ apiEnabled: true } as PlatformRuntimeService
	);

const context = (
	service = 'core',
	token = TOKEN,
	remoteAddress = '127.0.0.1'
) =>
	({
		switchToHttp: () => ({
			getRequest: () => ({
				header: (name: string) =>
					name === 'x-winwidget-service' ? service : token,
				socket: { remoteAddress }
			})
		})
	}) as unknown as ExecutionContext;

describe('PlatformInternalGuard', () => {
	it('accepts only the scoped Core token over loopback', () => {
		expect(createGuard().canActivate(context())).toBe(true);
		expect(
			createGuard().canActivate(context('core', TOKEN, '::ffff:127.0.0.1'))
		).toBe(true);
	});

	it.each([
		['identity', TOKEN, '127.0.0.1'],
		['core', 'wrong-token-that-is-long-enough-to-compare', '127.0.0.1'],
		['core', TOKEN, '10.0.0.2']
	])(
		'rejects service=%s token/address mismatch',
		(service, token, address) => {
			expect(() =>
				createGuard().canActivate(context(service, token, address))
			).toThrow(ForbiddenException);
		}
	);

	it.each([
		'',
		'change_me',
		'change_me_platform_core_token_at_least_32_chars',
		'change-me-platform-core-token-at-least-32-chars',
		'ci_platform_core_token_at_least_32_chars',
		'platform_core_token',
		'short'
	])('fails startup for insecure API token %p', token => {
		expect(() => createGuard(token)).toThrow(
			'PLATFORM_CORE_TOKEN must be a non-placeholder secret with at least 32 characters'
		);
	});
});
