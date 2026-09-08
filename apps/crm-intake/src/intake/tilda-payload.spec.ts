import { BadRequestException } from '@nestjs/common';
import { validateSync } from 'class-validator';
import { normalizeTildaPayload } from './tilda-payload';

const sourceId = 'fd312d7c-a16b-43b0-99f7-88b6c7bc1689';
const anotherSourceId = '0fc04953-ccdc-4d20-9861-53e16b58be69';
const lead = { tranid: '467251:8442970', formid: 'form48844953' };

function normalize(body: unknown) {
	const result = normalizeTildaPayload(sourceId, body);
	if (result.kind !== 'lead') throw new Error('Expected a lead');
	return result;
}

function expectInvalid(body: unknown) {
	try {
		normalizeTildaPayload(sourceId, body);
		throw new Error('Expected invalid payload');
	} catch (error) {
		expect(error).toBeInstanceOf(BadRequestException);
		expect((error as BadRequestException).getResponse()).toEqual({
			code: 'crm_intake_tilda_payload_invalid'
		});
	}
}

describe('Tilda payload normalization', () => {
	it('accepts only the exact Tilda connection probe', () => {
		expect(normalizeTildaPayload(sourceId, { test: 'test' })).toEqual({
			kind: 'probe'
		});
		for (const body of [
			{ test: 'test', ...lead },
			{ test: 'test', token: 'not-stored' },
			{ test: ['test'] },
			{ test: ' test ' },
			{ TEST: 'test' },
			{ test: 'other' },
			{ test: true }
		]) {
			expectInvalid(body);
		}
	});
	it('maps fields case-insensitively into the existing validated DTO', () => {
		const { dto } = normalize({
			...lead,
			NAME: ' Анна Иванова ',
			Email: ' ANNA@EXAMPLE.TEST ',
			pHoNe: ' +7 (999) 123-45-67 ',
			COMMENTS: ' Обсудить заказ\nЗавтра утром ',
			formname: 'Связаться с нами',
			Budget: 100,
			Consent: true,
			Services: ['Аудит', 'Внедрение']
		});
		expect(dto).toMatchObject({
			schemaVersion: 1,
			title: 'Заявка с Tilda',
			name: 'Анна Иванова',
			email: 'anna@example.test',
			phone: '+79991234567',
			message:
				'Обсудить заказ\nЗавтра утром\nBudget: 100\nConsent: true\nServices: Аудит, Внедрение\nformid: form48844953\nformname: Связаться с нами\ntranid: 467251:8442970'
		});
		expect(validateSync(dto)).toEqual([]);
	});
	it('does not infer a country or lose malformed contact fields', () => {
		const { dto } = normalize({
			...lead,
			Name: '',
			Phone: '8 (999) 123-45-67',
			Email: 'позвоните мне'
		});
		expect(dto.name).toBe('Заявка с Tilda');
		expect(dto.phone).toBeNull();
		expect(dto.email).toBeNull();
		expect(dto.message).toContain(
			'Phone (как в форме): 8 (999) 123-45-67'
		);
		expect(dto.message).toContain('Email (как в форме): позвоните мне');
	});
	it.each([
		'+7 999 123 45 67 ext 2',
		'+09991234567',
		'+123',
		'79991234567'
	])('preserves non-E164 phone %s in the message', Phone => {
		const { dto } = normalize({ ...lead, Phone });
		expect(dto.phone).toBeNull();
		expect(dto.message).toContain(Phone);
	});
	it('does not decode percent sequences twice', () => {
		expect(
			normalize({ ...lead, Comments: 'Код %2B20, скидка 20%' }).dto.message
		).toContain('Код %2B20, скидка 20%');
	});
	it('omits cookies and credential fields from the canonical payload', () => {
		const minimal = normalize(lead);
		const withPrivate = normalize({
			...lead,
			COOKIES: 'private-cookie',
			Cookie: 'private-cookie',
			Authorization: 'private-authorization',
			api_key: 'private-api-key',
			'X-WinCRM-Source-Token': 'private-token',
			Password: 'private-password',
			client_secret: 'private-secret',
			auth: 'private-auth',
			credentials: { secret: 'private-nested-secret' }
		});
		expect(withPrivate).toEqual(minimal);
		expect(JSON.stringify(withPrivate)).not.toContain('private-');
	});
	it('rejects ambiguous duplicate core fields instead of choosing one', () => {
		for (const body of [
			{ ...lead, Name: 'Анна', name: 'Мария' },
			{ ...lead, Name: ['Анна'] },
			{ ...lead, tranid: ['467251:8442970'] },
			{ ...lead, TRANID: '467251:8442970' }
		]) {
			expectInvalid(body);
		}
	});
	it('rejects malformed or nested non-secret input with a safe error', () => {
		for (const body of [
			null,
			undefined,
			[],
			'private-input',
			{},
			new Date(),
			{ ...lead, Name: { value: 'private-name' } },
			{ ...lead, Custom: { value: 'private-value' } },
			{ ...lead, Custom: ['ok', { value: 'private-value' }] },
			{ ...lead, Custom: [['nested-array']] },
			{ ...lead, Custom: Number.NaN }
		]) {
			expectInvalid(body);
		}
	});
	it('rejects prototype keys and unsafe labels', () => {
		for (const key of [
			'__proto__',
			'constructor',
			'prototype',
			'custom[__proto__]',
			'custom.constructor.value',
			'line\nbreak',
			' ',
			'x'.repeat(201)
		]) {
			expectInvalid({ ...lead, [key]: 'ignored' });
		}
	});
	it('requires a bounded stable Tilda transaction ID', () => {
		for (const tranid of [
			undefined,
			'',
			'a'.repeat(129),
			'part one',
			'a/b'
		]) {
			expectInvalid({ ...lead, tranid });
		}
	});
	it('rejects excess fields, arrays, names or final message without truncation', () => {
		expectInvalid({
			...lead,
			...Object.fromEntries(
				Array.from({ length: 99 }, (_, i) => [`f${i}`, 'x'])
			)
		});
		expectInvalid({ ...lead, custom: Array(101).fill('x') });
		expectInvalid({ ...lead, Name: 'а'.repeat(201) });
		expectInvalid({ ...lead, Comments: 'private'.repeat(1000) });
		const baseMessage = normalize(lead).dto.message || '';
		const comments = 'x'.repeat(5000 - baseMessage.length - 1);
		expect(
			normalize({ ...lead, Comments: comments }).dto.message
		).toHaveLength(5000);
		expectInvalid({ ...lead, Comments: `${comments}x` });
	});
	it('produces a stable per-source receipt key and sorted payload across retries', () => {
		const first = normalize({
			...lead,
			Name: 'Анна',
			Zebra: 'last',
			Alpha: 'first'
		});
		const reordered = normalize({
			Alpha: 'first',
			formid: lead.formid,
			name: 'Анна',
			Zebra: 'last',
			tranid: lead.tranid
		});
		expect(first).toEqual(reordered);
		expect(first.commandId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		);
		expect(normalize({ ...lead, formid: 'another-form' }).commandId).toBe(
			first.commandId
		);
		expect(
			normalize({ ...lead, tranid: 'another:lead' }).commandId
		).not.toBe(first.commandId);
		const anotherSource = normalizeTildaPayload(anotherSourceId, lead);
		expect(
			anotherSource.kind === 'lead' && anotherSource.commandId
		).not.toBe(first.commandId);
		expect(normalizeTildaPayload(sourceId.toUpperCase(), lead)).toEqual(
			normalize(lead)
		);
	});
	it('rejects an invalid source identifier', () => {
		expect(() => normalizeTildaPayload('wrong-source', lead)).toThrow(
			BadRequestException
		);
	});
});
