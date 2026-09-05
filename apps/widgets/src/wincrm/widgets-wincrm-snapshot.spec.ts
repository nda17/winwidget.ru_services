import { Prisma } from '@prisma/widgets-client';
import { WidgetType, WidgetEntity } from '../domain/widgets-domain.types';
import { WidgetLeadRecord } from '../domain/widgets-domain.repository';
import { assertWidgetsOutboxContract } from '../messaging/widgets-outbox-contract';
import {
	assertTransferEvent,
	configureInput,
	parseEligibility,
	WINCRM_TRANSFER_EVENT
} from './widgets-wincrm.contract';
import {
	assertLeadSnapshot,
	captureLeadSnapshot
} from './widgets-wincrm-snapshot';

const id = '11111111-1111-4111-8111-111111111111';
const at = '2026-09-05T12:00:00.000Z';
const widget = {
	id: 'cmwidget1',
	name: 'Заявка',
	publishedVersion: 4
} as WidgetEntity;
const baseLead: WidgetLeadRecord = {
	id: 'cmlead1',
	createdAt: new Date(at),
	phone: '+79990000000',
	email: 'visitor@example.test',
	ip: '192.0.2.1',
	verificationChallengeId: id,
	url: 'https://login:password@example.test/path?token=sensitive#private'
};
const event = () => ({
	schemaVersion: 1,
	eventType: WINCRM_TRANSFER_EVENT,
	eventId: id,
	occurredAt: at,
	transferId: id,
	connectorId: id,
	generation: 1,
	workspaceId: id,
	sourceId: id,
	originalSubscriptionId: 'cmbillingsubscription',
	originalSubscriptionVersion: '0',
	originalPeriodStartsAt: '2026-09-01T00:00:00.000Z',
	originalDeadline: '2026-10-01T00:00:00.000Z'
});

