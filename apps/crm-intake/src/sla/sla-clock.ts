import { parseSlaRule, type SlaRuleConfig } from './sla.contract';

const DAY = 86_400_000;
/** Owner-local calendar, no dependence on process TZ. Repeated wall times use
 * the earlier instant; nonexistent times move forward by the DST gap. Working
 * minutes are elapsed minutes inside these local-day windows, including folds. */
export function slaDeadline(
	receivedAt: Date,
	config: SlaRuleConfig
): Date {
	parseSlaRule(config);
	if (!Number.isFinite(receivedAt.getTime()))
		throw new Error('INVALID_SLA_DATE');
	const format = new Intl.DateTimeFormat('en-GB', {
		timeZone: config.timeZone,
		calendar: 'iso8601',
		numberingSystem: 'latn',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23'
	});
	const stamp = (instant: number) => {
		const parts = format.formatToParts(instant);
		const [y, m, d, h, min, sec] = [
			'year',
			'month',
			'day',
			'hour',
			'minute',
			'second'
		].map(key => Number(parts.find(part => part.type === key)!.value));
		return Date.UTC(y, m - 1, d, h, min, sec);
	};
	const wallInstant = (wall: number) => {
		const offsets = new Set<number>();
		for (let delta = -2; delta <= 2; delta++) {
			const sample = wall + delta * DAY;
			offsets.add(stamp(sample) - sample);
		}
		const candidates = [...offsets]
			.map(offset => wall - offset)
			.sort((a, b) => a - b);
		const exact = candidates.find(value => stamp(value) === wall);
		if (exact !== undefined) return exact;
		const after = candidates
			.filter(value => stamp(value) > wall)
			.sort((a, b) => stamp(a) - stamp(b));
		if (after[0] === undefined) throw new Error('SLA_CALENDAR_UNRESOLVED');
		return after[0];
	};
	let remaining = config.workingMinutes * 60000;
	const localDay = Math.floor(stamp(receivedAt.getTime()) / DAY) * DAY;
	const clockMs = (clock: string) =>
		Number(clock.slice(0, 2)) * 3600000 + Number(clock.slice(3)) * 60000;
	// Minimum 30-minute window, 1+ weekday and <=1440 minutes bound the search.
	for (let offset = 0; offset < 370; offset++) {
		const day = localDay + offset * DAY;
		if (!config.weekdays.includes(new Date(day).getUTCDay() || 7))
			continue;
		const start = Math.max(
			receivedAt.getTime(),
			wallInstant(day + clockMs(config.workStart))
		);
		const end = wallInstant(day + clockMs(config.workEnd));
		const available = Math.max(0, end - start);
		if (remaining <= available) return new Date(start + remaining);
		remaining -= available;
	}
	throw new Error('SLA_CALENDAR_LIMIT');
}
