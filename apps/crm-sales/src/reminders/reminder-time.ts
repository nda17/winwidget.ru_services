/** Internal scheduling calculations only. They do not enable notification delivery,
 * create jobs, or define a public reminder-rule DTO. All instants are epoch ms. */
export interface ReminderQuietHours {
	readonly timeZone: string;
	readonly start: string;
	readonly end: string;
}
export interface ReminderOccurrencePlanInput {
	readonly anchorMs: number;
	/** Elapsed minutes from the immutable anchor, not a calendar task recurrence. */
	readonly intervalMinutes: number | null;
	readonly occurrenceCount: number;
	readonly firstIndex: number;
	/** Inclusive nominal-time cutoff. A deferred notBeforeMs may exceed it. */
	readonly throughMs: number;
	readonly limit: number;
	readonly quietHours?: ReminderQuietHours | null;
}
export interface ReminderOccurrence {
	readonly index: number;
	readonly nominalMs: number;
	readonly notBeforeMs: number;
}
export interface ReminderOccurrencePlan {
	readonly occurrences: readonly ReminderOccurrence[];
	readonly nextIndex: number;
	/** All configured indices have been planned, not necessarily sent/delivered. */
	readonly complete: boolean;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
// Explicit practical range bounds both Intl arithmetic and accidental huge rules.
const MIN_INSTANT = Date.parse('1970-01-01T00:00:00.000Z');
const MAX_INSTANT = Date.parse('2100-01-01T00:00:00.000Z');
const MAX_OCCURRENCES = 1_000;
const MAX_BATCH = 100;
const MAX_INTERVAL_MINUTES = 30 * 24 * 60;
const MAX_QUIET_SEARCH_MS = 3 * DAY_MS;
const MAX_QUIET_SEARCH_STEPS = 3 * 24 * 60 + 64;

function invalid(reason: string): never {
	throw new RangeError(`Invalid reminder time: ${reason}`);
}
function instant(value: number) {
	if (
		!Number.isSafeInteger(value) ||
		value < MIN_INSTANT ||
		value >= MAX_INSTANT
	)
		invalid('instant must be integer epoch ms in [1970, 2100)');
	return value;
}
function integer(value: number, minimum: number, maximum: number) {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
		invalid('integer is outside its supported range');
	return value;
}
function clock(value: string) {
	if (
		typeof value !== 'string' ||
		!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)
	)
		invalid('quiet hours require HH:mm');
	return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

function quietResolver(quiet: ReminderQuietHours | null | undefined) {
	if (quiet === null || quiet === undefined)
		return (value: number) => value;
	const start = clock(quiet.start);
	const end = clock(quiet.end);
	// Disabled is represented by null, never ambiguously by equal endpoints.
	if (start === end) invalid('quiet hours cannot cover an empty/full day');
	if (
		typeof quiet.timeZone !== 'string' ||
		quiet.timeZone.length > 128 ||
		!/^[-A-Za-z0-9_+]+(?:\/[-A-Za-z0-9_+]+)*$/.test(quiet.timeZone)
	)
		invalid('an explicit IANA time zone is required');
	let formatter: Intl.DateTimeFormat;
	try {
		formatter = new Intl.DateTimeFormat('en-GB', {
			timeZone: quiet.timeZone,
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
		invalid('unknown IANA time zone');
	}
	const local = (value: number) => {
		const parts = formatter.formatToParts(value);
		const part = (type: string) =>
			Number(parts.find(item => item.type === type)!.value);
		const minute = part('hour') * 60 + part('minute');
		const second = part('second');
		return {
			minute,
			second,
			offset:
				Date.UTC(
					part('year'),
					part('month') - 1,
					part('day'),
					part('hour'),
					part('minute'),
					second
				) -
				Math.floor(value / 1000) * 1000
		};
	};
	return (value: number): number => {
		let cursor = value;
		const deadline = Math.min(
			MAX_INSTANT - 1,
			value + MAX_QUIET_SEARCH_MS
		);
		for (let step = 0; step < MAX_QUIET_SEARCH_STEPS; step += 1) {
			const here = local(cursor);
			const quietNow =
				start < end
					? here.minute >= start && here.minute < end
					: here.minute >= start || here.minute < end;
			if (!quietNow) return cursor;
			// HH:mm covers every second of that local minute. Jump to its next
			// boundary, retaining sub-minute historical offsets (not process TZ).
			const next = Math.min(
				deadline,
				cursor + (60 - here.second) * 1000 - (cursor % 1000)
			);
			if (next <= cursor) break;
			if (local(next).offset !== here.offset) {
				// A clock jump can leave quiet hours before their nominal end. Find
				// its first instant, e.g. a fall-back from 01:59 to 01:00. Resolving
				// only a calendar "end" would miss this earlier allowed interval.
				let low = cursor + 1;
				let high = next;
				while (low < high) {
					const middle = Math.floor((low + high) / 2);
					if (local(middle).offset === here.offset) low = middle + 1;
					else high = middle;
				}
				cursor = low;
			} else cursor = next;
		}
		return invalid(
			'no allowed instant inside the bounded quiet-hours horizon'
		);
	};
}

/** Earliest instant >= input outside the recurring local [start, end) interval.
 * Midnight wrapping is supported; DST gaps skip nonexistent wall times, and
 * both occurrences of a folded local minute use the same quiet-hours predicate.
 * A fold that moves the clock out of quiet hours permits delivery immediately. */
export function nextAllowedReminderInstant(
	instantMs: number,
	quietHours: ReminderQuietHours | null = null
): number {
	return quietResolver(quietHours)(instant(instantMs));
}

/** Plan finite, indexed occurrences without restart drift. A scheduler persists
 * the cursor and uses task/rule/version + index + recipient/channel as identity.
 * Equal notBeforeMs values are deliberately NOT coalesced: doing so per batch
 * would change identities after a restart. The delivery policy must coalesce or
 * rate-limit catch-up before activating sends; these helpers never send mail.
 * Quiet-hour adjustment affects only notBeforeMs, never the anchor or next index. */
export function planReminderOccurrences(
	input: ReminderOccurrencePlanInput
): ReminderOccurrencePlan {
	const anchor = instant(input.anchorMs);
	const through = instant(input.throughMs);
	const count = integer(input.occurrenceCount, 1, MAX_OCCURRENCES);
	const first = integer(input.firstIndex, 0, count);
	const limit = integer(input.limit, 1, MAX_BATCH);
	const interval =
		input.intervalMinutes === null
			? 0
			: integer(input.intervalMinutes, 1, MAX_INTERVAL_MINUTES) *
				MINUTE_MS;
	if (interval === 0 && count !== 1)
		invalid('one-shot rules have exactly one occurrence');
	instant(anchor + (count - 1) * interval);
	const allowed = quietResolver(input.quietHours);
	const occurrences: ReminderOccurrence[] = [];
	let nextIndex = first;
	let lastAllowed: number | undefined;
	while (nextIndex < count && occurrences.length < limit) {
		const nominalMs = anchor + nextIndex * interval;
		if (nominalMs > through) break;
		// Everything between the previous candidate and its first allowed instant
		// is quiet, so ordered nearby occurrences can reuse that bounded scan.
		const notBeforeMs =
			lastAllowed !== undefined && nominalMs <= lastAllowed
				? lastAllowed
				: allowed(nominalMs);
		occurrences.push({ index: nextIndex, nominalMs, notBeforeMs });
		lastAllowed = notBeforeMs;
		nextIndex += 1;
	}
	return { occurrences, nextIndex, complete: nextIndex === count };
}