describe('native WinCRM bounded snapshots', () => {
	it.each(['\ufffd', '\ud800', '\udc00', 'a\ud800b'])(
		'rejects malformed Unicode scalar text without aborting the original lead',
		contactName => {
			expect(
				captureLeadSnapshot({
					type: WidgetType.WHEEL,
					widget,
					lead: baseLead,
					config: {},
					contactName
				})
			).toEqual({ state: 'SKIPPED', reason: 'TEXT_UNSUPPORTED' });
		}
	);
	it('preserves valid paired Unicode emoji exactly', () => {
		const result = captureLeadSnapshot({
			type: WidgetType.WHEEL,
			widget,
			lead: baseLead,
			config: {},
			contactName: 'Иван 🧑‍💻 🚀'
		});
		expect(result.state).toBe('READY');
		if (result.state !== 'READY') throw new Error();
		expect(result.payload.lead.contactName).toBe('Иван 🧑‍💻 🚀');
	});
	it.each([
		WidgetType.WHEEL,
		WidgetType.CALLBACK,
		WidgetType.TIMER,
		WidgetType.STOP_OFFER
	] as const)(
		'preserves accepted %s fields, nullable name and strips sensitive URL parts',
		type => {
			const result = captureLeadSnapshot({
				type,
				widget,
				lead: {
					...baseLead,
					bonus: '10%',
					timeSlot: '11:00',
					timezone: 'Europe/Moscow',
					contact: 'unknown'
				},
				contactName: undefined,
				config: { integrations: { secret: 'must-not-copy' } }
			});
			expect(result.state).toBe('READY');
			if (result.state !== 'READY') throw new Error();
			expect(result.payload.lead).toEqual({
				id: 'cmlead1',
				createdAt: at,
				contactName: null,
				contactRaw: 'unknown',
				phoneRaw: '+79990000000',
				phoneE164: '+79990000000',
				email: 'visitor@example.test',
				pageUrl: 'https://example.test/path',
				redactions: [
					'URL_USERINFO_REMOVED',
					'URL_QUERY_REMOVED',
					'URL_FRAGMENT_REMOVED'
				]
			});
			expect(JSON.stringify(result.payload)).not.toMatch(
				/192\.0\.2|password|sensitive|verification|must-not-copy/
			);
			expect(() => assertLeadSnapshot(result.payload)).not.toThrow();
		}
	);
	it('preserves selected quiz labels from the published config without copying unselected metadata', () => {
		const result = captureLeadSnapshot({
			type: WidgetType.QUIZ,
			widget,
			contactName: 'Иван',
			lead: {
				...baseLead,
				result: 'Результат',
				answers: [{ questionId: 'q1', optionIds: ['a', 'b'] }]
			},
			config: {
				questions: [
					{
						id: 'q1',
						text: 'Что нужно?',
						options: [
							{ id: 'a', text: 'Монтаж', secret: 'excluded' },
							{ id: 'b', text: 'Доставка' }
						]
					}
				]
			}
		});
		expect(result.state).toBe('READY');
		if (result.state !== 'READY') throw new Error();
		expect(result.payload.details).toEqual({
			type: 'QUIZ',
			result: 'Результат',
			answers: [
				{
					questionId: 'q1',
					questionText: 'Что нужно?',
					options: [
						{ id: 'a', text: 'Монтаж' },
						{ id: 'b', text: 'Доставка' }
					]
				}
			]
		});
	});
	it('preserves exact Decimal currency and all calculator value types', () => {
		const answers = [
			{
				fieldId: 'n',
				fieldLabel: 'Количество',
				type: 'number',
				value: 2.25,
				valueLabel: '2.25 шт.'
			},
			{
				fieldId: 's',
				fieldLabel: 'Услуга',
				type: 'select',
				value: 'premium',
				valueLabel: 'Премиум'
			},
			{
				fieldId: 'r',
				fieldLabel: 'Пакет',
				type: 'radio',
				value: 'basic',
				valueLabel: 'Базовый'
			},
			{
				fieldId: 'c',
				fieldLabel: 'Опции',
				type: 'checkbox',
				value: ['a', 'b'],
				valueLabel: 'A, B'
			}
		];
		const result = captureLeadSnapshot({
			type: WidgetType.CALCULATOR,
			widget,
			contactName: null,
			lead: {
				...baseLead,
				calculatedPrice: new Prisma.Decimal('999999999999.99'),
				currency: 'RUB',
				answers
			},
			config: {}
		});
		expect(result.state).toBe('READY');
		if (result.state !== 'READY') throw new Error();
		expect(result.payload.details).toEqual({
			type: 'CALCULATOR',
			calculatedPrice: '999999999999.99',
			currency: 'RUB',
			answers
		});
	});
	it.each(['RUB', 'EUR', 'USD'])(
		'preserves valid scalar calculator currency %s',
		currency => {
			const result = captureLeadSnapshot({
				type: WidgetType.CALCULATOR,
				widget,
				contactName: null,
				lead: {
					...baseLead,
					calculatedPrice: new Prisma.Decimal('10.00'),
					currency,
					answers: []
				},
				config: {}
			});
			expect(result.state).toBe('READY');
			if (result.state !== 'READY') throw new Error();
			expect(result.payload.details).toEqual({
				type: 'CALCULATOR',
				calculatedPrice: '10.00',
				currency,
				answers: []
			});
			expect(() => assertLeadSnapshot(result.payload)).not.toThrow();
		}
	);
	it.each([
		{ currency: ['RUB'] },
		{ currency: [['RUB']] },
		{ currency: { code: 'RUB' } }
	])('rejects nonscalar stored calculator currency %j', ({ currency }) => {
		const result = captureLeadSnapshot({
			type: WidgetType.CALCULATOR,
			widget,
			contactName: null,
			lead: {
				...baseLead,
				calculatedPrice: new Prisma.Decimal('10.00'),
				currency: 'RUB',
				answers: []
			},
			config: {}
		});
		expect(result.state).toBe('READY');
		if (result.state !== 'READY') throw new Error();
		expect(() =>
			assertLeadSnapshot({
				...result.payload,
				details: { ...result.payload.details, currency }
			})
		).toThrow();
	});
	it.each(['<b>имя</b>', '\u0000hidden'])(
		'marks unsupported text visibly skipped without throwing or changing accepted raw data',
		contactName => {
			const lead = { ...baseLead };
			const original = JSON.stringify(lead);
			expect(
				captureLeadSnapshot({
					type: WidgetType.WHEEL,
					widget,
					lead,
					config: {},
					contactName
				})
			).toEqual({ state: 'SKIPPED', reason: 'TEXT_UNSUPPORTED' });
			expect(JSON.stringify(lead)).toBe(original);
		}
	);
	it('never silently truncates a legacy oversized answer or name', () => {
		expect(
			captureLeadSnapshot({
				type: WidgetType.WHEEL,
				widget,
				lead: baseLead,
				config: {},
				contactName: 'x'.repeat(201)
			})
		).toEqual({ state: 'SKIPPED', reason: 'PAYLOAD_SHAPE_UNSUPPORTED' });
	});
	it('bounds the entire UTF-8 snapshot independently of per-field lengths', () => {
		const questions = Array.from({ length: 20 }, (_, index) => ({
			id: `q${index}`,
			text: 'Т'.repeat(10000),
			options: [{ id: 'a', text: 'A' }]
		}));
		const answers = questions.map(question => ({
			questionId: question.id,
			optionIds: ['a']
		}));
		expect(
			captureLeadSnapshot({
				type: WidgetType.QUIZ,
				widget,
				lead: { ...baseLead, answers },
				config: { questions },
				contactName: null
			})
		).toEqual({ state: 'SKIPPED', reason: 'PAYLOAD_TOO_LARGE' });
	});
	it('rejects a missing question rather than losing answer data', () => {
		expect(
			captureLeadSnapshot({
				type: WidgetType.QUIZ,
				widget,
				lead: {
					...baseLead,
					answers: [{ questionId: 'missing', optionIds: ['a'] }]
				},
				config: { questions: [] },
				contactName: null
			}).state
		).toBe('SKIPPED');
	});
	it.each([
		'javascript:alert(1)',
		'https://example.test/<html>',
		'https://example.test/\npath'
	])('redacts unsafe page URL without rejecting the lead: %s', url => {
		const result = captureLeadSnapshot({
			type: WidgetType.WHEEL,
			widget,
			lead: { ...baseLead, url },
			config: {},
			contactName: null
		});
		if (result.state !== 'READY') throw new Error();
		expect(result.payload.lead.pageUrl).toBeNull();
		expect(result.payload.lead.redactions).toEqual(['URL_REJECTED']);
	});
	it('revalidates stored DTO exact keys and refuses injected data', () => {
		const result = captureLeadSnapshot({
			type: WidgetType.WHEEL,
			widget,
			lead: baseLead,
			config: {},
			contactName: null
		});
		if (result.state !== 'READY') throw new Error();
		expect(() =>
			assertLeadSnapshot({ ...result.payload, rawConfig: {} })
		).toThrow();
		expect(() =>
			assertLeadSnapshot({
				...result.payload,
				lead: {
					...result.payload.lead,
					pageUrl: 'https://login:password@example.test/'
				}
			})
		).toThrow();
	});
});

