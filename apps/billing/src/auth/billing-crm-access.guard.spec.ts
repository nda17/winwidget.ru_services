import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { BillingCrmAccessGuard } from './billing-crm-access.guard';

const TOKEN = 'billing-crm-access-test-token-at-least-32-characters';

const context = (
	address = '127.0.0.1',
	service = 'crm-access',
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

describe('BillingCrmAccessGuard', () => {
	it('accepts only crm-access on loopback with its scoped token', () => {
		const guard = new BillingCrmAccessGuard({
			get: () => TOKEN
		} as unknown as ConfigService);

		expect(guard.canActivate(context())).toBe(true);
		expect(() => guard.canActivate(context('10.0.0.2'))).toThrow(
			'Invalid internal credentials'
		);
		expect(() =>
			guard.canActivate(context('127.0.0.1', 'identity'))
		).toThrow('Invalid internal credentials');
		expect(() =>
			guard.canActivate(context('127.0.0.1', 'crm-access', 'wrong'))
		).toThrow('Invalid internal credentials');
	});

	it.each([
		'short',
		'billing_crm_access_token',
		'ci_billing_crm_access_token_at_least_32_chars'
	])('rejects weak scoped token %s', token => {
		expect(
			() =>
				new BillingCrmAccessGuard({
					get: () => token
				} as unknown as ConfigService)
		).toThrow('BILLING_CRM_ACCESS_TOKEN');
	});
});
