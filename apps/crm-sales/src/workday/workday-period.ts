import { BadRequestException } from '@nestjs/common';
import type { WorkdayQuery } from './workday.dto';

function invalid(): never {
	throw new BadRequestException('Некорректный период или часовой пояс');
}
function utcDay(day: string) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) invalid();
	const time = Date.parse(`${day}T00:00:00.000Z`);
	if (
		!Number.isFinite(time) ||
		new Date(time).toISOString().slice(0, 10) !== day
	)
		invalid();
	return time;
}
function shift(day: string, days: number) {
	const value = new Date(utcDay(day) + days * 86400000)
		.toISOString()
		.slice(0, 10);
	utcDay(value);
	return value;
}

/** Calendar boundaries in the requested IANA zone, including short/long DST days. */
export function workdayPeriod(query: WorkdayQuery, now: Date) {
	let formatter: Intl.DateTimeFormat;
	try {
		formatter = new Intl.DateTimeFormat('en-CA', {
			timeZone: query.timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			calendar: 'iso8601',
			numberingSystem: 'latn'
		});
	} catch {
		invalid();
	}
	const dayAt = (value: number) => {
		const parts = formatter.formatToParts(new Date(value));
		return ['year', 'month', 'day']
			.map(key =>
				parts
					.find(part => part.type === key)!
					.value.padStart(key === 'year' ? 4 : 2, '0')
			)
			.join('-');
	};
	const start = (day: string) => {
		const center = utcDay(day);
		// Find the first instant of a local date. A skipped calendar day is an
		// empty interval, not a fabricated 24-hour period.
		let low = center - 36 * 3600000,
			high = center + 36 * 3600000;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (dayAt(middle) < day) low = middle + 1;
			else high = middle;
		}
		return new Date(low);
	};
	if (
		!['DAY', 'RANGE'].includes(query.period) &&
		(query.from !== undefined || query.to !== undefined)
	)
		invalid();
	if (query.period === 'ALL' || query.period === 'OVERDUE') return null;
	let from = dayAt(now.getTime()),
		to = from;
	if (query.period === 'TOMORROW') from = to = shift(from, 1);
	if (query.period === 'WEEK') {
		from = shift(from, -((new Date(utcDay(from)).getUTCDay() + 6) % 7));
		to = shift(from, 6);
	}
	if (query.period === 'DAY' || query.period === 'RANGE') {
		if (!query.from || (query.period === 'DAY' && query.to !== undefined))
			invalid();
		from = query.from;
		to = query.period === 'DAY' ? from : query.to || invalid();
		utcDay(from);
		utcDay(to);
		if (from > to) invalid();
	}
	return { gte: start(from), lt: start(shift(to, 1)) };
}
