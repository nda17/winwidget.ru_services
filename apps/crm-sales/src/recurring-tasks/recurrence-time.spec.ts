import {
	currentRecurrence,
	recurrenceDate,
	recurrenceOccurrence,
	validateRecurrenceSchedule,
	type RecurrenceSchedule
} from './recurrence-time';

const base: RecurrenceSchedule = {
	frequency: 'DAILY',
	startDate: '2026-09-01',
	localTime: '09:30',
	timeZone: 'Europe/Moscow'
};
describe('calendar task recurrence', () => {
	it('makes the task available at local midnight and preserves its deadline', () => {
		const occurrence = recurrenceOccurrence(base, 1);
		expect(occurrence.availableAt.toISOString()).toBe(
			'2026-09-01T21:00:00.000Z'
		);
		expect(occurrence.dueAt.toISOString()).toBe(
			'2026-09-02T06:30:00.000Z'
		);
	});
	it('coalesces downtime to one latest period and restart does not repeat it', () => {
		const now = new Date('2026-09-08T08:00:00.000Z');
		const result = currentRecurrence(base, 0, now)!;
		expect(result.index).toBe(7);
		expect(currentRecurrence(base, 8, now)).toBeNull();
	});
	it('has no occurrence before the initial local date', () => {
		expect(
			currentRecurrence(base, 0, new Date('2026-08-31T20:59:59.000Z'))
		).toBeNull();
	});
	it('uses the anchored weekday, including across the year boundary', () => {
		const weekly = {
			...base,
			frequency: 'WEEKLY' as const,
			startDate: '2026-12-29'
		};
		expect(recurrenceDate(weekly, 1)).toBe('2027-01-05');
		expect(
			currentRecurrence(weekly, 0, new Date('2027-01-04T12:00:00Z'))?.index
		).toBe(0);
	});
	it('clamps January 31 in February without drifting March to the 28th', () => {
		const monthly = {
			...base,
			frequency: 'MONTHLY' as const,
			startDate: '2026-01-31'
		};
		expect([0, 1, 2].map(index => recurrenceDate(monthly, index))).toEqual(
			['2026-01-31', '2026-02-28', '2026-03-31']
		);
		expect(
			currentRecurrence(monthly, 0, new Date('2026-03-01T12:00:00Z'))
				?.index
		).toBe(1);
	});
	it('retains leap-day intent for monthly series', () => {
		expect(
			recurrenceDate(
				{ ...base, frequency: 'MONTHLY', startDate: '2028-01-31' },
				1
			)
		).toBe('2028-02-29');
	});
	it('moves a DST gap forward and resolves a fold to the first occurrence', () => {
		expect(
			recurrenceOccurrence(
				{
					...base,
					startDate: '2026-03-08',
					localTime: '02:30',
					timeZone: 'America/New_York'
				},
				0
			).dueAt.toISOString()
		).toBe('2026-03-08T07:30:00.000Z');
		expect(
			recurrenceOccurrence(
				{
					...base,
					startDate: '2026-11-01',
					localTime: '01:30',
					timeZone: 'America/New_York'
				},
				0
			).dueAt.toISOString()
		).toBe('2026-11-01T05:30:00.000Z');
	});
	it('uses the same period index when editing only future wall time or timezone', () => {
		expect(
			currentRecurrence(
				{ ...base, localTime: '15:00', timeZone: 'Asia/Vladivostok' },
				8,
				new Date('2026-09-08T12:00:00Z')
			)
		).toBeNull();
	});
	it.each([
		{ timeZone: 'Not/AZone' },
		{ startDate: '2026-02-30' },
		{ localTime: '24:00' },
		{ frequency: 'YEARLY' }
	])('rejects malformed schedule %j', patch => {
		expect(() =>
			validateRecurrenceSchedule({
				...base,
				...patch
			} as RecurrenceSchedule)
		).toThrow(RangeError);
	});
});
