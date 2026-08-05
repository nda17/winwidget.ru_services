import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/widgets-client';
import type { WidgetLeadRecord } from './widgets-domain.repository';
import {
	normalizeWidgetConfig,
	prepareWidgetConfigPatch
} from './widgets-config-normalizer';
import {
	asJsonObject,
	getWidgetDefinition,
	WidgetType
} from './widgets-domain.types';
import { WidgetsTypeRegistryService } from './widgets-type-registry.service';

const registry = new WidgetsTypeRegistryService();
const config = (type: WidgetType) =>
	asJsonObject(
		normalizeWidgetConfig(type, getWidgetDefinition(type).defaultConfig())
	);
const lead = (
	overrides: Partial<WidgetLeadRecord> = {}
): WidgetLeadRecord => ({
	id: 'lead-1',
	createdAt: new Date('2026-08-04T12:00:00.000Z'),
	...overrides
});

describe('WidgetsTypeRegistryService', () => {
	it('registers one adapter for each of the seven canonical widget types', () => {
		expect(
			Object.values(WidgetType).map(type => registry.for(type).type)
		).toEqual(Object.values(WidgetType));
	});

	it.each([
		WidgetType.WHEEL,
		WidgetType.QUIZ,
		WidgetType.CALLBACK,
		WidgetType.TIMER,
		WidgetType.STOP_OFFER,
		WidgetType.ONLINE_CONSULTANT,
		WidgetType.CALCULATOR
	])('builds a canonical active public response for %s', type => {
		const response = registry.for(type).publicConfig(config(type), {
			publishedVersion: 3,
			hardPlan: false,
			duplicateByIp: false
		});
		expect(response).toMatchObject({
			isActive: true,
			publishedVersion: 3,
			hideBranding: false,
			developInfoActive: true
		});
		expect(response).not.toHaveProperty('integrations');
		expect(response).not.toHaveProperty('webhookUrl');
	});

	it('exposes only the legacy duplicate response key for each applicable type', () => {
		expect(
			registry
				.for(WidgetType.WHEEL)
				.publicDuplicateRule(config(WidgetType.WHEEL), '127.0.0.1')
				?.responseKey
		).toBe('hasPlayedByIp');
		expect(
			registry
				.for(WidgetType.QUIZ)
				.publicDuplicateRule(config(WidgetType.QUIZ), '127.0.0.1')
				?.responseKey
		).toBe('hasPlayedByIp');
		const callbackConfig = {
			...config(WidgetType.CALLBACK),
			filterDuplicates: true
		};
		expect(
			registry
				.for(WidgetType.CALLBACK)
				.publicDuplicateRule(callbackConfig, '127.0.0.1')?.responseKey
		).toBe('hasSubmittedByIp');
		expect(
			registry
				.for(WidgetType.CALCULATOR)
				.publicDuplicateRule(config(WidgetType.CALCULATOR), '127.0.0.1')
		).toBeNull();
	});

	it.each([
		[WidgetType.WHEEL, 'spinCooldownDays'],
		[WidgetType.QUIZ, 'quizCooldownDays']
	] as const)(
		'keeps %s submit duplicates scoped to the reset token while public IP checks use cooldown',
		(type, cooldownKey) => {
			const adapter = registry.for(type);
			const widgetConfig = {
				...config(type),
				filterDuplicates: true,
				[cooldownKey]: 7
			};
			const prepared = adapter.prepareLead(
				{
					phone: '+79990000000',
					answers:
						type === WidgetType.QUIZ
							? [{ questionId: 'q1', optionIds: ['q1o1'] }]
							: undefined
				},
				widgetConfig
			);
			expect(
				adapter.duplicateRules(prepared.data, widgetConfig, '127.0.0.1')[0]
					?.lookup
			).not.toHaveProperty('since');
			expect(
				adapter.publicDuplicateRule(widgetConfig, '127.0.0.1')?.lookup
					.since
			).toBeInstanceOf(Date);
		}
	);

	it('scores quiz answers on the server and returns the configured result', () => {
		const adapter = registry.for(WidgetType.QUIZ);
		const value = adapter.prepareLead(
			{
				phone: '+79990000000',
				answers: [
					{ questionId: 'q1', optionIds: ['q1o2'] },
					{ questionId: 'q2', optionIds: ['q2o2'] }
				],
				result: 'client-controlled-result'
			},
			config(WidgetType.QUIZ)
		);
		expect(value.data.result).toBe('Результат B');
		expect(value.response?.result).toMatchObject({ id: 'r2' });
	});

	it.each([WidgetType.WHEEL, WidgetType.QUIZ])(
		'derives the canonical contact for %s instead of trusting a client override',
		type => {
			const prepared = registry.for(type).prepareLead(
				{
					contact: 'attacker-controlled-contact',
					phone: '+79990000000',
					answers:
						type === WidgetType.QUIZ
							? [{ questionId: 'q1', optionIds: ['q1o1'] }]
							: undefined
				},
				config(type)
			);
			expect(prepared.data.contact).toBe('+79990000000');
		}
	);

	it('does not use a client Quiz name as the canonical duplicate contact', () => {
		const prepared = registry.for(WidgetType.QUIZ).prepareLead(
			{
				name: 'Client-controlled name',
				answers: [{ questionId: 'q1', optionIds: ['q1o1'] }]
			},
			{ ...config(WidgetType.QUIZ), dataType: 'NONE' }
		);
		expect(prepared.data.contact).toBe('unknown');
	});

	it('rejects malformed and unknown quiz answers', () => {
		const adapter = registry.for(WidgetType.QUIZ);
		expect(() =>
			adapter.prepareLead(
				{
					phone: '+79990000000',
					answers: [{ questionId: 'missing', optionIds: ['option'] }]
				},
				config(WidgetType.QUIZ)
			)
		).toThrow(BadRequestException);
	});

	it('normalizes E.164 phones and validates callback slot and timezone', () => {
		const adapter = registry.for(WidgetType.CALLBACK);
		const prepared = adapter.prepareLead(
			{
				phone: '8 (999) 000-00-00',
				timeSlot: '9:00–11:00',
				timezone: 'Europe/Moscow'
			},
			config(WidgetType.CALLBACK)
		);
		expect(prepared.data).toMatchObject({
			phone: '+79990000000',
			timeSlot: '9:00–11:00',
			timezone: 'Europe/Moscow'
		});
		expect(() =>
			adapter.prepareLead(
				{
					phone: '+79990000000',
					timeSlot: '03:00',
					timezone: 'Invalid/Timezone'
				},
				config(WidgetType.CALLBACK)
			)
		).toThrow(BadRequestException);
	});

	it('keeps Callback reads forgiving but validates an explicit slots patch', () => {
		const normalized = asJsonObject(
			normalizeWidgetConfig(WidgetType.CALLBACK, {
				timeSlots: [' 9:00–11:00 ', '9:00–11:00', null]
			})
		);
		expect(normalized.timeSlots).toEqual(['9:00–11:00']);
		expect(() =>
			prepareWidgetConfigPatch(WidgetType.CALLBACK, {
				timeSlots: ['9:00–11:00', ' 9:00–11:00 ']
			})
		).toThrow('не должны повторяться');
		expect(() =>
			prepareWidgetConfigPatch(WidgetType.CALLBACK, {
				timeSlots: ['x'.repeat(61)]
			})
		).toThrow('от 1 до 60 символов');
	});

	it('validates online-consultant quick actions against published config', () => {
		const adapter = registry.for(WidgetType.ONLINE_CONSULTANT);
		const onlineConfig = config(WidgetType.ONLINE_CONSULTANT);
		const firstAction = asJsonObject(
			Array.isArray(onlineConfig.quickActions)
				? onlineConfig.quickActions[0]
				: null
		);
		const prepared = adapter.prepareLead(
			{
				phone: '9990000000',
				actionLabel: String(firstAction.label),
				actionValue: String(firstAction.answer)
			},
			onlineConfig
		);
		expect(prepared.data.phone).toBe('+79990000000');
		expect(() =>
			adapter.prepareLead(
				{
					phone: '+79990000000',
					actionLabel: 'Цена',
					actionValue: 'Подменённый ответ'
				},
				onlineConfig
			)
		).toThrow(BadRequestException);
	});

	it('validates and normalizes an explicit online-consultant actions patch', () => {
		const patch = asJsonObject(
			prepareWidgetConfigPatch(WidgetType.ONLINE_CONSULTANT, {
				quickActions: [
					{ id: 'same', label: ' Цена ', answer: ' Ответ ' },
					{ id: 'same', label: 'Срок', answer: 'Завтра' }
				]
			})
		);
		expect(patch.quickActions).toEqual([
			{
				id: 'same',
				label: 'Цена',
				answer: 'Ответ',
				buttonText: '',
				buttonUrl: ''
			},
			{
				id: 'same',
				label: 'Срок',
				answer: 'Завтра',
				buttonText: '',
				buttonUrl: ''
			}
		]);
		expect(() =>
			prepareWidgetConfigPatch(WidgetType.ONLINE_CONSULTANT, {
				quickActions: [
					{ label: '', answer: 'Ответ' },
					{ label: 'Срок', answer: 'Завтра' }
				]
			})
		).toThrow('Заполните вопрос и ответ 1');
	});

	it('calculates calculator price with configured step/options and ignores client price', () => {
		const adapter = registry.for(WidgetType.CALCULATOR);
		const calculatorConfig = {
			...config(WidgetType.CALCULATOR),
			dataType: 'PHONE'
		};
		const prepared = adapter.prepareLead(
			{
				phone: '8 999 000 00 00',
				answers: [
					{ fieldId: 'service', value: 'premium' },
					{ fieldId: 'quantity', value: 2 }
				]
			},
			calculatorConfig
		);
		expect(prepared.data.phone).toBe('+79990000000');
		expect(prepared.data.calculatedPrice?.toFixed(2)).toBe('2200.00');
		expect(prepared.response).toEqual({
			calculatedPrice: '2200.00',
			currency: 'RUB'
		});
		expect(() =>
			adapter.prepareLead(
				{
					phone: '+79990000000',
					answers: [{ fieldId: 'unknown', value: 1 }]
				},
				calculatorConfig
			)
		).toThrow('Передан неизвестный параметр');
	});

	it('normalizes Calculator fields once before public config and calculation', () => {
		const fields = Array.from({ length: 22 }, (_, index) => ({
			id: index < 2 ? 'duplicate' : `field-${index}`,
			label: `Поле ${index}`,
			type: 'number',
			required: false,
			min: 0,
			max: 10,
			step: 1,
			unitPrice: 1
		}));
		const normalized = asJsonObject(
			normalizeWidgetConfig(WidgetType.CALCULATOR, { fields })
		);
		const normalizedFields = Array.isArray(normalized.fields)
			? normalized.fields.map(asJsonObject)
			: [];
		expect(normalizedFields).toHaveLength(20);
		expect(new Set(normalizedFields.map(field => field.id)).size).toBe(20);
		const response = registry
			.for(WidgetType.CALCULATOR)
			.publicConfig(normalized, {
				publishedVersion: 1,
				hardPlan: false,
				duplicateByIp: false
			});
		expect(response.fields).toHaveLength(20);
	});

	it('exposes a button image only for Hard and only from managed widget storage', () => {
		const adapter = registry.for(WidgetType.CALCULATOR);
		const context = {
			publishedVersion: 1,
			hardPlan: true,
			duplicateByIp: false
		};
		expect(
			adapter.publicConfig(
				{
					...config(WidgetType.CALCULATOR),
					buttonImageUrl: 'https://example.test/image.png'
				},
				context
			).buttonImageUrl
		).toBe('');
		expect(
			adapter.publicConfig(
				{
					...config(WidgetType.CALCULATOR),
					buttonImageUrl: '/uploads/widget-buttons/calculator/id/image.png'
				},
				context
			).buttonImageUrl
		).toBe('/uploads/widget-buttons/calculator/id/image.png');
	});

	it.each([
		WidgetType.TIMER,
		WidgetType.STOP_OFFER,
		WidgetType.ONLINE_CONSULTANT,
		WidgetType.CALCULATOR
	])(
		'rejects lead submission before quota accounting when %s uses NONE',
		type => {
			expect(() =>
				registry.for(type).prepareLead(
					{
						answers:
							type === WidgetType.CALCULATOR
								? [
										{ fieldId: 'service', value: 'standard' },
										{ fieldId: 'quantity', value: 1 }
									]
								: undefined
					},
					{ ...config(type), dataType: 'NONE' }
				)
			).toThrow('Сбор контактов отключён');
		}
	);

	it('returns exact wheel, quiz, and calculator analytics shapes', () => {
		expect(
			registry.for(WidgetType.WHEEL).stats(
				{
					kind: 'grouped',
					total: 2,
					groups: [{ value: '10%', count: 2 }]
				},
				config(WidgetType.WHEEL)
			)
		).toEqual({
			stats: [{ bonus: '10%', count: 2, percent: 100 }],
			total: 2
		});
		expect(
			registry.for(WidgetType.QUIZ).stats(
				{
					kind: 'grouped',
					total: 1,
					groups: [{ value: 'r1', count: 1 }]
				},
				config(WidgetType.QUIZ)
			)
		).toEqual({
			stats: [{ result: 'Результат A', count: 1, percent: 100 }],
			total: 1
		});
		expect(
			registry.for(WidgetType.CALCULATOR).stats(
				{
					kind: 'calculator',
					total: 2,
					min: new Prisma.Decimal('10.00'),
					max: new Prisma.Decimal('20.00'),
					average: new Prisma.Decimal('15.00')
				},
				config(WidgetType.CALCULATOR)
			)
		).toEqual({
			total: 2,
			min: '10.00',
			max: '20.00',
			average: '15.00'
		});
	});

	it.each([
		[WidgetType.WHEEL, 'leads', 'Бонус'],
		[WidgetType.QUIZ, 'quiz_leads', 'Результат'],
		[WidgetType.CALLBACK, 'callback_leads', 'Время звонка'],
		[WidgetType.TIMER, 'timer_leads', 'Email'],
		[WidgetType.STOP_OFFER, 'stop_offer_leads', 'Email'],
		[
			WidgetType.ONLINE_CONSULTANT,
			'online_consultant_leads',
			'Быстрый вопрос'
		],
		[WidgetType.CALCULATOR, 'calculator_leads', 'Стоимость']
	] as const)(
		'preserves export contract for %s',
		(type, prefix, header) => {
			const spec = registry.for(type).exportSpec(
				[
					lead({
						calculatedPrice: new Prisma.Decimal('1.00'),
						currency: 'RUB',
						answers: []
					})
				],
				config(type)
			);
			expect(spec.filenamePrefix).toBe(prefix);
			expect(spec.headers).toContain(header);
			expect(spec.rows).toHaveLength(1);
		}
	);

	it('preserves the distinct Callback CSV and XLSX time headers', () => {
		const spec = registry
			.for(WidgetType.CALLBACK)
			.exportSpec([lead()], config(WidgetType.CALLBACK));
		expect(spec.headers[3]).toBe('Время звонка');
		expect(spec.xlsxHeaders?.[3]).toBe('Время');
	});
});
