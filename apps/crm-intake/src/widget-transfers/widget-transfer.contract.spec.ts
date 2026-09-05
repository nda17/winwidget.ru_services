import { randomUUID } from 'node:crypto';
import {
	parseWidgetLeadSnapshot,
	parseWidgetTransferEvent,
	transferHash,
	WINCRM_TRANSFER_EVENT
} from './widget-transfer.contract';
import {
	parseWidgetTransferContext,
	WidgetTransferClient,
	WidgetTransferDependencyError
} from './widget-transfer.client';
import { widgetTransfersEnabled } from './widget-transfer.config';
import { intakeProcessRole } from '../acceptance/acceptance.messaging';
import { parseCrmIntakePort } from '../runtime/crm-intake-runtime.config';

const now = Date.now(),
	date = new Date(now - 1000).toISOString();
const event = {
	schemaVersion: 1 as const,
	eventType: WINCRM_TRANSFER_EVENT as typeof WINCRM_TRANSFER_EVENT,
	eventId: randomUUID(),
	occurredAt: date,
	transferId: randomUUID(),
	connectorId: randomUUID(),
	generation: 1,
	workspaceId: randomUUID(),
	sourceId: randomUUID(),
	originalSubscriptionId: 'subscription',
	originalSubscriptionVersion: '1',
	originalPeriodStartsAt: new Date(now - 10000).toISOString(),
	originalDeadline: new Date(now + 60000).toISOString()
};
const payload = {
	schemaVersion: 1,
	widget: {
		type: 'QUIZ',
		id: 'widget',
		name: 'Quiz',
		publishedVersion: 1
	},
	lead: {
		id: 'lead',
		createdAt: date,
		contactName: null,
		contactRaw: null,
		phoneRaw: null,
		phoneE164: null,
		email: null,
		pageUrl: null,
		redactions: []
	},
	details: { type: 'QUIZ', result: null, answers: [] }
};
const context = {
	schemaVersion: 1,
	transferId: event.transferId,
	eventId: event.eventId,
	connectorId: event.connectorId,
	generation: 1,
	workspaceId: event.workspaceId,
	sourceId: event.sourceId,
	deliver: true,
	reason: 'READY',
	checkedAt: new Date(now).toISOString(),
	validUntil: new Date(now + 4000).toISOString(),
	payload
};
describe('Widgets transfer exact contract', () => {
	test('accepts producer envelope and stable canonical hash without PII', () => {
		expect(parseWidgetTransferEvent(event, event.eventId)).toEqual(event);
		expect(transferHash({ ...event, generation: 1 })).toBe(
			transferHash(Object.fromEntries(Object.entries(event).reverse()))
		);
	});
	test.each([
		{ phone: 'secret' },
		{ generation: 0 },
		{ eventType: 'other' },
		{ eventId: 'wrong' },
		{ originalSubscriptionVersion: '9223372036854775808' },
		{ originalSubscriptionId: 'bad\u0000value' }
	])('rejects malformed envelope %j', change => {
		expect(() =>
			parseWidgetTransferEvent({ ...event, ...change }, event.eventId)
		).toThrow();
	});
	test('allows null fields in persisted SKIPPED period envelope', () => {
		expect(
			parseWidgetTransferEvent({
				...event,
				originalSubscriptionId: null,
				originalSubscriptionVersion: null,
				originalPeriodStartsAt: null,
				originalDeadline: null
			})
		).toBeDefined();
	});
	test.each([
		{ type: 'WHEEL', bonus: null },
		{
			type: 'QUIZ',
			result: 'Result',
			answers: [
				{
					questionId: 'q',
					questionText: null,
					options: [{ id: 'a', text: 'Answer' }]
				}
			]
		},
		{ type: 'CALLBACK', timeSlot: null, timezone: null },
		{ type: 'TIMER' },
		{ type: 'STOP_OFFER' },
		{
			type: 'CALCULATOR',
			calculatedPrice: '10.00',
			currency: 'RUB',
			answers: [
				{
					fieldId: 'n',
					fieldLabel: 'Qty',
					type: 'number',
					value: 2,
					valueLabel: '2'
				}
			]
		}
	])('accepts typed %s snapshot without inventing a name', details => {
		expect(
			parseWidgetLeadSnapshot({
				...payload,
				widget: { ...payload.widget, type: details.type },
				details
			}).lead.contactName
		).toBeNull();
	});
	test.each(['RUB', 'EUR', 'USD'])(
		'preserves valid scalar calculator currency %s',
		currency => {
			const value = {
				...payload,
				widget: { ...payload.widget, type: 'CALCULATOR' },
				details: {
					type: 'CALCULATOR',
					calculatedPrice: '10.00',
					currency,
					answers: []
				}
			};
			expect(parseWidgetLeadSnapshot(value)).toEqual(value);
		}
	);
	test.each([
		{ currency: ['RUB'] },
		{ currency: [['RUB']] },
		{ currency: { code: 'RUB' } }
	])('rejects nonscalar calculator currency %j', ({ currency }) => {
		expect(() =>
			parseWidgetLeadSnapshot({
				...payload,
				widget: { ...payload.widget, type: 'CALCULATOR' },
				details: {
					type: 'CALCULATOR',
					calculatedPrice: '10.00',
					currency,
					answers: []
				}
			})
		).toThrow();
	});
	test.each(['\u0000', '\ud800', '\ufffd', '<script>'])(
		'rejects unsupported text without normalizing it',
		text => {
			expect(() =>
				parseWidgetLeadSnapshot({
					...payload,
					lead: { ...payload.lead, contactName: text }
				})
			).toThrow();
		}
	);
	test.each([
		'https://user:pass@example.test/',
		'https://example.test/?private=1',
		'javascript:alert(1)',
		'https://example.test/#secret'
	])('rejects unsanitized URL %s', pageUrl => {
		expect(() =>
			parseWidgetLeadSnapshot({
				...payload,
				lead: { ...payload.lead, pageUrl }
			})
		).toThrow();
	});
	test('keeps valid non-BMP plain text and requires E164 to equal raw phone', () => {
		expect(
			parseWidgetLeadSnapshot({
				...payload,
				lead: { ...payload.lead, contactName: 'Анна 😊' }
			}).lead.contactName
		).toBe('Анна 😊');
		expect(() =>
			parseWidgetLeadSnapshot({
				...payload,
				lead: { ...payload.lead, phoneE164: '+79000000001' }
			})
		).toThrow();
	});
	test('rejects payload size, duplicate IDs and unknown fields', () => {
		expect(() =>
			parseWidgetLeadSnapshot({ ...payload, secret: 'x' })
		).toThrow();
		expect(() =>
			parseWidgetLeadSnapshot({
				...payload,
				details: { ...payload.details, result: 'x'.repeat(270000) }
			})
		).toThrow();
		expect(() =>
			parseWidgetLeadSnapshot({
				...payload,
				details: {
					...payload.details,
					answers: Array.from({ length: 2 }, () => ({
						questionId: 'same',
						questionText: null,
						options: []
					}))
				}
			})
		).toThrow();
	});
	test('requires exact context binding, fresh proof and original period', () => {
		const source = { widgetType: 'QUIZ', widgetId: 'widget' };
		expect(
			parseWidgetTransferContext(context, event, source, now)
		).toEqual(context);
		for (const change of [
			{ sourceId: randomUUID() },
			{ checkedAt: new Date(now + 1).toISOString() },
			{ validUntil: new Date(now - 1).toISOString() },
			{ validUntil: new Date(now + 5001).toISOString() },
			{ deliver: false },
			{ payload: null }
		])
			expect(() =>
				parseWidgetTransferContext(
					{ ...context, ...change },
					event,
					source,
					now
				)
			).toThrow();
		expect(() =>
			parseWidgetTransferContext(
				context,
				{ ...event, originalDeadline: null },
				source,
				now
			)
		).toThrow();
		expect(() =>
			parseWidgetTransferContext(
				context,
				event,
				{ ...source, widgetId: 'foreign' },
				now
			)
		).toThrow();
	});
	test('negative context never has payload or future authorization', () => {
		const negative = {
			...context,
			deliver: false,
			reason: 'PERIOD_EXPIRED',
			validUntil: context.checkedAt,
			payload: null
		};
		expect(
			parseWidgetTransferContext(
				negative,
				event,
				{ widgetType: 'QUIZ', widgetId: 'widget' },
				now
			).deliver
		).toBe(false);
		expect(() =>
			parseWidgetTransferContext(
				{ ...negative, payload },
				event,
				{ widgetType: 'QUIZ', widgetId: 'widget' },
				now
			)
		).toThrow();
	});
});
describe('scoped context HTTP client', () => {
	const fetch = global.fetch;
	afterEach(() => {
		global.fetch = fetch;
	});
	const client = () =>
		new WidgetTransferClient({
			enabled: true,
			origin: 'https://widgets.example.test',
			token: 'pair-secret',
			timeoutMs: 1000
		} as never);
	test('uses fixed origin/scoped pair and exact request, no saved user JWT', async () => {
		const current = Date.now();
		global.fetch = jest.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					...context,
					checkedAt: new Date(current).toISOString(),
					validUntil: new Date(current + 4000).toISOString()
				}),
				{ headers: { 'content-type': 'application/json' } }
			)
		);
		await client().context(event, {
			widgetType: 'QUIZ',
			widgetId: 'widget'
		});
		expect(global.fetch).toHaveBeenCalledWith(
			expect.stringContaining('/internal/v1/crm-intake/widget-transfers/'),
			expect.objectContaining({
				redirect: 'error',
				cache: 'no-store',
				headers: expect.objectContaining({
					'x-winwidget-service': 'crm-intake'
				})
			})
		);
		expect(
			(global.fetch as jest.Mock).mock.calls[0][1].headers.authorization
		).toBeUndefined();
	});
	test.each([
		new Response('private value', { status: 403 }),
		new Response('x'.repeat(273 * 1024), {
			headers: { 'content-type': 'application/json' }
		}),
		new Response('{"unexpected":"private"}', {
			headers: { 'content-type': 'application/json' }
		})
	])('bounded failures do not expose response bodies', async response => {
		global.fetch = jest.fn().mockResolvedValue(response);
		await expect(
			client().context(event, { widgetType: 'QUIZ', widgetId: 'widget' })
		).rejects.toBeInstanceOf(WidgetTransferDependencyError);
	});
});
describe('transfer runtime opt-in', () => {
	const env = process.env;
	afterEach(() => {
		process.env = env;
	});
	test('default off and no implicit process enable', () => {
		process.env = {};
		expect(widgetTransfersEnabled()).toBe(false);
		process.env.CRM_INTAKE_PROCESS_ROLE = 'widget-transfer-worker';
		expect(() => intakeProcessRole()).toThrow();
	});
	test.each([
		['widget-transfer-worker', 5315],
		['widget-transfer-publisher', 5316]
	] as const)('separate %s canonical port', (role, port) => {
		process.env = {
			CRM_INTAKE_WIDGETS_ENABLED: 'true',
			CRM_INTAKE_WIDGET_TRANSFERS_ENABLED: 'true',
			CRM_INTAKE_PROCESS_ROLE: role
		};
		expect(widgetTransfersEnabled()).toBe(true);
		expect(intakeProcessRole()).toBe(role);
		expect(parseCrmIntakePort(undefined, role)).toBe(port);
		expect(() => parseCrmIntakePort('5310', role)).toThrow();
	});
});
