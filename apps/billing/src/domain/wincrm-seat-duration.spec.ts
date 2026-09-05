import {
	calculateWincrmSeatDuration,
	WincrmSeatDurationError,
	type WincrmSeatDurationErrorCode,
	type WincrmSeatDurationInput
} from './wincrm-seat-duration';

const DAY_MS = 86_400_000;
const NOW = 1_800_000_000_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const input = (): WincrmSeatDurationInput => ({
	nowMs: NOW,
	newTotalSeats: 3,
	period: {
		kind: 'PAID',
		status: 'ACTIVE',
		cycle: 'MONTHLY',
		startsAtMs: NOW - DAY_MS,
		expiresAtMs: NOW + 30 * DAY_MS,
		totalSeats: 2,
		priceSnapshot: {
			includedSeats: 2,
			monthlyPriceMinor: 99_000,
			yearlyPriceMinor: 990_000,
			additionalSeatMonthlyPriceMinor: 29_000,
			additionalSeatYearlyPriceMinor: 190_000
		}
	}
});

function expectCode(value: unknown, code: WincrmSeatDurationErrorCode) {
	expect(() =>
		calculateWincrmSeatDuration(value as WincrmSeatDurationInput)
	).toThrow(new WincrmSeatDurationError(code));
}

describe('WinCRM paid seat-duration conversion', () => {
	it.each([
		{
			cycle: 'MONTHLY' as const,
			oldSeats: 2,
			newSeats: 3,
			old: 99_000n,
			next: 128_000n
		},
		{
			cycle: 'MONTHLY' as const,
			oldSeats: 4,
			newSeats: 2,
			old: 157_000n,
			next: 99_000n
		},
		{
			cycle: 'YEARLY' as const,
			oldSeats: 2,
			newSeats: 3,
			old: 990_000n,
			next: 1_180_000n
		},
		{
			cycle: 'YEARLY' as const,
			oldSeats: 5,
			newSeats: 2,
			old: 1_560_000n,
			next: 990_000n
		}
	])(
		'converts $cycle seats $oldSeats → $newSeats from the period snapshot',
		row => {
			const value = input();
			const result = calculateWincrmSeatDuration({
				...value,
				newTotalSeats: row.newSeats,
				period: {
					...value.period,
					cycle: row.cycle,
					totalSeats: row.oldSeats
				}
			});
			const expected = Number((BigInt(30 * DAY_MS) * row.old) / row.next);
			expect(result).toEqual({
				cycle: row.cycle,
				oldTotalSeats: row.oldSeats,
				newTotalSeats: row.newSeats,
				oldPeriodPriceMinor: row.old,
				newPeriodPriceMinor: row.next,
				oldRemainingMs: 30 * DAY_MS,
				newRemainingMs: expected,
				expiresAtMs: NOW + expected
			});
		}
	);

	it.each(['MONTHLY', 'YEARLY'] as const)(
		'keeps exact expiry for unchanged %s total price',
		cycle => {
			const value = input();
			for (const newTotalSeats of [2, 17]) {
				const result = calculateWincrmSeatDuration({
					...value,
					newTotalSeats,
					period: {
						...value.period,
						cycle,
						expiresAtMs: NOW + 123_457,
						priceSnapshot: {
							...value.period.priceSnapshot,
							additionalSeatMonthlyPriceMinor: 0,
							additionalSeatYearlyPriceMinor: 0
						}
					}
				});
				expect(result.expiresAtMs).toBe(NOW + 123_457);
				expect(result.oldPeriodPriceMinor).toBe(
					result.newPeriodPriceMinor
				);
			}
		}
	);

	it('rounds down milliseconds, never whole days, and preserves the included-seat floor', () => {
		const value = input();
		const result = calculateWincrmSeatDuration({
			...value,
			newTotalSeats: 6,
			period: {
				...value.period,
				totalSeats: 5,
				expiresAtMs: NOW + 1_001,
				priceSnapshot: {
					...value.period.priceSnapshot,
					includedSeats: 5,
					monthlyPriceMinor: 2,
					additionalSeatMonthlyPriceMinor: 1
				}
			}
		});
		expect(result.newRemainingMs).toBe(667);
		expect(result.expiresAtMs).toBe(NOW + 667);
		expect(result.oldPeriodPriceMinor).toBe(2n);
		expect(result.newPeriodPriceMinor).toBe(3n);
	});

	it('retains exact BigInt prices and products beyond Number precision', () => {
		const value = input();
		const result = calculateWincrmSeatDuration({
			...value,
			newTotalSeats: Number.MAX_SAFE_INTEGER,
			period: {
				...value.period,
				totalSeats: Number.MAX_SAFE_INTEGER - 1,
				expiresAtMs: NOW + 1_001,
				priceSnapshot: {
					...value.period.priceSnapshot,
					monthlyPriceMinor: Number.MAX_SAFE_INTEGER,
					additionalSeatMonthlyPriceMinor: Number.MAX_SAFE_INTEGER
				}
			}
		});
		const max = BigInt(Number.MAX_SAFE_INTEGER);
		expect(result.oldPeriodPriceMinor).toBe(max * (max - 2n));
		expect(result.newPeriodPriceMinor).toBe(max * (max - 1n));
		expect(result.newRemainingMs).toBe(1_000);
	});

	it.each(['MONTHLY', 'YEARLY'] as const)(
		'never creates paid time-value through %s round trips',
		cycle => {
			const value = input();
			for (const oldSeats of [2, 3, 7, 100]) {
				for (const newSeats of [2, 3, 7, 100]) {
					for (const remaining of [10_001, DAY_MS + 1, 30 * DAY_MS]) {
						const original = {
							...value,
							newTotalSeats: newSeats,
							period: {
								...value.period,
								cycle,
								totalSeats: oldSeats,
								expiresAtMs: NOW + remaining
							}
						};
						const converted = calculateWincrmSeatDuration(original);
						expect(
							BigInt(converted.newRemainingMs) *
								converted.newPeriodPriceMinor
						).toBeLessThanOrEqual(
							BigInt(remaining) * converted.oldPeriodPriceMinor
						);
						const reversed = calculateWincrmSeatDuration({
							...original,
							newTotalSeats: oldSeats,
							period: {
								...original.period,
								totalSeats: newSeats,
								expiresAtMs: converted.expiresAtMs
							}
						});
						expect(reversed.expiresAtMs).toBeLessThanOrEqual(
							original.period.expiresAtMs
						);
					}
				}
			}
		}
	);

	it('is deterministic, reads no ambient clock, and does not mutate snapshot metadata', () => {
		const value = input();
		const priceSnapshot = Object.freeze({
			...value.period.priceSnapshot,
			policyVersion: 42
		});
		const frozen = Object.freeze({
			...value,
			period: Object.freeze({ ...value.period, priceSnapshot })
		});
		const clock = jest.spyOn(Date, 'now').mockImplementation(() => {
			throw new Error('Ambient clock must not be read');
		});
		try {
			expect(calculateWincrmSeatDuration(frozen)).toEqual(
				calculateWincrmSeatDuration(frozen)
			);
			expect(priceSnapshot).toEqual({
				...value.period.priceSnapshot,
				policyVersion: 42
			});
		} finally {
			clock.mockRestore();
		}
	});

	it.each([
		{ kind: 'TRIAL' },
		{ kind: 'OTHER' },
		{ kind: ['PAID'] },
		{ status: 'GRACE' },
		{ status: 'READ_ONLY' },
		{ status: 'EXPIRED' },
		{ status: 'CANCELLED' },
		{ status: ['ACTIVE'] },
		{ startsAtMs: NOW + 1 },
		{ expiresAtMs: NOW },
		{ expiresAtMs: NOW - 1 },
		{ startsAtMs: NOW + DAY_MS, expiresAtMs: NOW - DAY_MS }
	])('rejects non-active-paid period %j', patch => {
		const value = input();
		expectCode(
			{ ...value, period: { ...value.period, ...patch } },
			'INVALID_PAID_PERIOD'
		);
	});

	it.each([undefined, null, [], {}, { period: null }, { period: [] }])(
		'fails closed on missing input shape %j',
		value => {
			expectCode(value, 'INVALID_INPUT');
		}
	);
	it.each(['TRIAL', 'WEEKLY', ['MONTHLY'], null])(
		'rejects unsupported billing cycle %j',
		cycle => {
			const value = input();
			expectCode(
				{ ...value, period: { ...value.period, cycle } },
				'INVALID_INPUT'
			);
		}
	);
	it.each([
		NaN,
		Infinity,
		-Infinity,
		1.5,
		'1000',
		null,
		Number.MAX_SAFE_INTEGER + 1,
		MAX_DATE_MS + 1,
		-MAX_DATE_MS - 1
	])('rejects noncanonical timestamp %j in every time field', invalid => {
		const value = input();
		expectCode({ ...value, nowMs: invalid }, 'INVALID_TIMESTAMP');
		for (const field of ['startsAtMs', 'expiresAtMs']) {
			expectCode(
				{ ...value, period: { ...value.period, [field]: invalid } },
				'INVALID_TIMESTAMP'
			);
		}
	});
	it.each([
		0,
		-1,
		1,
		2.5,
		NaN,
		Infinity,
		'3',
		['3'],
		Number.MAX_SAFE_INTEGER + 1
	])('rejects invalid old and new seat totals %j', seats => {
		const value = input();
		expectCode({ ...value, newTotalSeats: seats }, 'INVALID_SEAT_COUNT');
		expectCode(
			{ ...value, period: { ...value.period, totalSeats: seats } },
			'INVALID_SEAT_COUNT'
		);
	});
	it('enforces a snapshotted included-seat minimum above two', () => {
		const value = input();
		expectCode(
			{
				...value,
				newTotalSeats: 4,
				period: {
					...value.period,
					totalSeats: 5,
					priceSnapshot: {
						...value.period.priceSnapshot,
						includedSeats: 5
					}
				}
			},
			'INVALID_SEAT_COUNT'
		);
	});
	it.each([
		null,
		[],
		{},
		{ includedSeats: 1 },
		{ includedSeats: 2.5 },
		{ includedSeats: '2' },
		{ monthlyPriceMinor: 0 },
		{ yearlyPriceMinor: -1 },
		{ monthlyPriceMinor: 1.5 },
		{ yearlyPriceMinor: NaN },
		{ monthlyPriceMinor: '100' },
		{ additionalSeatMonthlyPriceMinor: -1 },
		{ additionalSeatYearlyPriceMinor: Infinity },
		{ additionalSeatMonthlyPriceMinor: Number.MAX_SAFE_INTEGER + 1 }
	])('rejects malformed snapshot %j', patch => {
		const value = input();
		const priceSnapshot =
			patch === null ||
			Array.isArray(patch) ||
			Object.keys(patch).length === 0
				? patch
				: { ...value.period.priceSnapshot, ...patch };
		expectCode(
			{ ...value, period: { ...value.period, priceSnapshot } },
			'INVALID_PRICE_SNAPSHOT'
		);
	});

	it('rejects a positive period whose converted duration floors to zero', () => {
		const value = input();
		expectCode(
			{ ...value, period: { ...value.period, expiresAtMs: NOW + 1 } },
			'ZERO_REMAINING_DURATION'
		);
	});
	it('allows exactly one remaining millisecond and startsAt equal to now', () => {
		const value = input();
		const result = calculateWincrmSeatDuration({
			...value,
			newTotalSeats: 2,
			period: { ...value.period, startsAtMs: NOW, expiresAtMs: NOW + 1 }
		});
		expect(result.newRemainingMs).toBe(1);
		expect(result.expiresAtMs).toBe(NOW + 1);
	});
	it('allows the inclusive JavaScript Date maximum but rejects extension beyond it', () => {
		const value = input();
		const boundary = {
			...value,
			nowMs: MAX_DATE_MS - 1,
			newTotalSeats: 2,
			period: {
				...value.period,
				startsAtMs: MAX_DATE_MS - 1,
				expiresAtMs: MAX_DATE_MS
			}
		};
		expect(calculateWincrmSeatDuration(boundary).expiresAtMs).toBe(
			MAX_DATE_MS
		);
		expectCode(
			{ ...boundary, period: { ...boundary.period, totalSeats: 100 } },
			'EXPIRY_OUT_OF_RANGE'
		);
	});
	it('allows the inclusive negative Date bound without number subtraction loss', () => {
		const value = input();
		const result = calculateWincrmSeatDuration({
			...value,
			nowMs: -MAX_DATE_MS,
			newTotalSeats: 2,
			period: {
				...value.period,
				startsAtMs: -MAX_DATE_MS,
				expiresAtMs: -MAX_DATE_MS + 1
			}
		});
		expect(result.newRemainingMs).toBe(1);
		expect(result.expiresAtMs).toBe(-MAX_DATE_MS + 1);
	});
	it('rejects a date-valid duration exceeding exact numeric result bounds', () => {
		const value = input();
		expectCode(
			{
				...value,
				nowMs: -MAX_DATE_MS,
				newTotalSeats: 2,
				period: {
					...value.period,
					startsAtMs: -MAX_DATE_MS,
					expiresAtMs: MAX_DATE_MS
				}
			},
			'DURATION_OUT_OF_RANGE'
		);
	});
	it('rejects a converted duration overflowing numeric bounds', () => {
		const value = input();
		expectCode(
			{
				...value,
				newTotalSeats: 2,
				period: {
					...value.period,
					totalSeats: Number.MAX_SAFE_INTEGER,
					priceSnapshot: {
						...value.period.priceSnapshot,
						monthlyPriceMinor: 1,
						additionalSeatMonthlyPriceMinor: Number.MAX_SAFE_INTEGER
					}
				}
			},
			'DURATION_OUT_OF_RANGE'
		);
	});
});
