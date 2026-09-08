import { BadRequestException } from '@nestjs/common';
import { isEmail, validateSync } from 'class-validator';
import { createHash } from 'node:crypto';
import { IngestInboxEntryDto } from './intake.dto';

type TildaPayload =
	| { kind: 'probe' }
	| { kind: 'lead'; commandId: string; dto: IngestInboxEntryDto };

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORE_FIELDS = new Set([
	'name',
	'email',
	'phone',
	'comments',
	'tranid',
	'formid',
	'formname',
	'test'
]);

function invalidPayload(): never {
	throw new BadRequestException({
		code: 'crm_intake_tilda_payload_invalid'
	});
}

function isSensitiveField(key: string): boolean {
	const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '');
	return (
		/(?:cookies?|password|passwd|secret|token|authorization|apikey|credentials?)/.test(
			compact
		) || /^(?:auth(?:key|code|entication)?|key)$/.test(compact)
	);
}

function scalarText(value: unknown): string {
	if (value === null) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'boolean') return String(value);
	if (typeof value === 'number' && Number.isFinite(value))
		return String(value);
	return invalidPayload();
}

function commandIdFor(sourceId: string, tranid: string): string {
	// A stable internal receipt key, not a generated credential. Keep the v4
	// shape required by the existing ingest contract without changing its DTO.
	const bytes = createHash('sha256')
		.update(
			JSON.stringify([
				'wincrm:tilda:lead:v1',
				sourceId.toLowerCase(),
				tranid
			])
		)
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Normalize already-decoded form/JSON data; never decode percent escapes again. */
export function normalizeTildaPayload(
	sourceId: string,
	body: unknown
): TildaPayload {
	if (
		!UUID_V4.test(sourceId) ||
		!body ||
		typeof body !== 'object' ||
		Array.isArray(body) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(body))
	) {
		return invalidPayload();
	}
	const entries = Object.entries(body);
	if (!entries.length || entries.length > 100) return invalidPayload();
	const fields = new Map<string, string>();
	const details: Array<[string, string]> = [];
	for (const [key, value] of entries) {
		if (
			!key.trim() ||
			key.length > 200 ||
			/[\u0000-\u001f\u007f]/.test(key) ||
			/(?:^|[.\[\]])(?:__proto__|prototype|constructor)(?:$|[.\[\]])/i.test(
				key
			)
		) {
			return invalidPayload();
		}
		const normalizedKey = key.trim().toLowerCase();
		if (isSensitiveField(normalizedKey)) continue;
		if (CORE_FIELDS.has(normalizedKey)) {
			if (fields.has(normalizedKey) || Array.isArray(value)) {
				return invalidPayload();
			}
			fields.set(normalizedKey, scalarText(value));
		} else {
			if (Array.isArray(value) && value.length > 100)
				return invalidPayload();
			const text = Array.isArray(value)
				? value.map(scalarText).join(', ')
				: scalarText(value);
			if (text) details.push([key.trim(), text]);
		}
	}
	if (fields.has('test')) {
		if (
			entries.length === 1 &&
			entries[0][0] === 'test' &&
			entries[0][1] === 'test'
		) {
			return { kind: 'probe' };
		}
		return invalidPayload();
	}
	const tranid = fields.get('tranid');
	if (!tranid || !/^[A-Za-z0-9:_-]{1,128}$/.test(tranid)) {
		return invalidPayload();
	}
	const rawPhone = fields.get('phone') || '';
	const compactPhone = /^\+[0-9()\s.-]+$/.test(rawPhone)
		? rawPhone.replace(/[()\s.-]/g, '')
		: '';
	const phone = /^\+[1-9][0-9]{6,14}$/.test(compactPhone)
		? compactPhone
		: null;
	const rawEmail = fields.get('email') || '';
	const email =
		rawEmail.length <= 254 && isEmail(rawEmail)
			? rawEmail.toLowerCase()
			: null;
	if (rawPhone && !phone) details.push(['Phone (как в форме)', rawPhone]);
	if (rawEmail && !email) details.push(['Email (как в форме)', rawEmail]);
	for (const key of ['tranid', 'formid', 'formname']) {
		const value = fields.get(key);
		if (value) details.push([key, value]);
	}
	// Sort by code point, not runtime locale: reordered retries must have the
	// same canonical payload hash in the existing inbound receipt transaction.
	details.sort(([a, av], [b, bv]) =>
		a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0
	);
	const message = [
		fields.get('comments'),
		...details.map(([key, value]) => `${key}: ${value}`)
	]
		.filter(Boolean)
		.join('\n');
	const dto = Object.assign(new IngestInboxEntryDto(), {
		schemaVersion: 1 as const,
		title: 'Заявка с Tilda',
		name: fields.get('name') || 'Заявка с Tilda',
		phone,
		email,
		message
	});
	if (validateSync(dto).length) return invalidPayload();
	return { kind: 'lead', commandId: commandIdFor(sourceId, tranid), dto };
}
