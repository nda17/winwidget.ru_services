import type { WidgetLeadRecord } from '../domain/widgets-domain.repository';
import type { WidgetEntity } from '../domain/widgets-domain.types';
import {
	assertUnicode,
	identifier,
	integer,
	iso,
	LeadWidgetType,
	plainText,
	record,
	SnapshotError,
	SnapshotSkipReason,
	widgetType
} from './widgets-wincrm.contract';

export const MAX_SNAPSHOT_BYTES = 256 * 1024;
const REDACTIONS = [
	'URL_USERINFO_REMOVED',
	'URL_QUERY_REMOVED',
	'URL_FRAGMENT_REMOVED',
	'URL_REJECTED'
] as const;
type Redaction = (typeof REDACTIONS)[number];
type QuizAnswer = {
	questionId: string;
	questionText: string | null;
	options: Array<{ id: string; text: string | null }>;
};
type CalculatorAnswer = {
	fieldId: string;
	fieldLabel: string;
	type: 'number' | 'select' | 'radio' | 'checkbox';
	value: number | string | string[];
	valueLabel: string;
};
export interface LeadSnapshot {
	schemaVersion: 1;
	widget: {
		type: LeadWidgetType;
		id: string;
		name: string;
		publishedVersion: number;
	};
	lead: {
		id: string;
		createdAt: string;
		contactName: string | null;
		contactRaw: string | null;
		phoneRaw: string | null;
		phoneE164: string | null;
		email: string | null;
		pageUrl: string | null;
		redactions: Redaction[];
	};
	details:
		| { type: 'WHEEL'; bonus: string | null }
		| { type: 'QUIZ'; result: string | null; answers: QuizAnswer[] }
		| {
				type: 'CALLBACK';
				timeSlot: string | null;
				timezone: string | null;
		  }
		| { type: 'TIMER' | 'STOP_OFFER' }
		| {
				type: 'CALCULATOR';
				calculatedPrice: string;
				currency: string;
				answers: CalculatorAnswer[];
		  };
}

function nullableText(value: unknown, max: number): string | null {
	return value === undefined || value === null
		? null
		: plainText(value, max);
}
function list(value: unknown): unknown[] {
	if (!Array.isArray(value) || value.length > 20)
		throw new SnapshotError('PAYLOAD_SHAPE_UNSUPPORTED');
	return value;
}
function unique(values: string[]): void {
	if (new Set(values).size !== values.length)
		throw new SnapshotError('PAYLOAD_SHAPE_UNSUPPORTED');
}
function pageUrl(value: unknown): {
	pageUrl: string | null;
	redactions: Redaction[];
} {
	if (value === null || value === undefined || value === '')
		return { pageUrl: null, redactions: [] };
	try {
		if (
			typeof value !== 'string' ||
			value.length > 500 ||
			/[\u0000-\u0020\u007f<>]/u.test(value)
		)
			throw new Error();
		assertUnicode(value);
		const parsed = new URL(value);
		if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error();
		const redactions: Redaction[] = [];
		if (parsed.username || parsed.password)
			redactions.push('URL_USERINFO_REMOVED');
		if (parsed.search) redactions.push('URL_QUERY_REMOVED');
		if (parsed.hash) redactions.push('URL_FRAGMENT_REMOVED');
		parsed.username = '';
		parsed.password = '';
		parsed.search = '';
		parsed.hash = '';
		if (parsed.href.length > 500) throw new Error();
		return { pageUrl: parsed.href, redactions };
	} catch {
		return { pageUrl: null, redactions: ['URL_REJECTED'] };
	}
}