describe('native WinCRM exact contracts', () => {
	it('accepts original CUID and version zero, never puts PII into the event', () => {
		expect(() => assertTransferEvent(event(), id)).not.toThrow();
		expect(() =>
			assertTransferEvent({ ...event(), contactName: 'forbidden' }, id)
		).toThrow();
		expect(() =>
			assertTransferEvent(event(), '22222222-2222-4222-8222-222222222222')
		).toThrow();
	});
	it('adds only the dedicated EVENTS route without admitting provider/manual retry aliases', () => {
		const row = {
			messageId: id,
			eventType: WINCRM_TRANSFER_EVENT,
			routingKey: WINCRM_TRANSFER_EVENT,
			exchange: 'EVENTS',
			headers: {},
			payload: event()
		};
		expect(() => assertWidgetsOutboxContract(row as never)).not.toThrow();
		for (const patch of [
			{ routingKey: 'lead.integration.email.v2' },
			{ exchange: 'MANUAL_RETRY' },
			{ exchange: 'RETRY' },
			{ eventType: 'lead.integration.requested.v2' }
		])
			expect(() =>
				assertWidgetsOutboxContract({ ...row, ...patch } as never)
			).toThrow();
	});
	it('requires exact commandId header, bounded fields and one of six supported types', () => {
		const command = {
			schemaVersion: 1,
			commandId: id,
			workspaceId: id,
			sourceId: id,
			ownerSubject: 'owner:subject',
			widgetType: 'QUIZ',
			widgetId: 'cmwidget',
			controlVersion: 1,
			generation: 1,
			enabled: true
		};
		expect(configureInput(command, id)).toEqual(command);
		for (const patch of [
			{ extra: true },
			{ widgetType: 'AI_CONSULTANT' },
			{ controlVersion: 0 },
			{ generation: '1' },
			{ ownerSubject: ' owner' },
			{ enabled: 1 }
		])
			expect(() => configureInput({ ...command, ...patch }, id)).toThrow();
		expect(() => configureInput(command, 'different')).toThrow();
	});
	it('fails closed on stale, future, expired, cross-subject or contradictory Billing snapshots', () => {
		const now = Date.parse(at);
		const value = {
			schemaVersion: 1,
			ownerSubject: 'owner',
			eligible: true,
			reason: 'ELIGIBLE',
			subscriptionId: 'cmtest',
			version: '0',
			plan: 'EASY',
			startsAt: at,
			expiresAt: '2026-10-01T00:00:00.000Z',
			checkedAt: at,
			validUntil: new Date(now + 5000).toISOString()
		};
		expect(parseEligibility(value, 'owner', now)).toEqual(value);
		for (const patch of [
			{ ownerSubject: 'other' },
			{ checkedAt: new Date(now + 1).toISOString() },
			{ validUntil: at },
			{ validUntil: new Date(now + 5001).toISOString() },
			{ plan: 'TRIAL' },
			{ version: '9223372036854775808' },
			{ expiresAt: at },
			{ secret: true }
		])
			expect(() =>
				parseEligibility({ ...value, ...patch }, 'owner', now)
			).toThrow();
		expect(
			parseEligibility(
				{
					...value,
					eligible: false,
					reason: 'INACTIVE',
					startsAt: null,
					expiresAt: null,
					validUntil: at
				},
				'owner',
				now
			).eligible
		).toBe(false);
	});
});
