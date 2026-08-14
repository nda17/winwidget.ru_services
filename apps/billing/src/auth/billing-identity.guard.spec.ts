import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { BillingIdentityGuard } from './billing-identity.guard';

const TOKEN = 'billing-identity-test-token-at-least-32-characters';

const context = (
	address = '127.0.0.1',
	service = 'identity',
	token = TOKEN
) =>
	({
		switchToHttp: () => ({
			getRequest: () => ({
				socket: { remoteAddress: address },
				header: (name: string) =>
					({
						'x-winwidget-service': service,
						'x-winwidget-internal-token': token
					})[name]
			})
		})
	}) as ExecutionContext;

describe('BillingIdentityGuard', () => {
	it('accepts only the Identity service on loopback with its scoped token', () => {
		const guard = new BillingIdentityGuard({
			get: () => TOKEN
		} as unknown as ConfigService);

		expect(guard.canActivate(context())).toBe(true);
		expect(() => guard.canActivate(context('10.0.0.2'))).toThrow(
			'Invalid internal credentials'
		);
		expect(() => guard.canActivate(context('127.0.0.1', 'core'))).toThrow(
			'Invalid internal credentials'
		);
		expect(() =>
			guard.canActivate(context('127.0.0.1', 'identity', 'wrong'))
		).toThrow('Invalid internal credentials');
	});

	it.each([
		'short',
		'billing_identity_token',
		'ci_billing_identity_token_at_least_32_chars'
	])('rejects weak scoped token %s', token => {
		expect(
			() =>
				new BillingIdentityGuard({
					get: () => token
				} as unknown as ConfigService)
		).toThrow('BILLING_IDENTITY_TOKEN');
	});
});
