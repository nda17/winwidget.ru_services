import { nextAllowedReminderInstant } from './reminder-time';

/** Pure v1 rule contract. Parsing neither authorizes the actor nor schedules or
 * sends notifications. Workspace identity, command/version CAS and current
 * membership/role/channel eligibility are the service's responsibility. */
export interface ReminderBinding {
	readonly subject: string;
	/** Null is structurally allowed only to represent the workspace-owner case.
	 * The service must prove that case; null never means "any/current membership". */
	readonly membershipId: string | null;
}
export type ReminderChannel = 'EMAIL' | 'TELEGRAM';
export type ReminderRecipients =
	| { readonly kind: 'SELF' | 'ASSIGNEE' | 'TEAM_LEADS' | 'WORKSPACE' }
	| {
			readonly kind: 'SELECTED';
			readonly bindings: readonly ReminderBinding[];
	  };
export interface ReminderRuleV1 {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly scope: 'WORKSPACE' | 'PERSONAL';
	readonly ownerBinding: ReminderBinding;
	readonly title: string;
	readonly enabled: boolean;
	readonly channels: readonly ReminderChannel[];
	readonly trigger: {
		readonly kind: 'BEFORE_DUE' | 'AT_DUE' | 'AFTER_DUE';
		readonly offsetMinutes: number;
	};
	/** Count includes the first occurrence; null is a single occurrence. */
	readonly repeats: {
		readonly intervalMinutes: number;
		readonly count: number;
	} | null;
	readonly timeZone: string;
	readonly quietHours: {
		readonly start: string;
		readonly end: string;
	} | null;
	/** PERSONAL is SELF only, applied to tasks assigned to that exact owner
	 * binding, not every task visible to an OWNER. Enforced by the service. */
	readonly recipients: ReminderRecipients;
}
export interface ReminderRuleParseOptions {
	/** Only create accepts an omitted enabled field and defaults it to false. */
	readonly create?: boolean;
}

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNSAFE_SUBJECT = /[\s\x00-\x1f\x7f]/;
const VALIDATION_INSTANT = Date.UTC(2026, 0, 15, 12);

function invalid(reason: string): never {
	// Do not include supplied values: titles/bindings may contain personal data.
	throw new RangeError(`Invalid reminder rule: ${reason}`);
}
function own(value: object, key: PropertyKey): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}
function record(
	value: unknown,
	keys: readonly string[],
	optional: readonly string[] = []
): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== 'object' ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	)
		invalid('an exact plain object is required');
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (
		Reflect.ownKeys(value).some(
			key =>
				typeof key !== 'string' ||
				!keys.includes(key) ||
				!descriptors[key].enumerable ||
				!own(descriptors[key], 'value')
		) ||
		keys.some(key => !optional.includes(key) && !own(value, key))
	)
		invalid('missing, unknown or non-data fields');
	return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
	if (
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		value < min ||
		value > max ||
		Object.is(value, -0)
	)
		invalid('integer is outside its supported range');
	return value;
}
function uuid(value: unknown): string {
	if (
		typeof value !== 'string' ||
		value.length !== 36 ||
		!UUID.test(value)
	)
		invalid('UUID v4 is required');
	return value;
}
function binding(value: unknown): ReminderBinding {
	const input = record(value, ['subject', 'membershipId']);
	if (
		typeof input.subject !== 'string' ||
		input.subject.length < 1 ||
		input.subject.length > 256 ||
		UNSAFE_SUBJECT.test(input.subject)
	)
		invalid('an exact subject is required');
	return Object.freeze({
		subject: input.subject,
		membershipId:
			input.membershipId === null ? null : uuid(input.membershipId)
	});
}
function array(value: unknown, maximum: number): unknown[] {
	if (
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype ||
		value.length > maximum ||
		Reflect.ownKeys(value).length !== value.length + 1
	)
		invalid('a bounded dense array is required');
	for (let index = 0; index < value.length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, index);
		if (!descriptor?.enumerable || !own(descriptor, 'value'))
			invalid('array items must be data values');
	}
	return value;
}
function recipients(
	value: unknown,
	scope: ReminderRuleV1['scope']
): ReminderRecipients {
	// Inspect only after rejecting accessors/prototype data and unknown keys.
	const input = record(value, ['kind', 'bindings'], ['bindings']);
	if (scope === 'PERSONAL') {
		if (input.kind !== 'SELF' || own(input, 'bindings'))
			invalid('personal rules require SELF without explicit recipients');
		return Object.freeze({ kind: 'SELF' });
	}
	if (input.kind === 'SELECTED') {
		const selected = array(input.bindings, 100).map(binding);
		if (selected.length === 0)
			invalid('selected recipients cannot be empty');
		const exactPairs = selected.map(item =>
			JSON.stringify([
				item.subject,
				item.membershipId?.toLowerCase() ?? null
			])
		);
		if (new Set(exactPairs).size !== selected.length)
			invalid('duplicate selected bindings');
		// Code-point ordering, never locale-dependent. Preserve identifiers verbatim.
		selected.sort((left, right) => {
			const a = JSON.stringify([left.subject, left.membershipId]);
			const b = JSON.stringify([right.subject, right.membershipId]);
			return a < b ? -1 : a > b ? 1 : 0;
		});
		return Object.freeze({
			kind: 'SELECTED',
			bindings: Object.freeze(selected)
		});
	}
	if (
		(input.kind !== 'ASSIGNEE' &&
			input.kind !== 'TEAM_LEADS' &&
			input.kind !== 'WORKSPACE') ||
		own(input, 'bindings')
	)
		invalid('invalid workspace recipient selector');
	return Object.freeze({ kind: input.kind });
}

