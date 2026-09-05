import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
	CrmCommercialPolicy,
	CrmOrder,
	CrmPaidPeriod,
	CrmAutoRenewal
} from '@prisma/billing-client';
import { billingCommandRequestHash } from './billing-command-idempotency';
import type {
	WincrmBillingCycle,
	WincrmCommerceCommand,
	WincrmOrderView,
	WincrmPaidPeriodView,
	WincrmPriceSnapshot,
	WincrmRenewalView
} from './wincrm-commerce.contract';

export const WINCRM_CONSENT_VERSION = 'wincrm-auto-renewal-v1';
export const WINCRM_CONSENT_TEXT =
	'Я соглашаюсь сохранить способ оплаты в ЮKassa и автоматически продлевать подписку WinCRM с указанным количеством мест и периодичностью по подтверждённой стоимости. При недостатке средств или временной недоступности банка допустимы не более двух повторных попыток примерно через 24 и 72 часа после первого отказа, в пределах одного часа от времени каждой попытки. Новая стоимость требует отдельного подтверждения. Автопродление можно отключить до начала отправки очередного запроса на списание; уже отправленный запрос сверяется отдельно. Отключение сохраняет оплаченный период и не меняет подписку на виджеты WinWidget.';
export const WINCRM_DAY_MS = 86_400_000;
export const WINCRM_UUID =
	/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const WINCRM_HASH = /^[a-f0-9]{64}$/;
export const WINCRM_MAX_AMOUNT = 1_000_000_000_000n;

