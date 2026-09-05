import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { BillingWincrmWidgetsGuard } from './billing-wincrm-widgets.guard';

const WIDGETS = 'widgets-eligibility-unit-credential-1234567890';
const INTAKE = 'intake-eligibility-unit-credential-1234567890';
const config = (patch: Record<string, unknown> = {}) =>
	({
		get: (key: string) =>
			({
				BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED: 'true',
				BILLING_WINCRM_WIDGETS_TOKEN: WIDGETS,
				BILLING_WINCRM_CRM_INTAKE_TOKEN: INTAKE,
				...patch
			})[key]
	}) as ConfigService;
const context = (
	caller = 'widgets',
	token = WIDGETS,
	address = '127.0.0.1'
) =>
	({
		switchToHttp: () => ({
			getRequest: () => ({
				socket: { remoteAddress: address },
				header: (name: string) =>
					({
						'x-winwidget-service': caller,
						'x-winwidget-internal-token': token,
						'x-forwarded-for': '127.0.0.1'
					})[name]
			})
		})
	}) as ExecutionContext;

describe('BillingWincrmWidgetsGuard', () => {
	it.each([undefined, false, 'false'])(
		'keeps startup and endpoint disabled without new credentials',
		flag => {
			const guard = new BillingWincrmWidgetsGuard({
				get: (key: string) => {
					if (key !== 'BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED')
						throw new Error(
							'Disabled feature must not read new credentials'
						);
					return flag;
				}
			} as ConfigService);
			expect(() => guard.canActivate(context())).toThrow('Not Found');
		}
	);
	it('binds two independent credentials to their own caller', () => {
		const guard = new BillingWincrmWidgetsGuard(config());
		expect(guard.canActivate(context())).toBe(true);
		expect(guard.canActivate(context('crm-intake', INTAKE, '::1'))).toBe(
			true
		);
		expect(
			guard.canActivate(context('widgets', WIDGETS, '::ffff:127.0.0.1'))
		).toBe(true);
		for (const [caller, token] of [
			['crm-intake', WIDGETS],
			['widgets', INTAKE],
			['crm-access', WIDGETS],
			['widgets', ''],
			['widgets,crm-intake', WIDGETS]
		]) {
			expect(() => guard.canActivate(context(caller, token))).toThrow(
				'Invalid internal credentials'
			);
		}
	});
	it.each([
		'10.0.0.1',
		'192.168.1.1',
		'203.0.113.1',
		'::ffff:10.0.0.1',
		'127.0.0.999',
		''
	])(
		'denies a remote peer regardless of spoofed forwarded headers',
		address => {
			expect(() =>
				new BillingWincrmWidgetsGuard(config()).canActivate(
					context('widgets', WIDGETS, address)
				)
			).toThrow('Invalid internal credentials');
		}
	);
	it.each(['', 'true ', 'yes', '1'])(
		'rejects an ambiguous enable flag',
		flag => {
			expect(
				() =>
					new BillingWincrmWidgetsGuard(
						config({ BILLING_WINCRM_WIDGETS_ELIGIBILITY_ENABLED: flag })
					)
			).toThrow('must be true or false');
		}
	);
	it.each([
		'',
		'short',
		'change_me',
		'ci_billing_widgets_token_at_least_32_chars',
		'x'.repeat(513),
		' '.repeat(32)
	])('rejects invalid credentials when explicitly enabled', token => {
		expect(
			() =>
				new BillingWincrmWidgetsGuard(
					config({ BILLING_WINCRM_WIDGETS_TOKEN: token })
				)
		).toThrow('BILLING_WINCRM_WIDGETS_TOKEN');
	});
	it('rejects reuse between new callers and existing service pairs', () => {
		expect(
			() =>
				new BillingWincrmWidgetsGuard(
					config({ BILLING_WINCRM_CRM_INTAKE_TOKEN: WIDGETS })
				)
		).toThrow('must be distinct');
		expect(
			() =>
				new BillingWincrmWidgetsGuard(
					config({ BILLING_IDENTITY_TOKEN: WIDGETS })
				)
		).toThrow('must be distinct');
	});
});
