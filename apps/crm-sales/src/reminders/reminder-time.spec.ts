import {
	nextAllowedReminderInstant,
	planReminderOccurrences,
	type ReminderOccurrencePlanInput,
	type ReminderQuietHours
} from './reminder-time';

const ms = (value: string) => Date.parse(value);
const iso = (value: number) => new Date(value).toISOString();
const quiet: ReminderQuietHours = {
	timeZone: 'Europe/Moscow',
	start: '22:00',
	end: '08:00'
};
const next = (value: string, patch: Partial<ReminderQuietHours> = {}) =>
	iso(nextAllowedReminderInstant(ms(value), { ...quiet, ...patch }));
const base: ReminderOccurrencePlanInput = {
	anchorMs: ms('2026-09-07T18:00:42.123Z'),
	intervalMinutes: 60,
	occurrenceCount: 24,
	firstIndex: 0,
	throughMs: ms('2026-09-08T17:00:42.123Z'),
	limit: 100,
	quietHours: quiet
};

describe('next allowed reminder instant', () => {
	it('does not change an allowed instant or round away its milliseconds', () => {
		expect(next('2026-09-07T18:59:59.999Z')).toBe(
			'2026-09-07T18:59:59.999Z'
		);
		expect(nextAllowedReminderInstant(base.anchorMs, null)).toBe(
			base.anchorMs
		);
	});
	it('treats start as inclusive and end as exclusive across local midnight', () => {
		expect(next('2026-09-07T19:00:00.000Z')).toBe(
			'2026-09-08T05:00:00.000Z'
		);
		expect(next('2026-09-07T23:45:12.999Z')).toBe(
			'2026-09-08T05:00:00.000Z'
		);
		expect(next('2026-09-08T04:59:59.999Z')).toBe(
			'2026-09-08T05:00:00.000Z'
		);
		expect(next('2026-09-08T05:00:00.000Z')).toBe(
			'2026-09-08T05:00:00.000Z'
		);
	});
	it('handles same-day quiet hours and exactly midnight endpoints', () => {
		expect(
			next('2026-09-07T09:30:01.456Z', { start: '12:00', end: '13:00' })
		).toBe('2026-09-07T10:00:00.000Z');
		expect(
			next('2026-09-07T09:00:00.000Z', { start: '00:00', end: '12:00' })
		).toBe('2026-09-07T09:00:00.000Z');
		expect(next('2026-09-07T20:59:59.999Z', { end: '00:00' })).toBe(
			'2026-09-07T21:00:00.000Z'
		);
	});
	it('uses fractional IANA offsets, never the process timezone', () => {
		expect(
			next('2026-09-07T16:15:00.000Z', { timeZone: 'Asia/Kathmandu' })
		).toBe('2026-09-08T02:15:00.000Z');
		expect(
			next('2026-09-07T22:30:00.000Z', { timeZone: 'America/New_York' })
		).toBe('2026-09-07T22:30:00.000Z');
	});
	it('handles a spring gap without fabricating a nonexistent quiet-end wall time', () => {
		expect(
			next('2026-03-08T06:45:00.123Z', {
				timeZone: 'America/New_York',
				start: '01:30',
				end: '02:30'
			})
		).toBe('2026-03-08T07:00:00.000Z');
		expect(
			next('2026-03-08T06:45:00.123Z', {
				timeZone: 'America/New_York',
				start: '22:00',
				end: '03:30'
			})
		).toBe('2026-03-08T07:30:00.000Z');
	});
	it('resolves each instance of a folded quiet minute against the real instant', () => {
		const repeated = {
			timeZone: 'America/New_York',
			start: '01:30',
			end: '01:45'
		};
		expect(next('2026-11-01T05:40:00.000Z', repeated)).toBe(
			'2026-11-01T05:45:00.000Z'
		);
		expect(next('2026-11-01T06:40:00.000Z', repeated)).toBe(
			'2026-11-01T06:45:00.000Z'
		);
		expect(next('2026-11-01T05:50:00.000Z', repeated)).toBe(
			'2026-11-01T05:50:00.000Z'
		);
	});
	it('allows the first post-fold instant if a backward jump leaves the quiet interval', () => {
		expect(
			next('2026-11-01T05:50:00.000Z', {
				timeZone: 'America/New_York',
				start: '01:30',
				end: '02:30'
			})
		).toBe('2026-11-01T06:00:00.000Z');
	});
	it('keeps overnight quiet hours through the extra folded hour', () => {
		expect(
			next('2026-11-01T05:50:00.000Z', {
				timeZone: 'America/New_York',
				start: '22:00',
				end: '02:30'
			})
		).toBe('2026-11-01T07:30:00.000Z');
	});
	it('continues to the following day if the only allowed minute is skipped by DST', () => {
		expect(
			next('2026-03-08T06:00:00.000Z', {
				timeZone: 'America/New_York',
				start: '02:31',
				end: '02:30'
			})
		).toBe('2026-03-09T06:30:00.000Z');
	});
	it('supports a half-hour DST jump and a skipped calendar day', () => {
		expect(
			next('2026-10-03T15:15:00.000Z', {
				timeZone: 'Australia/Lord_Howe',
				start: '01:30',
				end: '02:15'
			})
		).toBe('2026-10-03T15:30:00.000Z');
		expect(
			next('2011-12-30T09:30:00.000Z', { timeZone: 'Pacific/Apia' })
		).toBe('2011-12-30T18:00:00.000Z');
	});
	it('retains historical sub-minute UTC offsets in local minute boundaries', () => {
		expect(
			next('1971-01-01T12:44:45.250Z', {
				timeZone: 'Africa/Monrovia',
				start: '12:00',
				end: '12:01'
			})
		).toBe('1971-01-01T12:45:30.000Z');
	});
	it.each([
		'',
		'Not/AZone',
		' Europe/Moscow',
		'+03:00',
		'Europe/Moscow ',
		'a'.repeat(129)
	])(
		'rejects invalid zone %s even when the instant might otherwise be allowed',
		timeZone => {
			expect(() =>
				nextAllowedReminderInstant(base.anchorMs, { ...quiet, timeZone })
			).toThrow(RangeError);
		}
	);
	it.each(['', '8:00', '24:00', '08:60', '08:00:00', ' 08:00', '00:00Z'])(
		'rejects invalid HH:mm %s',
		value => {
			expect(() =>
				nextAllowedReminderInstant(base.anchorMs, {
					...quiet,
					start: value
				})
			).toThrow(RangeError);
			expect(() =>
				nextAllowedReminderInstant(base.anchorMs, { ...quiet, end: value })
			).toThrow(RangeError);
		}
	);
	it('rejects equal endpoints rather than silently disabling or blocking all delivery', () => {
		expect(() =>
			nextAllowedReminderInstant(base.anchorMs, {
				...quiet,
				end: quiet.start
			})
		).toThrow(RangeError);
	});
	it.each([
		NaN,
		Infinity,
		-Infinity,
		0.5,
		-1,
		ms('2100-01-01T00:00:00.000Z')
	])('rejects unsupported instant %s', value => {
		expect(() => nextAllowedReminderInstant(value, null)).toThrow(
			RangeError
		);
	});
	it('fails closed if deferral would leave the supported instant range', () => {
		expect(() =>
			next('2099-12-31T23:59:59.999Z', { timeZone: 'UTC' })
		).toThrow(RangeError);
	});
});

