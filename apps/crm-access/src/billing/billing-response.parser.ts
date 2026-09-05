import {
	hasExactKeys,
	isRecord,
	isUuidV4
} from '../internal/internal-http.config';
import {
	validInt,
	validSeats,
	validVersion,
	validHash,
	validConsent
} from './billing.validation';
import type {
	WincrmCommerceSummary,
	WincrmCommerceCommandProof,
	WincrmCommerceQuote,
	WincrmOrderResponse,
	WincrmHistoryResponse
} from './billing.contract';

type Check = (v: unknown) => boolean;
const literal =
	(...values: unknown[]): Check =>
	v =>
		values.includes(v);
const nullable =
	(check: Check): Check =>
	v =>
		v === null || check(v);
const text =
	(max: number): Check =>
	v =>
		typeof v === 'string' &&
		v.length > 0 &&
		v.length <= max &&
		!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\uD800-\uDFFF\uFFFD]/u.test(v);
const bool: Check = v => typeof v === 'boolean';
const positive: Check = v => validInt(v);
const nonnegative: Check = v => validInt(v, 0);
const minor: Check = v =>
	typeof v === 'string' &&
	/^(0|[1-9][0-9]{0,18})$/.test(v) &&
	BigInt(v) <= 9223372036854775807n;
export const iso: Check = v =>
	typeof v === 'string' &&
	Number.isFinite(Date.parse(v)) &&
	new Date(v).toISOString() === v;
function shape(
	v: unknown,
	fields: Record<string, Check>
): v is Record<string, unknown> {
	return (
		isRecord(v) &&
		hasExactKeys(v, Object.keys(fields)) &&
		Object.entries(fields).every(([key, check]) => check(v[key]))
	);
}
const cycle = literal('MONTHLY', 'YEARLY');
const price: Check = v =>
	shape(v, {
		policyVersion: positive,
		monthlyPriceMinor: v => validInt(v, 1, 100000000),
		yearlyPriceMinor: v => validInt(v, 1, 100000000),
		additionalSeatMonthlyPriceMinor: v => validInt(v, 0, 100000000),
		additionalSeatYearlyPriceMinor: v => validInt(v, 0, 100000000),
		includedSeats: validSeats,
		graceDays: literal(3)
	});
const url: Check = v => {
	if (typeof v !== 'string' || v.length > 4096) return false;
	try {
		const u = new URL(v);
		return (
			u.protocol === 'https:' &&
			!u.username &&
			!u.password &&
			!u.hash &&
			u.toString() === v
		);
	} catch {
		return false;
	}
};
const order: Check = v => {
	if (
		!shape(v, {
			id: isUuidV4,
			workspaceId: isUuidV4,
			canVerify: bool,
			version: positive,
			kind: literal('ONE_TIME', 'RECURRING'),
			state: literal('PENDING', 'SUCCEEDED', 'CANCELLED', 'UNKNOWN'),
			cycle,
			totalSeats: validSeats,
			amountMinor: minor,
			currency: literal('RUB'),
			policyVersion: positive,
			confirmationUrl: nullable(url),
			checkoutExpiresAt: iso,
			createdAt: iso,
			succeededAt: nullable(iso),
			fulfillment: literal('NONE', 'SCHEDULED', 'ACTIVE', 'EXPIRED'),
			periodId: nullable(isUuidV4),
			startsAt: nullable(iso),
			expiresAt: nullable(iso)
		})
	)
		return false;
	return (
		(!v.canVerify || v.state === 'PENDING' || v.state === 'UNKNOWN') &&
		(v.state === 'SUCCEEDED') === (v.succeededAt !== null) &&
		(v.fulfillment === 'NONE'
			? v.periodId === null && v.startsAt === null && v.expiresAt === null
			: v.periodId !== null &&
				v.startsAt !== null &&
				v.expiresAt !== null &&
				Date.parse(String(v.expiresAt)) > Date.parse(String(v.startsAt)))
	);
};
const period: Check = v =>
	shape(v, {
		id: isUuidV4,
		orderId: isUuidV4,
		version: positive,
		cycle,
		totalSeats: validSeats,
		priceSnapshot: price,
		startsAt: iso,
		expiresAt: iso,
		graceUntil: iso,
		state: literal('SCHEDULED', 'ACTIVE', 'GRACE', 'EXPIRED')
	}) &&
	Date.parse(String(v.startsAt)) < Date.parse(String(v.expiresAt)) &&
	Date.parse(String(v.expiresAt)) <= Date.parse(String(v.graceUntil));
