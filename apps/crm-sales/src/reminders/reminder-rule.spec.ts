import { createHash } from 'node:crypto';
import {
	canonicalReminderRuleJson,
	parseReminderRule,
	type ReminderRuleV1
} from './reminder-rule';
import { nextAllowedReminderInstant } from './reminder-time';

const id = 'a7a98426-561a-478e-9efb-a3c4e5fa978b';
const memberId = 'b858dbf8-4d6b-4f90-9019-3744ba07d619';
const owner = () => ({ subject: 'Owner-Exact', membershipId: memberId });
const selected = () => [
	{ subject: 'employee-b', membershipId: memberId },
	{ subject: 'employee-a', membershipId: id }
];
const base = (patch: Record<string, unknown> = {}) => ({
	schemaVersion: 1,
	id,
	scope: 'WORKSPACE',
	ownerBinding: owner(),
	title: 'Напомнить о задаче',
	enabled: false,
	channels: [] as unknown[],
	trigger: { kind: 'AT_DUE', offsetMinutes: 0 },
	repeats: null,
	timeZone: 'Europe/Moscow',
	quietHours: null,
	recipients: { kind: 'ASSIGNEE' },
	...patch
});
const hash = (value: unknown) =>
	createHash('sha256')
		.update(canonicalReminderRuleJson(value))
		.digest('hex');
const without = (key: string) => {
	const input: Record<string, unknown> = base();
	delete input[key];
	return input;
};