/** Only accepted lead fields and selected published labels enter this DTO, never config/OTP/IP. */
export function captureLeadSnapshot(input: {
	type: LeadWidgetType;
	widget: WidgetEntity;
	lead: WidgetLeadRecord;
	contactName: unknown;
	config: Record<string, unknown>;
}):
	| { state: 'READY'; payload: LeadSnapshot }
	| { state: 'SKIPPED'; reason: SnapshotSkipReason } {
	try {
		const { type, widget, lead, config } = input;
		const phoneRaw = nullableText(lead.phone, 200);
		const payload: LeadSnapshot = {
			schemaVersion: 1,
			widget: {
				type,
				id: identifier(widget.id),
				name: plainText(widget.name, 200),
				publishedVersion: integer(widget.publishedVersion)
			},
			lead: {
				id: identifier(lead.id),
				createdAt: iso(lead.createdAt.toISOString()),
				contactName: nullableText(input.contactName, 200),
				contactRaw: nullableText(lead.contact, 200),
				phoneRaw,
				phoneE164:
					phoneRaw && /^\+[1-9][0-9]{7,14}$/.test(phoneRaw)
						? phoneRaw
						: null,
				email: nullableText(lead.email, 254),
				...pageUrl(lead.url)
			},
			details: { type: 'TIMER' }
		};
		switch (type) {
			case 'WHEEL':
				payload.details = { type, bonus: nullableText(lead.bonus, 200) };
				break;
			case 'CALLBACK':
				payload.details = {
					type,
					timeSlot: nullableText(lead.timeSlot, 100),
					timezone: nullableText(lead.timezone, 100)
				};
				break;
			case 'TIMER':
			case 'STOP_OFFER':
				payload.details = { type };
				break;
			case 'QUIZ': {
				const questions = list(config.questions).map(item => record(item));
				unique(questions.map(question => identifier(question.id, 64)));
				const answers = list(lead.answers).map(raw => {
					const answer = record(raw, ['questionId', 'optionIds']);
					const questionId = identifier(answer.questionId, 64);
					const question = questions.find(item => item.id === questionId);
					if (!question)
						throw new SnapshotError('PAYLOAD_SHAPE_UNSUPPORTED');
					const options = list(question.options).map(item => record(item));
					unique(options.map(option => identifier(option.id, 1024)));
					const selected = list(answer.optionIds).map(rawId => {
						const id = identifier(rawId, 1024);
						const option = options.find(item => item.id === id);
						if (!option)
							throw new SnapshotError('PAYLOAD_SHAPE_UNSUPPORTED');
						return { id, text: nullableText(option.text, 10000) };
					});
					unique(selected.map(option => option.id));
					return {
						questionId,
						questionText: nullableText(question.text, 10000),
						options: selected
					};
				});
				payload.details = {
					type,
					result: nullableText(lead.result, 10000),
					answers
				};
				break;
			}
			case 'CALCULATOR': {
				if (
					!lead.calculatedPrice ||
					!lead.calculatedPrice.isFinite() ||
					lead.calculatedPrice.isNegative() ||
					lead.calculatedPrice.decimalPlaces() > 2 ||
					lead.calculatedPrice.greaterThan('999999999999.99')
				)
					throw new SnapshotError('PAYLOAD_SHAPE_UNSUPPORTED');
				payload.details = {
					type,
					calculatedPrice: lead.calculatedPrice.toFixed(2),
					currency: plainText(lead.currency, 3),
					answers: list(lead.answers) as CalculatorAnswer[]
				};
				break;
			}
		}
		assertLeadSnapshot(payload);
		return { state: 'READY', payload };
	} catch (error) {
		return {
			state: 'SKIPPED',
			reason:
				error instanceof SnapshotError
					? error.reason
					: 'PAYLOAD_SHAPE_UNSUPPORTED'
		};
	}
}

