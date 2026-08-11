import { BillingSettingsState } from '@/messaging/billing-events';
import { ServiceUnavailableException } from '@nestjs/common';

const EXACT_KEYS = [
	'id',
	'paymentEnabled',
	'autoRenewalSignupEnabled',
	'autoRenewalChargesEnabled',
	'autoRenewalChargesEnabledAt',
	'affiliateProgramEnabled',
	'affiliateCashbackPercent',
	'updatedAt'
] as const;

export function parseBillingSettingsState(
	value: unknown
): BillingSettingsState {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw invalidSettings();
	}
	const settings = value as Record<string, unknown>;
	if (
		Object.keys(settings).length !== EXACT_KEYS.length ||
		EXACT_KEYS.some(key => !(key in settings)) ||
		settings.id !== 'singleton' ||
		typeof settings.paymentEnabled !== 'boolean' ||
		typeof settings.autoRenewalSignupEnabled !== 'boolean' ||
		typeof settings.autoRenewalChargesEnabled !== 'boolean' ||
		typeof settings.affiliateProgramEnabled !== 'boolean' ||
		!Number.isInteger(settings.affiliateCashbackPercent) ||
		Number(settings.affiliateCashbackPercent) < 0 ||
		Number(settings.affiliateCashbackPercent) > 100 ||
		!isIsoDate(settings.autoRenewalChargesEnabledAt) ||
		!isIsoDate(settings.updatedAt)
	) {
		throw invalidSettings();
	}
	return settings as unknown as BillingSettingsState;
}

function isIsoDate(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function invalidSettings(): ServiceUnavailableException {
	return new ServiceUnavailableException(
		'Billing settings response is invalid'
	);
}
