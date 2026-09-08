export interface RecurrenceSchedule {
	frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
	startDate: string;
	localTime: string;
	timeZone: string;
}

const DAY = 86_400_000;
const invalid = (): never => {
	throw new RangeError('Invalid task recurrence schedule');
};
function day(value: string) {
	const instant = Date.parse(`${value}T00:00:00.000Z`);
	if (
		!/^20\d{2}-\d{2}-\d{2}$/.test(value) ||
		!Number.isFinite(instant) ||
		new Date(instant).toISOString().slice(0, 10) !== value
	)
		invalid();
	return instant;
}
function formatter(timeZone: string) {
	if (typeof timeZone !== 'string' || timeZone.length > 100) invalid();
	try {
		return new Intl.DateTimeFormat('en-GB', {
			timeZone,
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
	} catch {
		return invalid();
	}
}
function localParts(format: Intl.DateTimeFormat, instant: number) {
	const parts = format.formatToParts(instant);
	return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(key =>
		Number(parts.find(part => part.type === key)!.value)
	);
}
function localStamp(format: Intl.DateTimeFormat, instant: number) {
	const [year, month, date, hour, minute, second] = localParts(
		format,
		instant
	);
	return Date.UTC(year, month - 1, date, hour, minute, second);
}
/** Explicit wall-clock resolution. Folds choose the earlier occurrence; gaps
 * move forward by the clock jump. Neither the process TZ nor the previous
 * occurrence's offset determines future dates. */
function wallInstant(
	date: string,
	clock: string,
	format: Intl.DateTimeFormat
) {
	const wall =
		day(date) +
		Number(clock.slice(0, 2)) * 3_600_000 +
		Number(clock.slice(3)) * 60_000;
	const offsets = new Set<number>();
	for (let delta = -2; delta <= 2; delta++) {
		const sample = wall + delta * DAY;
		offsets.add(localStamp(format, sample) - sample);
	}
	const candidates = [...offsets]
		.map(offset => wall - offset)
		.sort((a, b) => a - b);
	const exact = candidates.find(
		value => localStamp(format, value) === wall
	);
	if (exact !== undefined) return exact;
	const after = candidates
		.filter(value => localStamp(format, value) > wall)
		.sort((a, b) => localStamp(format, a) - localStamp(format, b));
	return after[0] ?? invalid();
}
export function validateRecurrenceSchedule(schedule: RecurrenceSchedule) {
	if (
		!['DAILY', 'WEEKLY', 'MONTHLY'].includes(schedule.frequency) ||
		!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.localTime)
	)
		invalid();
	day(schedule.startDate);
	formatter(schedule.timeZone);
}
export function recurrenceDate(
	schedule: RecurrenceSchedule,
	index: number
) {
	validateRecurrenceSchedule(schedule);
	if (!Number.isSafeInteger(index) || index < 0 || index > 40_000)
		invalid();
	const start = new Date(day(schedule.startDate));
	let date: Date;
	if (schedule.frequency === 'MONTHLY') {
		const first = new Date(
			Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1)
		);
		const last = new Date(
			Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)
		).getUTCDate();
		date = new Date(
			Date.UTC(
				first.getUTCFullYear(),
				first.getUTCMonth(),
				Math.min(start.getUTCDate(), last)
			)
		);
	} else
		date = new Date(
			start.getTime() +
				index * DAY * (schedule.frequency === 'WEEKLY' ? 7 : 1)
		);
	const value = date.toISOString().slice(0, 10);
	day(value);
	return value;
}
export function recurrenceOccurrence(
	schedule: RecurrenceSchedule,
	index: number
) {
	const date = recurrenceDate(schedule, index),
		format = formatter(schedule.timeZone);
	return {
		index,
		localDate: date,
		// A task becomes available at the beginning of its local work day, not
		// only when its deadline has already passed.
		availableAt: new Date(wallInstant(date, '00:00', format)),
		dueAt: new Date(wallInstant(date, schedule.localTime, format))
	};
}
/** One latest applicable period after downtime; the caller persists nextIndex
 * together with its unique occurrence and task. Missed periods are not replayed. */
export function currentRecurrence(
	schedule: RecurrenceSchedule,
	nextIndex: number,
	now: Date
) {
	validateRecurrenceSchedule(schedule);
	const [year, month, date] = localParts(
		formatter(schedule.timeZone),
		now.getTime()
	);
	const today = Date.UTC(year, month - 1, date),
		start = new Date(day(schedule.startDate));
	let index =
		schedule.frequency === 'MONTHLY'
			? (year - start.getUTCFullYear()) * 12 +
				month -
				1 -
				start.getUTCMonth()
			: Math.floor(
					(today - start.getTime()) /
						DAY /
						(schedule.frequency === 'WEEKLY' ? 7 : 1)
				);
	if (index < nextIndex) return null;
	let occurrence = recurrenceOccurrence(schedule, index);
	if (occurrence.availableAt > now) {
		index -= 1;
		if (index < nextIndex) return null;
		occurrence = recurrenceOccurrence(schedule, index);
	}
	return occurrence.availableAt <= now ? occurrence : null;
}