/** Validate durable JSON again before exposing it to a different service. */
export function assertLeadSnapshot(
	value: unknown
): asserts value is LeadSnapshot {
	if (
		Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_SNAPSHOT_BYTES
	)
		throw new SnapshotError('PAYLOAD_TOO_LARGE');
	const payload = record(value, [
		'schemaVersion',
		'widget',
		'lead',
		'details'
	]);
	if (payload.schemaVersion !== 1)
		throw new Error('Invalid snapshot version');
	const widget = record(payload.widget, [
		'type',
		'id',
		'name',
		'publishedVersion'
	]);
	widgetType(widget.type);
	identifier(widget.id);
	plainText(widget.name, 200);
	integer(widget.publishedVersion);
	const lead = record(payload.lead, [
		'id',
		'createdAt',
		'contactName',
		'contactRaw',
		'phoneRaw',
		'phoneE164',
		'email',
		'pageUrl',
		'redactions'
	]);
	identifier(lead.id);
	iso(lead.createdAt);
	for (const key of ['contactName', 'contactRaw', 'phoneRaw']) {
		if (lead[key] !== null) plainText(lead[key], 200);
	}
	if (lead.email !== null) plainText(lead.email, 254);
	if (
		lead.phoneE164 !== null &&
		(typeof lead.phoneE164 !== 'string' ||
			!/^\+[1-9][0-9]{7,14}$/.test(lead.phoneE164) ||
			lead.phoneE164 !== lead.phoneRaw)
	)
		throw new Error('Invalid phone');
	if (
		!Array.isArray(lead.redactions) ||
		lead.redactions.length > 4 ||
		lead.redactions.some(item => !REDACTIONS.includes(item)) ||
		new Set(lead.redactions).size !== lead.redactions.length
	)
		throw new Error('Invalid redactions');
	if (lead.pageUrl !== null) {
		const parsed = pageUrl(lead.pageUrl);
		if (parsed.pageUrl !== lead.pageUrl || parsed.redactions.length)
			throw new Error('Unsafe page URL');
	}
	const details = record(payload.details);
	if (details.type !== widget.type)
		throw new Error('Invalid details binding');
	switch (details.type) {
		case 'WHEEL':
			record(details, ['type', 'bonus']);
			if (details.bonus !== null) plainText(details.bonus, 200);
			break;
		case 'CALLBACK':
			record(details, ['type', 'timeSlot', 'timezone']);
			for (const key of ['timeSlot', 'timezone'])
				if (details[key] !== null) plainText(details[key], 100);
			break;
		case 'TIMER':
		case 'STOP_OFFER':
			record(details, ['type']);
			break;
		case 'QUIZ': {
			record(details, ['type', 'result', 'answers']);
			if (details.result !== null) plainText(details.result, 10000);
			const ids = list(details.answers).map(raw => {
				const item = record(raw, [
					'questionId',
					'questionText',
					'options'
				]);
				if (item.questionText !== null)
					plainText(item.questionText, 10000);
				unique(
					list(item.options).map(rawOption => {
						const option = record(rawOption, ['id', 'text']);
						if (option.text !== null) plainText(option.text, 10000);
						return identifier(option.id, 1024);
					})
				);
				return identifier(item.questionId, 64);
			});
			unique(ids);
			break;
		}
		case 'CALCULATOR': {
			record(details, ['type', 'calculatedPrice', 'currency', 'answers']);
			if (
				typeof details.calculatedPrice !== 'string' ||
				!/^(0|[1-9][0-9]{0,11})\.[0-9]{2}$/.test(
					details.calculatedPrice
				) ||
				!['RUB', 'EUR', 'USD'].includes(String(details.currency))
			)
				throw new Error('Invalid amount');
			unique(
				list(details.answers).map(raw => {
					const item = record(raw, [
						'fieldId',
						'fieldLabel',
						'type',
						'value',
						'valueLabel'
					]);
					plainText(item.fieldLabel, 100);
					plainText(item.valueLabel, 4096);
					if (item.type === 'number') {
						if (
							typeof item.value !== 'number' ||
							!Number.isFinite(item.value)
						)
							throw new Error('Invalid numeric answer');
					} else if (item.type === 'checkbox')
						unique(list(item.value).map(value => identifier(value, 64)));
					else if (item.type === 'select' || item.type === 'radio')
						identifier(item.value, 64);
					else throw new Error('Invalid field type');
					return identifier(item.fieldId, 64);
				})
			);
			break;
		}
		default:
			throw new Error('Invalid snapshot details');
	}
}
