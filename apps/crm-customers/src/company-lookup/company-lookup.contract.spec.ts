import {
	BadRequestException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	assertCompanyLookupInn,
	isValidCompanyLookupInn
} from './company-lookup.contract';
import { mapDadataCompanyLookupResult as mapCompanyLookupResult } from './dadata-company-lookup.adapter';

const inn = '7707083893';
const individualInn = '784806113663';
const at = new Date('2026-09-07T09:00:00.000Z');
const data = (patch: Record<string, unknown> = {}) => ({
	inn,
	type: 'LEGAL',
	branch_type: 'MAIN',
	kpp: '773601001',
	ogrn: '1027700132195',
	name: {
		full_with_opf: 'ПОЛНОЕ НАИМЕНОВАНИЕ',
		short_with_opf: 'Название'
	},
	state: { status: 'ACTIVE' },
	address: {
		unrestricted_value: 'Юридический адрес',
		value: 'Короткий адрес'
	},
	management: { name: 'PRIVATE_DIRECTOR' },
	phones: ['PRIVATE_PHONE'],
	email: 'PRIVATE_EMAIL',
	hid: 'PRIVATE_PROVIDER_ID',
	...patch
});
const response = (patch: Record<string, unknown> = {}) => ({
	suggestions: [{ value: 'UNUSED_DISPLAY', data: data(patch) }]
});