const renewal: Check = v =>
	shape(v, {
		version: nonnegative,
		state: literal(
			'NONE',
			'ACTIVE',
			'USER_DISABLED',
			'TECHNICAL_PAUSE',
			'PRICE_CONFIRMATION_REQUIRED',
			'REVOKED'
		),
		canDisable: bool,
		dispatchPending: bool,
		nextChargeAt: nullable(iso),
		nextRetryAt: nullable(iso),
		retryAttempt: nonnegative,
		methodLast4: nullable(
			x => typeof x === 'string' && /^[0-9]{4}$/.test(x)
		),
		methodTitle: nullable(text(200))
	});
function invalid(): never {
	throw new Error('BILLING_RESPONSE_CONTRACT');
}
export type BillingResponseKind =
	| 'summary'
	| 'quote'
	| 'proof'
	| 'order'
	| 'history';
export type BillingResponse =
	| WincrmCommerceSummary
	| WincrmCommerceCommandProof
	| WincrmCommerceQuote
	| WincrmOrderResponse
	| WincrmHistoryResponse;
export function parseBillingResponse(
	kind: BillingResponseKind,
	value: unknown,
	workspaceId: string,
	binding?: { commandId: string; requestHash: string }
): BillingResponse {
	if (!isRecord(value)) invalid();
	const common = {
		schemaVersion: literal(1),
		workspaceId: literal(workspaceId)
	};
	if (kind === 'summary') {
		if (
			!shape(value, {
				...common,
				billingVersion: validVersion,
				serverTime: iso,
				policy: price,
				trial: nullable(
					v =>
						shape(v, {
							startsAt: iso,
							expiresAt: iso,
							seatLimit: validSeats
						}) &&
						Date.parse(String(v.startsAt)) <
							Date.parse(String(v.expiresAt))
				),
				period: nullable(period),
				pendingOrder: nullable(order),
				renewal
			}) ||
			(isRecord(value.pendingOrder) &&
				value.pendingOrder.workspaceId !== workspaceId)
		)
			invalid();
	} else if (kind === 'proof') {
		if (
			!binding ||
			!shape(value, {
				...common,
				commandId: literal(binding.commandId),
				requestHash: v => v === binding.requestHash && validHash(v),
				status: literal('PENDING', 'COMMITTED', 'CANCELLED'),
				billingVersion: validVersion,
				releaseFence: bool,
				holdUntil: nullable(iso),
				order: nullable(order),
				period: nullable(period)
			})
		)
			invalid();
		if (
			(value.status === 'PENDING' && value.releaseFence) ||
			(value.status === 'CANCELLED' && !value.releaseFence) ||
			(value.holdUntil !== null &&
				(value.status !== 'COMMITTED' || value.releaseFence)) ||
			(isRecord(value.order) && value.order.workspaceId !== workspaceId)
		)
			invalid();
	} else if (kind === 'quote') {
		if (
			!shape(value, {
				...common,
				billingVersion: validVersion,
				serverTime: iso,
				validUntil: iso,
				intent: literal('CHECKOUT', 'SEAT_CHANGE', 'RENEWAL'),
				cycle,
				totalSeats: validSeats,
				amountMinor: minor,
				currency: literal('RUB'),
				priceSnapshot: price,
				startsAt: iso,
				expiresAt: iso,
				period: nullable(v =>
					shape(v, {
						id: isUuidV4,
						version: positive,
						oldTotalSeats: validSeats,
						oldExpiresAt: iso,
						oldPeriodPriceMinor: minor,
						newPeriodPriceMinor: minor
					})
				),
				consent: v => shape(v, { version: validConsent, text: text(5000) })
			}) ||
			Date.parse(String(value.validUntil)) <=
				Date.parse(String(value.serverTime)) ||
			Date.parse(String(value.expiresAt)) <=
				Date.parse(String(value.startsAt))
		)
			invalid();
	} else if (kind === 'order') {
		if (
			!shape(value, { ...common, serverTime: iso, order }) ||
			(value.order as Record<string, unknown>).workspaceId !== workspaceId
		)
			invalid();
	} else {
		if (
			!shape(value, {
				...common,
				page: v => validInt(v, 1, 1000000),
				pageSize: v => validInt(v, 1, 100),
				total: v => validInt(v, 0, Number.MAX_SAFE_INTEGER),
				items: v =>
					Array.isArray(v) &&
					v.length <= 100 &&
					v.every(
						item =>
							order(item) &&
							(item as Record<string, unknown>).workspaceId === workspaceId
					)
			}) ||
			(value.items as unknown[]).length > Number(value.pageSize)
		)
			invalid();
	}
	return value as unknown as BillingResponse;
}
