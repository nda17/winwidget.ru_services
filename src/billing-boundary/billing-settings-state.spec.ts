import { parseBillingSettingsState } from './billing-settings-state';

describe('parseBillingSettingsState', () => {
	const state = () => ({
		id: 'singleton',
		paymentEnabled: true,
		autoRenewalSignupEnabled: false,
		autoRenewalChargesEnabled: false,
		autoRenewalChargesEnabledAt: '2026-08-11T00:00:00.000Z',
		affiliateProgramEnabled: true,
		affiliateCashbackPercent: 10,
		updatedAt: '2026-08-11T00:00:00.000Z'
	});

	it('accepts the exact Billing settings state', () => {
		expect(parseBillingSettingsState(state())).toEqual(state());
	});

	it.each([
		{ extra: true },
		{ id: 'other' },
		{ affiliateCashbackPercent: 101 },
		{ updatedAt: 'not-an-iso-date' }
	])('rejects corrupted journal or HTTP state %o', override => {
		expect(() =>
			parseBillingSettingsState({ ...state(), ...override })
		).toThrow('Billing settings response is invalid');
	});
});