export function commerceConflict(code: string): never {
	throw new ConflictException({
		code,
		message: 'Состояние оплаты WinCRM изменилось'
	});
}
export function commerceInvalid(): never {
	throw new BadRequestException({
		code: 'wincrm_commerce_invalid_request',
		message: 'Некорректный запрос WinCRM'
	});
}
export function commerceRecord(
	value: unknown
): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function commerceText(
	value: unknown,
	maximum: number
): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maximum &&
		!/[\u0000-\u001f\u007f\ufffd]/u.test(value) &&
		!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
			value
		)
	);
}
export function commerceUuid(value: unknown): value is string {
	return typeof value === 'string' && WINCRM_UUID.test(value);
}
export function commerceVersion(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^(0|[1-9][0-9]{0,18})$/.test(value) &&
		BigInt(value) <= 9_223_372_036_854_775_807n
	);
}
export function commerceInt(
	value: unknown,
	minimum: number,
	maximum: number
): value is number {
	return (
		typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value >= minimum &&
		value <= maximum
	);
}
export function commerceCycle(
	value: unknown
): value is WincrmBillingCycle {
	return value === 'MONTHLY' || value === 'YEARLY';
}
export function wincrmCommerceRequestHash(
	commandType: string,
	command: WincrmCommerceCommand
): string {
	const { capacityFence: _capacityFence, ...payload } =
		command as unknown as Record<string, unknown>;
	void _capacityFence;
	return billingCommandRequestHash(commandType, payload);
}
export function wincrmProviderKey(...parts: string[]): string {
	return createHash('sha256')
		.update(JSON.stringify(['WINCRM', ...parts]))
		.digest('hex');
}
export function wincrmPriceSnapshot(
	policy: CrmCommercialPolicy
): WincrmPriceSnapshot {
	return {
		policyVersion: policy.version,
		monthlyPriceMinor: policy.monthlyPriceMinor,
		yearlyPriceMinor: policy.yearlyPriceMinor,
		additionalSeatMonthlyPriceMinor:
			policy.additionalSeatMonthlyPriceMinor,
		additionalSeatYearlyPriceMinor: policy.additionalSeatYearlyPriceMinor,
		includedSeats: policy.includedSeats,
		graceDays: policy.graceDays
	};
}
export function readWincrmPriceSnapshot(
	value: unknown
): WincrmPriceSnapshot {
	if (
		!commerceRecord(value) ||
		Object.keys(value).length !== 7 ||
		!commerceInt(value.policyVersion, 1, 2147483646) ||
		!commerceInt(value.monthlyPriceMinor, 1, 100000000) ||
		!commerceInt(value.yearlyPriceMinor, 1, 100000000) ||
		!commerceInt(value.additionalSeatMonthlyPriceMinor, 0, 100000000) ||
		!commerceInt(value.additionalSeatYearlyPriceMinor, 0, 100000000) ||
		!commerceInt(value.includedSeats, 2, 10000) ||
		value.graceDays !== 3
	)
		throw new Error('WinCRM price snapshot is invalid');
	return value as unknown as WincrmPriceSnapshot;
}
export function wincrmPrice(
	snapshot: WincrmPriceSnapshot,
	cycle: WincrmBillingCycle,
	seats: number
): bigint {
	readWincrmPriceSnapshot(snapshot);
	if (
		!commerceInt(seats, snapshot.includedSeats, 10000) ||
		!commerceCycle(cycle)
	)
		commerceInvalid();
	const result =
		BigInt(
			cycle === 'MONTHLY'
				? snapshot.monthlyPriceMinor
				: snapshot.yearlyPriceMinor
		) +
		BigInt(seats - snapshot.includedSeats) *
			BigInt(
				cycle === 'MONTHLY'
					? snapshot.additionalSeatMonthlyPriceMinor
					: snapshot.additionalSeatYearlyPriceMinor
			);
	if (result < 1n || result > WINCRM_MAX_AMOUNT) commerceInvalid();
	return result;
}
export function wincrmDecimal(minor: bigint): string {
	if (minor < 1n || minor > WINCRM_MAX_AMOUNT)
		throw new Error('WinCRM amount is invalid');
	return `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`;
}
export function wincrmPeriodEnd(
	start: Date,
	cycle: WincrmBillingCycle
): Date {
	if (!Number.isFinite(start.getTime()) || !commerceCycle(cycle))
		commerceInvalid();
	const end = new Date(start);
	const day = end.getUTCDate();
	end.setUTCDate(1);
	end.setUTCMonth(end.getUTCMonth() + (cycle === 'MONTHLY' ? 1 : 12));
	const last = new Date(end);
	last.setUTCMonth(last.getUTCMonth() + 1, 0);
	end.setUTCDate(Math.min(day, last.getUTCDate()));
	if (!Number.isFinite(end.getTime()) || end <= start) commerceInvalid();
	return end;
}
export function wincrmPeriodView(
	period: CrmPaidPeriod,
	now: Date
): WincrmPaidPeriodView {
	return {
		id: period.id,
		orderId: period.orderId,
		version: period.version,
		cycle: period.cycle as WincrmBillingCycle,
		totalSeats: period.totalSeats,
		priceSnapshot: readWincrmPriceSnapshot(period.priceSnapshot),
		startsAt: period.startsAt.toISOString(),
		expiresAt: period.expiresAt.toISOString(),
		graceUntil: period.graceUntil.toISOString(),
		state:
			now < period.startsAt
				? 'SCHEDULED'
				: now < period.expiresAt
					? 'ACTIVE'
					: now < period.graceUntil
						? 'GRACE'
						: 'EXPIRED'
	};
}
export function wincrmOrderView(
	order: CrmOrder,
	period: CrmPaidPeriod | null,
	now: Date
): WincrmOrderView {
	return {
		id: order.id,
		workspaceId: order.workspaceId,
		version: order.version,
		kind: order.kind as WincrmOrderView['kind'],
		state: order.status as WincrmOrderView['state'],
		cycle: order.cycle as WincrmBillingCycle,
		totalSeats: order.totalSeats,
		amountMinor: order.amountMinor.toString(),
		currency: 'RUB',
		policyVersion: order.policyVersion,
		confirmationUrl:
			order.status === 'PENDING' ? order.confirmationUrl : null,
		canVerify:
			['PENDING', 'UNKNOWN'].includes(order.status) &&
			!!order.providerPaymentId,
		checkoutExpiresAt: order.checkoutExpiresAt.toISOString(),
		createdAt: order.createdAt.toISOString(),
		succeededAt: order.succeededAt?.toISOString() ?? null,
		fulfillment: !period
			? 'NONE'
			: now < period.startsAt
				? 'SCHEDULED'
				: now < period.expiresAt
					? 'ACTIVE'
					: 'EXPIRED',
		periodId: period?.id ?? null,
		startsAt: period?.startsAt.toISOString() ?? null,
		expiresAt: period?.expiresAt.toISOString() ?? null
	};
}
export function wincrmRenewalView(
	renewal: CrmAutoRenewal | null
): WincrmRenewalView {
	return {
		version: renewal?.version ?? 0,
		state: (renewal?.status ?? 'NONE') as WincrmRenewalView['state'],
		canDisable:
			!!renewal && !['USER_DISABLED', 'REVOKED'].includes(renewal.status),
		dispatchPending: renewal?.dispatchPending ?? false,
		nextChargeAt: renewal?.nextChargeAt.toISOString() ?? null,
		nextRetryAt: renewal?.nextRetryAt?.toISOString() ?? null,
		retryAttempt: renewal?.retryAttempt ?? 0,
		methodLast4: renewal?.paymentMethodLast4 ?? null,
		methodTitle: renewal?.paymentMethodTitle ?? null
	};
}
