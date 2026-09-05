export type WincrmBillingCycle = 'MONTHLY' | 'YEARLY';

export interface WincrmPeriodPriceSnapshot {
	readonly includedSeats: number;
	readonly monthlyPriceMinor: number;
	readonly yearlyPriceMinor: number;
	readonly additionalSeatMonthlyPriceMinor: number;
	readonly additionalSeatYearlyPriceMinor: number;
}

export interface WincrmSeatDurationInput {
	readonly nowMs: number;
	readonly newTotalSeats: number;
	readonly period: {
		readonly kind: 'PAID';
		readonly status: 'ACTIVE';
		readonly cycle: WincrmBillingCycle;
		readonly startsAtMs: number;
		readonly expiresAtMs: number;
		readonly totalSeats: number;
		readonly priceSnapshot: WincrmPeriodPriceSnapshot;
	};
}

export interface WincrmSeatDurationResult {
	readonly cycle: WincrmBillingCycle;
	readonly oldTotalSeats: number;
	readonly newTotalSeats: number;
	readonly oldPeriodPriceMinor: bigint;
	readonly newPeriodPriceMinor: bigint;
	readonly oldRemainingMs: number;
	readonly newRemainingMs: number;
	readonly expiresAtMs: number;
}

export type WincrmSeatDurationErrorCode =
	| 'INVALID_INPUT'
	| 'INVALID_PAID_PERIOD'
	| 'INVALID_TIMESTAMP'
	| 'INVALID_SEAT_COUNT'
	| 'INVALID_PRICE_SNAPSHOT'
	| 'DURATION_OUT_OF_RANGE'
	| 'EXPIRY_OUT_OF_RANGE'
	| 'ZERO_REMAINING_DURATION';

export class WincrmSeatDurationError extends Error {
	constructor(readonly code: WincrmSeatDurationErrorCode) {
		super(`Invalid WinCRM seat-duration calculation: ${code}`);
		this.name = 'WincrmSeatDurationError';
	}
}

const MAX_DATE_MS = 8_640_000_000_000_000n;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function object(value: unknown): value is Record<string, unknown> {
	return (
		value !== null && typeof value === 'object' && !Array.isArray(value)
	);
}

function integer(value: unknown, minimum: number): value is number {
	return (
		typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value >= minimum
	);
}

function timestamp(value: unknown): bigint {
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
		throw new WincrmSeatDurationError('INVALID_TIMESTAMP');
	}
	const result = BigInt(value);
	if (result < -MAX_DATE_MS || result > MAX_DATE_MS) {
		throw new WincrmSeatDurationError('INVALID_TIMESTAMP');
	}
	return result;
}

/**
 * Converts only an active paid period using its own immutable price snapshot.
 * No calendar-day rounding, latest-policy lookup, money balance or refund.
 * For positive prices integer division guarantees:
 * newRemainingMs * newPrice <= oldRemainingMs * oldPrice.
 */
export function calculateWincrmSeatDuration(
	input: WincrmSeatDurationInput
): WincrmSeatDurationResult {
	if (!object(input) || !object(input.period)) {
		throw new WincrmSeatDurationError('INVALID_INPUT');
	}
	const { period } = input;
	if (period.kind !== 'PAID' || period.status !== 'ACTIVE') {
		throw new WincrmSeatDurationError('INVALID_PAID_PERIOD');
	}
	if (period.cycle !== 'MONTHLY' && period.cycle !== 'YEARLY') {
		throw new WincrmSeatDurationError('INVALID_INPUT');
	}
	const now = timestamp(input.nowMs);
	const startsAt = timestamp(period.startsAtMs);
	const expiresAt = timestamp(period.expiresAtMs);
	if (startsAt > now || expiresAt <= now) {
		throw new WincrmSeatDurationError('INVALID_PAID_PERIOD');
	}
	const snapshot = period.priceSnapshot;
	if (
		!object(snapshot) ||
		!integer(snapshot.includedSeats, 2) ||
		!integer(snapshot.monthlyPriceMinor, 1) ||
		!integer(snapshot.yearlyPriceMinor, 1) ||
		!integer(snapshot.additionalSeatMonthlyPriceMinor, 0) ||
		!integer(snapshot.additionalSeatYearlyPriceMinor, 0)
	) {
		throw new WincrmSeatDurationError('INVALID_PRICE_SNAPSHOT');
	}
	if (
		!integer(period.totalSeats, snapshot.includedSeats) ||
		!integer(input.newTotalSeats, snapshot.includedSeats)
	) {
		throw new WincrmSeatDurationError('INVALID_SEAT_COUNT');
	}
	const monthly = period.cycle === 'MONTHLY';
	const basePrice = BigInt(
		monthly ? snapshot.monthlyPriceMinor : snapshot.yearlyPriceMinor
	);
	const additionalSeatPrice = BigInt(
		monthly
			? snapshot.additionalSeatMonthlyPriceMinor
			: snapshot.additionalSeatYearlyPriceMinor
	);
	const includedSeats = BigInt(snapshot.includedSeats);
	const price = (seats: number) =>
		basePrice + (BigInt(seats) - includedSeats) * additionalSeatPrice;
	const oldPeriodPriceMinor = price(period.totalSeats);
	const newPeriodPriceMinor = price(input.newTotalSeats);
	const oldRemaining = expiresAt - now;
	const newRemaining =
		(oldRemaining * oldPeriodPriceMinor) / newPeriodPriceMinor;
	if (newRemaining === 0n) {
		throw new WincrmSeatDurationError('ZERO_REMAINING_DURATION');
	}
	if (oldRemaining > MAX_SAFE_INTEGER || newRemaining > MAX_SAFE_INTEGER) {
		throw new WincrmSeatDurationError('DURATION_OUT_OF_RANGE');
	}
	const newExpiresAt = now + newRemaining;
	if (newExpiresAt < -MAX_DATE_MS || newExpiresAt > MAX_DATE_MS) {
		throw new WincrmSeatDurationError('EXPIRY_OUT_OF_RANGE');
	}
	return {
		cycle: period.cycle,
		oldTotalSeats: period.totalSeats,
		newTotalSeats: input.newTotalSeats,
		oldPeriodPriceMinor,
		newPeriodPriceMinor,
		oldRemainingMs: Number(oldRemaining),
		newRemainingMs: Number(newRemaining),
		expiresAtMs: Number(newExpiresAt)
	};
}
