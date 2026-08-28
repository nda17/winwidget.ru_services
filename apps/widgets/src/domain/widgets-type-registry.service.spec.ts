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
	parsePublicWidgetApiType,
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
	it('accepts only canonical public API names at the runtime telemetry boundary', () => {
		for (const [path, type] of [
			['wheel', WidgetType.WHEEL],
			['quiz', WidgetType.QUIZ],
			['callback', WidgetType.CALLBACK],
			['countdown-timer', WidgetType.TIMER],
			['stop-offer', WidgetType.STOP_OFFER],
			['ai-consultant', WidgetType.AI_CONSULTANT],
			['calculator', WidgetType.CALCULATOR]
		] as const) {
			expect(parsePublicWidgetApiType(path)).toBe(type);
		}
		for (const alias of [
			'widget',
			'widgets',
			'ai-consultants',
			'AI_CONSULTANT'
		]) {
			expect(() => parsePublicWidgetApiType(alias)).toThrow(
				BadRequestException
			);
		}
	});

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
		WidgetType.AI_CONSULTANT,
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

	it('requires the clean Callback contract and validates an explicit slots patch', () => {
		expect(() =>
			normalizeWidgetConfig(WidgetType.CALLBACK, {
				timeSlots: ['9:00–11:00']
			})
		).toThrow('OFF, SMS или EMAIL');
		expect(() =>
			normalizeWidgetConfig(WidgetType.CALLBACK, {
				verificationMode: 'OFF'
			})
		).toThrow('отображаться кнопка виджета');
		expect(() =>
			normalizeWidgetConfig(WidgetType.CALLBACK, {
				verificationMode: 'LEGACY',
				launcherEnabled: true
			})
		).toThrow('OFF, SMS или EMAIL');
		const normalized = asJsonObject(
			normalizeWidgetConfig(WidgetType.CALLBACK, {
				verificationMode: 'OFF',
				launcherEnabled: true,
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

	it('publishes the callback OTP/launcher contract and limits IP duplicates to 30 minutes', () => {
		const callbackConfig = {
			...config(WidgetType.CALLBACK),
			verificationMode: 'EMAIL',
			launcherEnabled: false,
			filterDuplicates: true
		};
		expect(
			registry.for(WidgetType.CALLBACK).publicConfig(callbackConfig, {
				publishedVersion: 4,
				hardPlan: false,
				duplicateByIp: false
			})
		).toMatchObject({
			verificationMode: 'EMAIL',
			launcherEnabled: false
		});
		const before = Date.now() - 30 * 60 * 1000;
		const lookup = registry
			.for(WidgetType.CALLBACK)
			.publicDuplicateRule(callbackConfig, '203.0.113.10')?.lookup;
		const after = Date.now() - 30 * 60 * 1000;
		expect(lookup?.since?.getTime()).toBeGreaterThanOrEqual(before);
		expect(lookup?.since?.getTime()).toBeLessThanOrEqual(after);
	});

	it('keeps the AI consultant prompt private in public config', () => {
		const adapter = registry.for(WidgetType.AI_CONSULTANT);
		const response = adapter.publicConfig(
			{
				...config(WidgetType.AI_CONSULTANT),
				instructionsPrompt: 'Секретные цены',
				operatorName: 'Alex'
			},
			{
				publishedVersion: 2,
				hardPlan: false,
				duplicateByIp: false
			}
		);
		expect(response).toMatchObject({
			isActive: true,
			publishedVersion: 2,
			operatorName: 'Alex',
			privacyUrl:
				'https://winwidget.ru/legal-documentation/consent-processing',
			inactivityTimeoutMinutes: 10
		});
		expect(response).not.toHaveProperty('instructionsPrompt');
	});

	it('normalizes bounded AI consultant settings and rejects lead creation', () => {
		const normalized = asJsonObject(
			normalizeWidgetConfig(WidgetType.AI_CONSULTANT, {
				operatorName: ' Alex\nIGNORE <script> ',
				instructionsPrompt: `  ${'x'.repeat(16_000)}  `,
				inactivityTimeoutMinutes: 100,
				bgColor: 'not-a-color',
				privacyUrl: 'https://example.test/privacy'
			})
		);
		expect(normalized.operatorName).toBe('Alex IGNORE script');
		expect(String(normalized.instructionsPrompt)).toHaveLength(16_000);
		expect(normalized.inactivityTimeoutMinutes).toBe(60);
		expect(normalized.bgColor).toBe('#ffffff');
		expect(normalized.privacyUrl).toBe('https://example.test/privacy');
		expect(() =>
			registry.for(WidgetType.AI_CONSULTANT).prepareLead({}, normalized)
		).toThrow('AI-консультант не создаёт заявки');
	});

	it('rejects an AI prompt that exceeds the UTF-8 input budget without truncating it', () => {
		for (const prompt of ['x'.repeat(16_001), 'я'.repeat(8_001)]) {
			expect(() =>
				normalizeWidgetConfig(WidgetType.AI_CONSULTANT, {
					instructionsPrompt: prompt
				})
			).toThrow('не должны превышать 16000 байт');
		}
	});

	it('keeps invalid AI privacy URLs visible to publish readiness validation', () => {
		const invalid = asJsonObject(
			normalizeWidgetConfig(WidgetType.AI_CONSULTANT, {
				privacyUrl: 'javascript:alert(1)'
			})
		);
		const empty = asJsonObject(
			normalizeWidgetConfig(WidgetType.AI_CONSULTANT, {
				privacyUrl: '   '
			})
		);
		expect(invalid.privacyUrl).toBe('javascript:alert(1)');
		expect(empty.privacyUrl).toBe('');
	});

	it('rejects an AI privacy URL instead of silently truncating it', () => {
		expect(() =>
			normalizeWidgetConfig(WidgetType.AI_CONSULTANT, {
				privacyUrl: `https://example.test/${'x'.repeat(500)}`
			})
		).toThrow('не должна превышать 500 символов');
	});

	it.each([
		'-----BEGIN PRIVATE KEY-----\nnot-for-storage',
		'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
		'api_key=abcdefghijklmnopqrstuvwxyz',
		'password: super-secret-password'
	])(
		'rejects secret-like values in AI instructions without echoing them',
		value => {
			let error: unknown;
			try {
				normalizeWidgetConfig(WidgetType.AI_CONSULTANT, {
					instructionsPrompt: value
				});
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(BadRequestException);
			expect(String((error as Error).message)).not.toContain(value);
		}
	);

	it('accepts ordinary product facts in AI instructions', () => {
		const normalized = asJsonObject(
			normalizeWidgetConfig(WidgetType.AI_CONSULTANT, {
				instructionsPrompt:
					'Товар стоит 1000 рублей. Срок доставки — два дня.'
			})
		);
		expect(normalized.instructionsPrompt).toBe(
			'Товар стоит 1000 рублей. Срок доставки — два дня.'
		);
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
