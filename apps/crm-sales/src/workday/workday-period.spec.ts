import { BadRequestException } from '@nestjs/common';
import { workdayPeriod } from './workday-period';
import { WorkdayQuery } from './workday.dto';

const now = new Date('2026-09-06T22:30:00.000Z');
function period(patch: Partial<WorkdayQuery>) {
	const result = workdayPeriod(
		Object.assign(new WorkdayQuery(), patch),
		now
	);
	return result && [result.gte.toISOString(), result.lt.toISOString()];
}
describe('workday calendar periods', () => {
	it('uses the workspace date, not UTC or the process timezone', () => {
		expect(period({})).toEqual([
			'2026-09-06T21:00:00.000Z',
			'2026-09-07T21:00:00.000Z'
		]);
		expect(period({ period: 'TOMORROW' })).toEqual([
			'2026-09-07T21:00:00.000Z',
			'2026-09-08T21:00:00.000Z'
		]);
		expect(period({ period: 'WEEK' })).toEqual([
			'2026-09-06T21:00:00.000Z',
			'2026-09-13T21:00:00.000Z'
		]);
	});
	it.each([
		['2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
		['2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z']
	])('supports the DST calendar day %s', (from, start, end) => {
		expect(
			period({ period: 'DAY', from, timeZone: 'America/New_York' })
		).toEqual([start, end]);
	});
	it('handles fractional offsets and inclusive date ranges', () => {
		expect(
			period({
				period: 'RANGE',
				from: '2026-09-07',
				to: '2026-09-08',
				timeZone: 'Asia/Kathmandu'
			})
		).toEqual(['2026-09-06T18:15:00.000Z', '2026-09-08T18:15:00.000Z']);
	});
	it('does not fabricate a skipped calendar date', () => {
		expect(
			period({
				period: 'DAY',
				from: '2011-12-30',
				timeZone: 'Pacific/Apia'
			})
		).toEqual(['2011-12-30T10:00:00.000Z', '2011-12-30T10:00:00.000Z']);
	});
	it.each([
		{ timeZone: 'Not/AZone' },
		{ period: 'DAY' },
		{ period: 'DAY', from: '2026-02-30' },
		{ period: 'RANGE', from: '2026-09-08', to: '2026-09-07' },
		{ period: 'RANGE', from: '2026-09-08' },
		{ period: 'TODAY', from: '2026-09-08' },
		{ period: 'DAY', from: '2026-09-08', to: '2026-09-08' }
	])('rejects invalid or ambiguous filters %j', query => {
		expect(() => period(query as Partial<WorkdayQuery>)).toThrow(
			BadRequestException
		);
	});
	it('keeps all and overdue independent from a calendar window', () => {
		expect(period({ period: 'ALL' })).toBeNull();
		expect(period({ period: 'OVERDUE' })).toBeNull();
	});
});