describe('anchored finite reminder occurrences', () => {
	it('keeps nominal repeat instants on the immutable anchor instead of the quiet-hour shift', () => {
		const result = planReminderOccurrences(base);
		expect(result.occurrences).toHaveLength(24);
		expect(result.nextIndex).toBe(24);
		expect(result.complete).toBe(true);
		expect(result.occurrences[1]).toEqual({
			index: 1,
			nominalMs: ms('2026-09-07T19:00:42.123Z'),
			notBeforeMs: ms('2026-09-08T05:00:00.000Z')
		});
		result.occurrences.forEach(row => {
			expect(row.nominalMs).toBe(base.anchorMs + row.index * 3_600_000);
			expect(row.notBeforeMs).toBeGreaterThanOrEqual(row.nominalMs);
			expect(nextAllowedReminderInstant(row.notBeforeMs, quiet)).toBe(
				row.notBeforeMs
			);
		});
	});
	it('produces identical indexes and instants after restart and across batch boundaries', () => {
		const input = Object.freeze({
			...base,
			quietHours: Object.freeze({ ...quiet })
		});
		const all = planReminderOccurrences(input);
		const first = planReminderOccurrences({ ...input, limit: 5 });
		const second = planReminderOccurrences({
			...input,
			firstIndex: first.nextIndex,
			limit: 7
		});
		const third = planReminderOccurrences({
			...input,
			firstIndex: second.nextIndex
		});
		expect([
			...first.occurrences,
			...second.occurrences,
			...third.occurrences
		]).toEqual(all.occurrences);
		expect(planReminderOccurrences(input)).toEqual(all);
	});
	it('does not silently coalesce quiet-hour collisions or make identity depend on a batch limit', () => {
		const result = planReminderOccurrences({ ...base, limit: 10 });
		const night = result.occurrences.slice(1);
		expect(new Set(night.map(row => row.notBeforeMs)).size).toBe(1);
		expect(new Set(night.map(row => row.index)).size).toBe(9);
		expect(result.nextIndex).toBe(10);
		expect(result.complete).toBe(false);
	});
	it('applies the cutoff to nominal time and leaves future dispatch time explicit', () => {
		const result = planReminderOccurrences({
			...base,
			firstIndex: 1,
			throughMs: ms('2026-09-07T19:00:42.123Z')
		});
		expect(result.occurrences).toHaveLength(1);
		expect(result.occurrences[0].notBeforeMs).toBeGreaterThan(
			ms('2026-09-07T19:00:42.123Z')
		);
		expect(result.nextIndex).toBe(2);
		expect(result.complete).toBe(false);
	});
	it('handles not-yet-due, exhausted and single-shot schedules without inventing occurrences', () => {
		expect(
			planReminderOccurrences({ ...base, throughMs: base.anchorMs - 1 })
		).toEqual({ occurrences: [], nextIndex: 0, complete: false });
		expect(planReminderOccurrences({ ...base, firstIndex: 24 })).toEqual({
			occurrences: [],
			nextIndex: 24,
			complete: true
		});
		const once = planReminderOccurrences({
			...base,
			intervalMinutes: null,
			occurrenceCount: 1,
			quietHours: null
		});
		expect(once).toEqual({
			occurrences: [
				{ index: 0, nominalMs: base.anchorMs, notBeforeMs: base.anchorMs }
			],
			nextIndex: 1,
			complete: true
		});
	});
	it.each([
		['2026-03-08T05:30:12.123Z', '2026-03-08T10:30:12.123Z'],
		['2026-11-01T04:30:12.123Z', '2026-11-01T09:30:12.123Z']
	])(
		'does not drift an elapsed repeat sequence through DST from %s',
		(anchor, through) => {
			const input = {
				...base,
				anchorMs: ms(anchor),
				throughMs: ms(through),
				occurrenceCount: 6,
				quietHours: {
					...quiet,
					timeZone: 'America/New_York',
					end: '03:30'
				}
			};
			const all = planReminderOccurrences(input);
			for (let index = 0; index < 6; index += 1) {
				expect(
					planReminderOccurrences({
						...input,
						firstIndex: index,
						limit: 1
					}).occurrences[0]
				).toEqual(all.occurrences[index]);
				expect(all.occurrences[index].nominalMs).toBe(
					input.anchorMs + index * 3_600_000
				);
			}
		}
	);
	it.each([
		{ occurrenceCount: 0 },
		{ occurrenceCount: 1001 },
		{ occurrenceCount: 1.5 },
		{ intervalMinutes: 0 },
		{ intervalMinutes: -1 },
		{ intervalMinutes: 1.5 },
		{ intervalMinutes: 43201 },
		{ intervalMinutes: null },
		{ firstIndex: -1 },
		{ firstIndex: 25 },
		{ firstIndex: 0.5 },
		{ limit: 0 },
		{ limit: 101 },
		{ limit: 1.5 },
		{ anchorMs: NaN },
		{ throughMs: NaN },
		{ anchorMs: ms('2099-12-31T23:00:00.000Z') }
	])('rejects invalid ranges and overflowing schedules %j', patch => {
		expect(() => planReminderOccurrences({ ...base, ...patch })).toThrow(
			RangeError
		);
	});
	it('bounds catch-up work at 100 occurrences and accepts the finite maximum count', () => {
		const result = planReminderOccurrences({
			...base,
			intervalMinutes: 1,
			occurrenceCount: 1000,
			quietHours: null
		});
		expect(result.occurrences).toHaveLength(100);
		expect(result.nextIndex).toBe(100);
		expect(result.complete).toBe(false);
	});
});