describe('strict reminder rule v1', () => {
	it('keeps disabled channels empty and creates no implicit transport', () => {
		expect(parseReminderRule(base())).toEqual(base());
	});
	it('defaults enabled to false only when omitted on create', () => {
		expect(
			parseReminderRule(without('enabled'), { create: true })
		).toEqual(base());
		expect(() => parseReminderRule(without('enabled'))).toThrow(
			RangeError
		);
		expect(() =>
			parseReminderRule(without('enabled'), { create: false })
		).toThrow(RangeError);
		expect(() =>
			parseReminderRule(base({ enabled: undefined }), { create: true })
		).toThrow(RangeError);
		expect(
			parseReminderRule(base({ enabled: true, channels: ['EMAIL'] }), {
				create: true
			}).enabled
		).toBe(true);
	});
	it.each([
		'schemaVersion',
		'id',
		'scope',
		'ownerBinding',
		'title',
		'channels',
		'trigger',
		'repeats',
		'timeZone',
		'quietHours',
		'recipients'
	])('requires explicit %s even when disabled or creating', key => {
		expect(() =>
			parseReminderRule(without(key), { create: true })
		).toThrow(RangeError);
	});
	it.each(
		[
			null,
			undefined,
			[],
			'rule',
			1,
			new Date('invalid'),
			new Map(),
			new Set()
		].map(value => [value])
	)('rejects a non-record input %#', value => {
		expect(() => parseReminderRule(value)).toThrow(RangeError);
	});
	it.each([
		{ schemaVersion: 2 },
		{ schemaVersion: '1' },
		{ scope: 'OWNER' },
		{ enabled: 'false' },
		{ enabled: 0 },
		{ enabled: null },
		{ id: '' },
		{ id: ` ${id}` },
		{ id: `${id}\n` },
		{ id: 'a7a98426-561a-178e-9efb-a3c4e5fa978b' },
		{ id: '00000000-0000-0000-0000-000000000000' },
		{ title: '' },
		{ title: ' \n\t' },
		{ title: 'a'.repeat(121) },
		{ title: 123 },
		{ dueAt: '2026-02-31T00:00:00.000Z' },
		{ anchorMs: NaN },
		{ createdAt: new Date('invalid') },
		{ workspaceId: id },
		{ actorRole: 'OWNER' },
		{ trusted: true }
	])(
		'rejects invalid scalar or caller-supplied proof fields %#',
		patch => {
			expect(() => parseReminderRule(base(patch))).toThrow(RangeError);
		}
	);
	it('preserves exact identifiers, title and timezone rather than trimming or case folding', () => {
		const input = base({
			id: id.toUpperCase(),
			ownerBinding: { ...owner(), membershipId: memberId.toUpperCase() },
			title: '  Название  ',
			timeZone: 'US/Eastern'
		});
		expect(parseReminderRule(input)).toEqual(input);
		expect(
			parseReminderRule(base({ title: 'я'.repeat(120) })).title
		).toHaveLength(120);
	});
	it.each([
		null,
		{},
		{ subject: 'user' },
		{ membershipId: memberId },
		{ subject: '', membershipId: memberId },
		{ subject: 'a b', membershipId: memberId },
		{ subject: 'user\n', membershipId: memberId },
		{ subject: 'a\x00b', membershipId: memberId },
		{ subject: 'a'.repeat(257), membershipId: memberId },
		{ subject: 'user', membershipId: undefined },
		{ subject: 'user', membershipId: 'legacy' },
		{ ...owner(), role: 'OWNER' }
	])('rejects an inexact owner binding %#', ownerBinding => {
		expect(() => parseReminderRule(base({ ownerBinding }))).toThrow(
			RangeError
		);
	});
	it('does not claim role or membership authority from structurally valid bindings', () => {
		expect(
			parseReminderRule(
				base({
					ownerBinding: { subject: 'claimed-owner', membershipId: null }
				})
			).ownerBinding.membershipId
		).toBeNull();
		expect(
			parseReminderRule(
				base({
					ownerBinding: {
						subject: 'a'.repeat(256),
						membershipId: memberId
					}
				})
			).ownerBinding.subject
		).toHaveLength(256);
	});
	it.each([['EMAIL'], ['TELEGRAM'], ['TELEGRAM', 'EMAIL']])(
		'accepts enabled supported channels %#',
		(...channels) => {
			const rule = parseReminderRule(base({ enabled: true, channels }));
			expect(rule.channels).toEqual([...channels].sort());
		}
	);
	it.each(
		[
			[],
			['SMS'],
			['email'],
			['WEB_PUSH'],
			['EMAIL', 'EMAIL'],
			['TELEGRAM', 'TELEGRAM'],
			['EMAIL', 'TELEGRAM', 'EMAIL'],
			[null],
			[false],
			['EMAIL\n'],
			'EMAIL',
			null,
			new Array(1)
		].map(channels => [channels])
	)('rejects unsafe or empty enabled channels %#', channels => {
		expect(() =>
			parseReminderRule(base({ enabled: true, channels }))
		).toThrow(RangeError);
	});
	it.each(['BEFORE_DUE', 'AFTER_DUE'])(
		'validates %s offsets without coercion',
		kind => {
			for (const offsetMinutes of [1, 43200])
				expect(
					parseReminderRule(base({ trigger: { kind, offsetMinutes } }))
						.trigger
				).toEqual({ kind, offsetMinutes });
			for (const offsetMinutes of [
				0,
				-1,
				43201,
				1.5,
				NaN,
				Infinity,
				'15',
				null
			])
				expect(() =>
					parseReminderRule(base({ trigger: { kind, offsetMinutes } }))
				).toThrow(RangeError);
		}
	);
	it.each([
		null,
		{},
		{ kind: 'AT_DUE' },
		{ kind: 'AT_DUE', offsetMinutes: 1 },
		{ kind: 'AT_DUE', offsetMinutes: -0 },
		{ kind: 'AT_DUE', offsetMinutes: '0' },
		{ kind: 'DAILY', offsetMinutes: 0 },
		{ kind: 'AT_DUE', offsetMinutes: 0, delay: 1 }
	])('rejects invalid triggers %#', trigger => {
		expect(() => parseReminderRule(base({ trigger }))).toThrow(RangeError);
	});
	it('accepts finite repeat bounds with count including the first occurrence', () => {
		for (const repeats of [
			{ intervalMinutes: 15, count: 2 },
			{ intervalMinutes: 43200, count: 1000 }
		])
			expect(parseReminderRule(base({ repeats })).repeats).toEqual(
				repeats
			);
	});
	it.each([
		{},
		false,
		{ intervalMinutes: 15 },
		{ count: 2 },
		{ intervalMinutes: 14, count: 2 },
		{ intervalMinutes: 43201, count: 2 },
		{ intervalMinutes: 15.5, count: 2 },
		{ intervalMinutes: '15', count: 2 },
		{ intervalMinutes: 15, count: 1 },
		{ intervalMinutes: 15, count: 1001 },
		{ intervalMinutes: 15, count: NaN },
		{ intervalMinutes: 15, count: Infinity },
		{ intervalMinutes: 15, count: 2.1 },
		{ intervalMinutes: 15, count: 2, forever: true }
	])('rejects unbounded, coerced or malformed repeats %#', repeats => {
		expect(() => parseReminderRule(base({ repeats }))).toThrow(RangeError);
	});
	it.each([
		'UTC',
		'Europe/Moscow',
		'Asia/Kathmandu',
		'America/New_York',
		'Australia/Lord_Howe',
		'Pacific/Apia'
	])(
		'uses the existing scheduling timezone/quiet contract for %s',
		timeZone => {
			const quietHours = { start: '22:00', end: '08:00' };
			expect(parseReminderRule(base({ timeZone })).timeZone).toBe(
				timeZone
			);
			expect(
				parseReminderRule(base({ timeZone, quietHours })).quietHours
			).toEqual(quietHours);
			expect(() =>
				nextAllowedReminderInstant(Date.UTC(2026, 0, 15, 12), {
					timeZone,
					...quietHours
				})
			).not.toThrow();
		}
	);
	it.each([
		'',
		' Europe/Moscow',
		'UTC\n',
		'Europe/Unknown',
		'+03:00',
		'UTC+03:00',
		'a'.repeat(129),
		null,
		3,
		new Date('invalid')
	])(
		'rejects invalid timezone even with disabled quiet hours %#',
		timeZone => {
			expect(() => parseReminderRule(base({ timeZone }))).toThrow(
				RangeError
			);
		}
	);
	it.each([
		{},
		{ start: '22:00' },
		{ start: '22:00', end: '22:00' },
		{ start: '24:00', end: '08:00' },
		{ start: '22:60', end: '08:00' },
		{ start: '9:00', end: '08:00' },
		{ start: '22:00\n', end: '08:00' },
		{ start: '22:00', end: '08:00:00' },
		{ start: 22, end: '08:00' },
		{ start: '22:00', end: null },
		{ start: '22:00', end: '08:00', timeZone: 'UTC' },
		{ start: '22:00', end: '08:00', date: '2026-02-31' }
	])('rejects malformed or ambiguous quiet hours %#', quietHours => {
		expect(() => parseReminderRule(base({ quietHours }))).toThrow(
			RangeError
		);
	});
	it.each(['ASSIGNEE', 'TEAM_LEADS', 'WORKSPACE'])(
		'supports workspace selector %s',
		kind => {
			expect(
				parseReminderRule(base({ recipients: { kind } })).recipients
			).toEqual({ kind });
		}
	);
	it('allows only SELF for a personal rule, never all tasks visible to its owner', () => {
		const personal = base({
			scope: 'PERSONAL',
			recipients: { kind: 'SELF' }
		});
		expect(parseReminderRule(personal).recipients).toEqual({
			kind: 'SELF'
		});
		for (const recipients of [
			{ kind: 'ASSIGNEE' },
			{ kind: 'TEAM_LEADS' },
			{ kind: 'WORKSPACE' },
			{ kind: 'SELECTED', bindings: [owner()] },
			{ kind: 'SELF', bindings: [owner()] }
		])
			expect(() => parseReminderRule({ ...personal, recipients })).toThrow(
				RangeError
			);
	});
	it.each([
		null,
		{},
		{ kind: 'SELF' },
		{ kind: 'ALL' },
		{ kind: 'ASSIGNEE', bindings: [] },
		{ kind: 'SELECTED' },
		{ kind: 'SELECTED', bindings: [] },
		{ kind: 'SELECTED', bindings: [owner(), owner()] },
		{
			kind: 'SELECTED',
			bindings: [
				owner(),
				{ ...owner(), membershipId: memberId.toUpperCase() }
			]
		},
		{
			kind: 'SELECTED',
			bindings: [{ ...owner(), email: 'untrusted@example.test' }]
		},
		{ kind: 'TEAM_LEADS', teamIds: [id] }
	])(
		'rejects unknown, empty, duplicate or overbroad recipients %#',
		recipients => {
			expect(() => parseReminderRule(base({ recipients }))).toThrow(
				RangeError
			);
		}
	);
	it('bounds selected exact bindings at 100, with no subject or membership rebinding', () => {
		const bindings = Array.from({ length: 100 }, (_, index) => ({
			subject: `employee-${index}`,
			membershipId: memberId
		}));
		expect(
			parseReminderRule(
				base({ recipients: { kind: 'SELECTED', bindings } })
			).recipients
		).toMatchObject({ bindings: expect.any(Array) });
		expect(() =>
			parseReminderRule(
				base({
					recipients: {
						kind: 'SELECTED',
						bindings: [
							...bindings,
							{ subject: 'extra', membershipId: memberId }
						]
					}
				})
			)
		).toThrow(RangeError);
		// Distinct exact pairs remain distinct. The service must reject a stale
		// membership; the parser must not replace either one with "current".
		const pairs = [
			{ ...owner(), membershipId: null },
			owner(),
			{ ...owner(), membershipId: id }
		];
		const rule = parseReminderRule(
			base({ recipients: { kind: 'SELECTED', bindings: pairs } })
		);
		expect(rule.recipients).toMatchObject({
			bindings: expect.arrayContaining(pairs)
		});
	});
	it('rejects inherited, non-enumerable, symbolic and accessor fields without evaluating them', () => {
		const getter = jest.fn(() => true);
		const accessor = Object.defineProperty(base(), 'enabled', {
			enumerable: true,
			get: getter
		});
		const hidden = Object.defineProperty(base(), 'hidden', {
			value: 'proof'
		});
		const symbol = { ...base(), [Symbol('trusted')]: true };
		const inherited = Object.assign(
			Object.create({ trusted: true }),
			base()
		);
		for (const input of [accessor, hidden, symbol, inherited])
			expect(() => parseReminderRule(input)).toThrow(RangeError);
		expect(getter).not.toHaveBeenCalled();
		const channels = Object.assign(['EMAIL'], { trusted: true });
		expect(() => parseReminderRule(base({ channels }))).toThrow(
			RangeError
		);
		const arrayGetter = Object.defineProperty(['EMAIL'], 0, {
			get: getter
		});
		expect(() =>
			parseReminderRule(base({ channels: arrayGetter }))
		).toThrow(RangeError);
		expect(getter).not.toHaveBeenCalled();
		const inheritedArray = Object.setPrototypeOf(['EMAIL'], {
			map: getter
		});
		expect(() =>
			parseReminderRule(base({ channels: inheritedArray }))
		).toThrow(RangeError);
		expect(getter).not.toHaveBeenCalled();
	});
	it('returns detached, deeply immutable objects and arrays without mutating input', () => {
		const recipients = { kind: 'SELECTED', bindings: selected() };
		const input = base({
			channels: ['TELEGRAM', 'EMAIL'],
			repeats: { intervalMinutes: 15, count: 2 },
			quietHours: { start: '22:00', end: '08:00' },
			recipients
		});
		const before = JSON.stringify(input);
		const rule = parseReminderRule(input);
		expect(JSON.stringify(input)).toBe(before);
		const frozen = (value: unknown) => {
			if (value !== null && typeof value === 'object') {
				expect(Object.isFrozen(value)).toBe(true);
				Object.values(value).forEach(frozen);
			}
		};
		frozen(rule);
		const stable = canonicalReminderRuleJson(rule);
		input.ownerBinding.subject = 'changed';
		input.channels.push('SMS');
		recipients.bindings[0].subject = 'changed';
		expect(canonicalReminderRuleJson(rule)).toBe(stable);
		expect(() => ((rule as { title: string }).title = 'changed')).toThrow(
			TypeError
		);
	});
	it('canonicalizes property, channel and selected-binding order for a stable hash only', () => {
		const first = base({
			channels: ['TELEGRAM', 'EMAIL'],
			recipients: { kind: 'SELECTED', bindings: selected() }
		});
		const second = Object.fromEntries(
			Object.entries({
				...first,
				channels: ['EMAIL', 'TELEGRAM'],
				ownerBinding: { membershipId: memberId, subject: owner().subject },
				trigger: { offsetMinutes: 0, kind: 'AT_DUE' },
				recipients: {
					bindings: selected()
						.reverse()
						.map(({ subject, membershipId }) => ({
							membershipId,
							subject
						})),
					kind: 'SELECTED'
				}
			}).reverse()
		);
		expect(canonicalReminderRuleJson(first)).toBe(
			canonicalReminderRuleJson(second)
		);
		expect(hash(first)).toBe(hash(second));
		expect(
			canonicalReminderRuleJson(without('enabled'), { create: true })
		).toBe(canonicalReminderRuleJson(base()));
	});
	it('keeps distinct identities and policies distinct in canonical JSON', () => {
		const original = base();
		for (const patch of [
			{ id: memberId },
			{ title: `${original.title} ` },
			{ ownerBinding: { ...owner(), subject: 'owner-exact' } },
			{ ownerBinding: { ...owner(), membershipId: id } },
			{ channels: ['EMAIL'] },
			{ timeZone: 'UTC' },
			{ trigger: { kind: 'AFTER_DUE', offsetMinutes: 15 } },
			{ repeats: { intervalMinutes: 15, count: 2 } }
		])
			expect(hash(base(patch))).not.toBe(hash(original));
	});
	it('does not trust a cast or echo sensitive invalid input into errors', () => {
		expect(() =>
			canonicalReminderRuleJson(
				base({ channels: ['not-a-channel'] }) as unknown as ReminderRuleV1
			)
		).toThrow(RangeError);
		try {
			parseReminderRule(
				base({
					ownerBinding: {
						subject: 'private@example.test\n',
						membershipId: id
					}
				})
			);
			throw new Error('expected failure');
		} catch (error) {
			expect(error).toBeInstanceOf(RangeError);
			expect(String(error)).not.toContain('private@example.test');
		}
	});
});