/** Explicit copies and deep freezing prevent callers from changing a parsed
 * command or its stable hash by later mutating an input array/object. */
export function parseReminderRule(
	value: unknown,
	options: ReminderRuleParseOptions = {}
): ReminderRuleV1 {
	const input = record(
		value,
		[
			'schemaVersion',
			'id',
			'scope',
			'ownerBinding',
			'title',
			'enabled',
			'channels',
			'trigger',
			'repeats',
			'timeZone',
			'quietHours',
			'recipients'
		],
		options.create === true ? ['enabled'] : []
	);
	if (input.schemaVersion !== 1) invalid('unsupported schema version');
	if (input.scope !== 'WORKSPACE' && input.scope !== 'PERSONAL')
		invalid('invalid scope');
	if (
		typeof input.title !== 'string' ||
		input.title.length < 1 ||
		input.title.length > 120 ||
		!/\S/.test(input.title)
	)
		invalid('title must contain 1 to 120 characters');
	const enabled = own(input, 'enabled') ? input.enabled : false;
	if (typeof enabled !== 'boolean') invalid('enabled must be a boolean');
	const channels = array(input.channels, 2).map(channel => {
		if (channel !== 'EMAIL' && channel !== 'TELEGRAM')
			invalid('unsupported channel');
		return channel;
	});
	if (new Set(channels).size !== channels.length)
		invalid('duplicate channels');
	if (enabled && channels.length === 0)
		invalid('enabled rules require at least one channel');
	const trigger = record(input.trigger, ['kind', 'offsetMinutes']);
	if (
		trigger.kind !== 'BEFORE_DUE' &&
		trigger.kind !== 'AT_DUE' &&
		trigger.kind !== 'AFTER_DUE'
	)
		invalid('unsupported trigger');
	const offsetMinutes =
		trigger.kind === 'AT_DUE'
			? integer(trigger.offsetMinutes, 0, 0)
			: integer(trigger.offsetMinutes, 1, 43200);
	const repeat =
		input.repeats === null
			? null
			: record(input.repeats, ['intervalMinutes', 'count']);
	const repeats =
		repeat === null
			? null
			: Object.freeze({
					intervalMinutes: integer(repeat.intervalMinutes, 15, 43200),
					count: integer(repeat.count, 2, 1000)
				});
	const quiet =
		input.quietHours === null
			? null
			: record(input.quietHours, ['start', 'end']);
	if (
		typeof input.timeZone !== 'string' ||
		input.timeZone.trim() !== input.timeZone ||
		(quiet !== null &&
			(typeof quiet.start !== 'string' ||
				quiet.start.length !== 5 ||
				typeof quiet.end !== 'string' ||
				quiet.end.length !== 5))
	)
		invalid('explicit time zone and HH:mm quiet hours are required');
	const quietHours =
		quiet === null
			? null
			: Object.freeze({
					start: quiet.start as string,
					end: quiet.end as string
				});
	// Reuse the scheduler's validation, including IANA resolution and unequal
	// HH:mm endpoints. A harmless interval validates the zone when quiet is off.
	nextAllowedReminderInstant(VALIDATION_INSTANT, {
		timeZone: input.timeZone,
		...(quietHours ?? { start: '00:00', end: '00:01' })
	});
	return Object.freeze({
		schemaVersion: 1,
		id: uuid(input.id),
		scope: input.scope,
		ownerBinding: binding(input.ownerBinding),
		title: input.title,
		enabled,
		channels: Object.freeze(channels.sort()),
		trigger: Object.freeze({ kind: trigger.kind, offsetMinutes }),
		repeats,
		timeZone: input.timeZone,
		quietHours,
		recipients: recipients(input.recipients, input.scope)
	});
}

/** Stable rule-only JSON for hashing. A command must additionally bind its
 * workspace, actor, target and expected version; this is not a command hash. */
export function canonicalReminderRuleJson(
	value: unknown,
	options: ReminderRuleParseOptions = {}
): string {
	return JSON.stringify(parseReminderRule(value, options));
}
