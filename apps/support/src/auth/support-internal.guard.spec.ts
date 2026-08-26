import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SupportInternalGuard } from './support-internal.guard';

const TOKEN = 'support-operations-token-at-least-32-characters';

function guard(token = TOKEN): SupportInternalGuard {
	return new SupportInternalGuard({
		get: () => token
	} as unknown as ConfigService);
}

function context(
	service = 'operations',
	token = TOKEN,
	remoteAddress = '127.0.0.1'
): ExecutionContext {
	return {
		switchToHttp: () => ({
			getRequest: () => ({
				header: (name: string) =>
					name === 'x-winwidget-service' ? service : token,
				socket: { remoteAddress }
			})
		})
	} as unknown as ExecutionContext;
}

describe('SupportInternalGuard', () => {
	it('accepts only the Operations credential over loopback', () => {
		expect(guard().canActivate(context())).toBe(true);
		expect(
			guard().canActivate(context('operations', TOKEN, '::ffff:127.0.0.1'))
		).toBe(true);
	});

	it.each([
		['core', TOKEN, '127.0.0.1'],
		['operations', 'wrong-token', '127.0.0.1'],
		['operations', TOKEN, '10.0.0.2']
	])(
		'rejects service=%s token/address mismatch',
		(service, token, address) => {
			expect(() =>
				guard().canActivate(context(service, token, address))
			).toThrow(ForbiddenException);
		}
	);

	it.each([
		'',
		'short',
		'change_me_support_operations_token_at_least_32_chars',
		'ci_support_operations_token_at_least_32_chars'
	])('fails closed for insecure token %p', token => {
		expect(() => guard(token)).toThrow('SUPPORT_OPERATIONS_TOKEN');
	});
});