describe('company lookup checksum and provider mapping', () => {
	it.each([inn, individualInn, '7719402047'])(
		'accepts known checksum-valid INN %s',
		value => {
			expect(isValidCompanyLookupInn(value)).toBe(true);
		}
	);
	it.each([
		'',
		'0000000000',
		'000000000000',
		'7707083894',
		'784806113664',
		'784806113653',
		'770708389',
		'77070838931',
		'7707083893000',
		' 7707083893',
		'7707083893\n',
		'７７０７０８３８９３',
		'770708389x',
		7707083893,
		null,
		undefined
	])('rejects invalid lookup INN without coercion %#', value => {
		expect(isValidCompanyLookupInn(value)).toBe(false);
		expect(() => assertCompanyLookupInn(value)).toThrow(
			BadRequestException
		);
	});
	it('maps only allowlisted fields and deep-freezes the snapshot', () => {
		const input = response();
		const result = mapCompanyLookupResult(input, inn, at);
		expect(result).toEqual({
			schemaVersion: 1,
			provider: 'DADATA',
			queriedAt: at.toISOString(),
			inn,
			items: [
				{
					name: 'Название',
					legalName: 'ПОЛНОЕ НАИМЕНОВАНИЕ',
					inn,
					kpp: '773601001',
					ogrn: '1027700132195',
					legalAddress: 'Юридический адрес',
					entityType: 'LEGAL',
					status: 'ACTIVE'
				}
			]
		});
		expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|UNUSED_DISPLAY/);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.items)).toBe(true);
		expect(Object.isFrozen(result.items[0])).toBe(true);
		input.suggestions[0].data.name.short_with_opf = 'changed';
		expect(result.items[0].name).toBe('Название');
	});
	it('maps an individual entrepreneur without requiring a KPP', () => {
		const result = mapCompanyLookupResult(
			response({
				inn: individualInn,
				type: 'INDIVIDUAL',
				kpp: null,
				ogrn: '304784806300001',
				address: null,
				name: { full_with_opf: 'ИП Тестовый', short_with_opf: null }
			}),
			individualInn,
			at
		);
		expect(result.items[0]).toMatchObject({
			inn: individualInn,
			entityType: 'INDIVIDUAL',
			name: 'ИП Тестовый',
			legalName: 'ИП Тестовый',
			kpp: null,
			legalAddress: null
		});
	});
	it.each(['123456789', '', false, 0, {}])(
		'rejects a non-null individual KPP %#',
		kpp => {
			expect(() =>
				mapCompanyLookupResult(
					response({
						inn: individualInn,
						type: 'INDIVIDUAL',
						kpp,
						ogrn: null,
						address: null
					}),
					individualInn,
					at
				)
			).toThrow(ServiceUnavailableException);
		}
	);
	it.each(
		[undefined, null, 'MAIN'].flatMap(branch_type =>
			[undefined, null].map(kpp => ({ branch_type, kpp }))
		)
	)('normalizes optional individual branch and KPP fields %#', patch => {
		const result = mapCompanyLookupResult(
			response({
				inn: individualInn,
				type: 'INDIVIDUAL',
				ogrn: '304784806300001',
				...patch
			}),
			individualInn,
			at
		);
		expect(result.items[0].kpp).toBeNull();
		expect(result.items[0].entityType).toBe('INDIVIDUAL');
	});
	it.each(['BRANCH', '', 'OTHER', false, 0, {}])(
		'rejects explicit invalid individual branch type %#',
		branch_type => {
			expect(() =>
				mapCompanyLookupResult(
					response({
						inn: individualInn,
						type: 'INDIVIDUAL',
						kpp: null,
						branch_type,
						ogrn: null
					}),
					individualInn,
					at
				)
			).toThrow(ServiceUnavailableException);
		}
	);
	it('maps the observed two-record individual response shape without branch or KPP fields', () => {
		// Shape of the real provider response, with identifying text replaced.
		// Separate registrations for one INN must not be silently merged.
		const registrations = [
			{ ogrn: '304784806300001', status: 'LIQUIDATED' },
			{ ogrn: '304784806300002', status: 'ACTIVE' }
		];
		const input = {
			suggestions: registrations.map(({ ogrn, status }) => ({
				value: 'ИП Тестовый',
				data: {
					inn: individualInn,
					type: 'INDIVIDUAL',
					ogrn,
					name: {
						full_with_opf: 'ИП Тестовый',
						short_with_opf: null
					},
					state: { status },
					address: { value: 'Санкт-Петербург' }
				}
			}))
		};
		const result = mapCompanyLookupResult(input, individualInn, at);
		expect(result.items).toEqual(
			registrations.map(({ ogrn, status }) => ({
				name: 'ИП Тестовый',
				legalName: 'ИП Тестовый',
				inn: individualInn,
				kpp: null,
				ogrn,
				legalAddress: 'Санкт-Петербург',
				entityType: 'INDIVIDUAL',
				status
			}))
		);
		expect(Object.isFrozen(result.items)).toBe(true);
		expect(result.items.every(Object.isFrozen)).toBe(true);
	});
	it('accepts explicit null individual OGRN but rejects a missing OGRN field', () => {
		expect(
			mapCompanyLookupResult(
				response({
					inn: individualInn,
					type: 'INDIVIDUAL',
					kpp: null,
					ogrn: null,
					address: null
				}),
				individualInn,
				at
			).items[0].ogrn
		).toBeNull();
		expect(() =>
			mapCompanyLookupResult(
				response({
					inn: individualInn,
					type: 'INDIVIDUAL',
					kpp: null,
					ogrn: undefined,
					address: null
				}),
				individualInn,
				at
			)
		).toThrow(ServiceUnavailableException);
	});
	it.each([
		'ACTIVE',
		'LIQUIDATING',
		'LIQUIDATED',
		'BANKRUPT',
		'REORGANIZING'
	])('preserves known status %s', status => {
		expect(
			mapCompanyLookupResult(response({ state: { status } }), inn, at)
				.items[0].status
		).toBe(status);
	});
	it('maps a future upstream status to UNKNOWN without passing it through', () => {
		expect(
			mapCompanyLookupResult(
				response({ state: { status: 'FUTURE_STATUS' } }),
				inn,
				at
			).items[0].status
		).toBe('UNKNOWN');
	});
	it('returns not found only for an explicitly valid empty suggestions array', () => {
		expect(
			mapCompanyLookupResult({ suggestions: [] }, inn, at).items
		).toEqual([]);
	});
	it.each([
		null,
		[],
		{},
		{ suggestions: null },
		{ suggestions: {} },
		{ suggestions: [null] },
		{ suggestions: new Array(6).fill({ data: data() }) }
	])('rejects an invalid provider envelope %#', value => {
		expect(() => mapCompanyLookupResult(value, inn, at)).toThrow(
			ServiceUnavailableException
		);
	});
	it.each([
		{ inn: individualInn },
		{ inn: 7707083893 },
		{ type: 'INDIVIDUAL' },
		{ branch_type: 'BRANCH' },
		{ branch_type: undefined },
		{ branch_type: null },
		{ kpp: undefined },
		{ kpp: '12345678' },
		{ kpp: '１２３４５６７８９' },
		{ kpp: '123456789\n' },
		{ ogrn: '304784806300001' },
		{ ogrn: undefined },
		{ ogrn: 'x'.repeat(13) },
		{ state: null },
		{ state: { status: null } },
		{ state: { status: 'A'.repeat(65) } },
		{ name: null },
		{ name: { full_with_opf: '', short_with_opf: 'Name' } },
		{ name: { full_with_opf: 'a'.repeat(2001), short_with_opf: 'Name' } },
		{ name: { full_with_opf: 'Full', short_with_opf: 'a'.repeat(201) } },
		{ name: { full_with_opf: 'a'.repeat(201), short_with_opf: null } },
		{ address: undefined },
		{ address: { unrestricted_value: 'a'.repeat(2001) } }
	])(
		'fails the entire provider result on invalid binding or fields %#',
		patch => {
			expect(() =>
				mapCompanyLookupResult(response(patch), inn, at)
			).toThrow(ServiceUnavailableException);
		}
	);
	it.each(['\n', '\r', '\t', '\x00', '\x1f', '\x7f', '\x85'])(
		'excludes control characters in every projected remote text %#',
		control => {
			for (const patch of [
				{
					name: { full_with_opf: `Full${control}`, short_with_opf: 'Name' }
				},
				{
					name: { full_with_opf: 'Full', short_with_opf: `Name${control}` }
				},
				{ state: { status: `ACTIVE${control}` } },
				{ address: { value: `Address${control}` } }
			])
				expect(() =>
					mapCompanyLookupResult(response(patch), inn, at)
				).toThrow(ServiceUnavailableException);
		}
	);
	it('accepts exact field bounds without silent truncation', () => {
		const result = mapCompanyLookupResult(
			response({
				name: {
					full_with_opf: 'я'.repeat(2000),
					short_with_opf: 'я'.repeat(200)
				},
				address: { value: 'я'.repeat(2000) },
				kpp: null,
				ogrn: null
			}),
			inn,
			at
		);
		expect(result.items[0].name).toHaveLength(200);
		expect(result.items[0].legalName).toHaveLength(2000);
		expect(result.items[0].legalAddress).toHaveLength(2000);
	});
	it('rejects an invalid query timestamp and does not turn malformed entries into not found', () => {
		expect(() =>
			mapCompanyLookupResult(response(), inn, new Date('invalid'))
		).toThrow(ServiceUnavailableException);
		expect(() =>
			mapCompanyLookupResult(
				{
					suggestions: [
						{ data: data() },
						{ data: data({ inn: individualInn }) }
					]
				},
				inn,
				at
			)
		).toThrow(ServiceUnavailableException);
	});
});
