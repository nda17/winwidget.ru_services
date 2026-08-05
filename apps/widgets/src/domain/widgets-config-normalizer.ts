import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/widgets-client';
import {
	asJsonObject,
	getWidgetDefinition,
	toInputJson,
	WidgetType
} from './widgets-domain.types';

const MAX_CALCULATOR_FIELDS = 20;
const MAX_CALCULATOR_OPTIONS = 20;
const MAX_CALCULATOR_PRICE = 1_000_000_000;
const CALLBACK_TIME_SLOTS_MAX = 12;
const CALLBACK_TIME_SLOT_MAX_LENGTH = 60;

const numberValue = (value: unknown, fallback: number): number => {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : fallback;
};

const clamp = (
	value: unknown,
	min: number,
	max: number,
	fallback: number
): number => Math.min(max, Math.max(min, numberValue(value, fallback)));

const optionalDelay = (value: unknown): number | null => {
	if (value === null || value === '' || value === undefined) return null;
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return null;
	return Math.min(86_400, numeric);
};

const booleanValue = (value: unknown, fallback: boolean): boolean =>
	typeof value === 'boolean' ? value : fallback;

const stringValue = (value: unknown, fallback = ''): string =>
	typeof value === 'string' ? value : fallback;

const shortString = (
	value: unknown,
	fallback: string,
	max = 200
): string => (typeof value === 'string' ? value.slice(0, max) : fallback);

const baseConfig = (type: WidgetType, raw: unknown) => {
	const defaults = asJsonObject(getWidgetDefinition(type).defaultConfig());
	const value = asJsonObject(raw);
	return {
		defaults,
		value,
		result: {
			...defaults,
			...value,
			integrations: {
				...asJsonObject(defaults.integrations),
				...asJsonObject(value.integrations)
			}
		} as Record<string, unknown>
	};
};

const normalizeButtonLayout = (
	result: Record<string, unknown>,
	defaults: Record<string, unknown>
): void => {
	result.buttonBottom = clamp(
		result.buttonBottom,
		1,
		50,
		numberValue(defaults.buttonBottom, 3)
	);
	result.buttonOffset = clamp(
		result.buttonOffset,
		1,
		50,
		numberValue(defaults.buttonOffset, 3)
	);
	result.buttonSize = clamp(
		result.buttonSize,
		40,
		100,
		numberValue(defaults.buttonSize, 60)
	);
	result.autoOpenDelay = optionalDelay(result.autoOpenDelay);
};

const normalizeWheel = (raw: unknown): Prisma.InputJsonObject => {
	const { defaults, value, result } = baseConfig(WidgetType.WHEEL, raw);
	normalizeButtonLayout(result, defaults);
	result.glassEffect = booleanValue(
		value.glassEffect,
		booleanValue(defaults.glassEffect, false)
	);
	result.wheelBorderColor = stringValue(
		value.wheelBorderColor,
		stringValue(defaults.wheelBorderColor)
	);
	result.spinDuration = clamp(value.spinDuration, 4, 10, 5);
	result.spinCooldownDays = clamp(value.spinCooldownDays, 0, 365, 0);
	const source = Array.isArray(value.bonuses)
		? value.bonuses
		: (defaults.bonuses as unknown[]);
	result.bonuses = source.map((bonus, index) => {
		const item = asJsonObject(bonus);
		const defaultBonus = Array.isArray(defaults.bonuses)
			? asJsonObject(defaults.bonuses[index])
			: {};
		return {
			...item,
			name: stringValue(item.name, `Бонус #${index + 1}`),
			wheelLabel: stringValue(item.wheelLabel),
			active: booleanValue(item.active, defaultBonus.active !== false),
			probability: clamp(item.probability, 1, 100, 1)
		};
	});
	return toInputJson(result);
};

const hexColor = (
	value: unknown,
	fallback: string,
	allowEmpty = false
): string => {
	const color = stringValue(value).trim();
	if (allowEmpty && !color) return '';
	return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
};

const normalizeQuiz = (raw: unknown): Prisma.InputJsonObject => {
	const { defaults, value, result } = baseConfig(WidgetType.QUIZ, raw);
	normalizeButtonLayout(result, defaults);
	result.color = hexColor(
		value.color,
		stringValue(defaults.color, '#4705fb')
	);
	result.bgColor = hexColor(value.bgColor, '', true);
	result.buttonColor = hexColor(value.buttonColor, '', true);
	result.openButtonColor = hexColor(value.openButtonColor, '', true);
	result.quizCooldownDays = clamp(value.quizCooldownDays, 0, 365, 0);
	const questions = Array.isArray(value.questions)
		? value.questions
		: (defaults.questions as unknown[]);
	result.questions = questions.map(question => {
		const item = asJsonObject(question);
		if (!Array.isArray(item.options)) return item;
		return {
			...item,
			options: item.options.map(option => {
				const normalized = asJsonObject(option);
				return {
					...normalized,
					scores: Object.fromEntries(
						Object.entries(asJsonObject(normalized.scores)).map(
							([resultId, score]) => [resultId, clamp(score, 0, 10, 0)]
						)
					)
				};
			})
		};
	});
	result.results = Array.isArray(value.results)
		? value.results
		: defaults.results;
	return toInputJson(result);
};

const normalizeCallback = (raw: unknown): Prisma.InputJsonObject => {
	const { defaults, result } = baseConfig(WidgetType.CALLBACK, raw);
	normalizeButtonLayout(result, defaults);
	result.timeSlots = Array.isArray(result.timeSlots)
		? [
				...new Set(
					result.timeSlots
						.filter((slot): slot is string => typeof slot === 'string')
						.map(slot => slot.trim())
						.filter(Boolean)
				)
			].slice(0, CALLBACK_TIME_SLOTS_MAX)
		: defaults.timeSlots;
	return toInputJson(result);
};

const normalizeTimer = (raw: unknown): Prisma.InputJsonObject => {
	const { defaults, value, result } = baseConfig(WidgetType.TIMER, raw);
	normalizeButtonLayout(result, defaults);
	result.evergreenDurationMinutes = clamp(
		value.evergreenDurationMinutes,
		1,
		10_080,
		numberValue(defaults.evergreenDurationMinutes, 15)
	);
	result.submissionCooldownDays = clamp(
		value.submissionCooldownDays,
		0,
		365,
		0
	);
	return toInputJson(result);
};

const CONTACT_DATA_TYPES = new Set([
	'PHONE',
	'EMAIL',
	'PHONE_AND_EMAIL',
	'NONE'
]);

const normalizeStopOffer = (raw: unknown): Prisma.InputJsonObject => {
	const { defaults, value } = baseConfig(WidgetType.STOP_OFFER, raw);
	const integrations = asJsonObject(value.integrations);
	const dataType = stringValue(
		value.dataType,
		stringValue(defaults.dataType)
	).toUpperCase();
	const result = {
		color: stringValue(value.color, stringValue(defaults.color)),
		bgColor: stringValue(value.bgColor, stringValue(defaults.bgColor)),
		buttonColor: stringValue(
			value.buttonColor,
			stringValue(defaults.buttonColor)
		),
		autoOpenDelay: optionalDelay(value.autoOpenDelay),
		desktopExitIntent: booleanValue(value.desktopExitIntent, true),
		mobileAutoOpenDelay: clamp(value.mobileAutoOpenDelay, 1, 86_400, 8),
		scrollPercent: clamp(value.scrollPercent, 1, 100, 70),
		showOnce: booleanValue(value.showOnce, true),
		displayCooldownDays: clamp(value.displayCooldownDays, 0, 365, 7),
		displayResetToken: stringValue(value.displayResetToken),
		hideIfSubmitted: booleanValue(value.hideIfSubmitted, true),
		badgeText: stringValue(
			value.badgeText,
			stringValue(defaults.badgeText)
		),
		title: stringValue(value.title, stringValue(defaults.title)),
		subtitle: stringValue(value.subtitle, stringValue(defaults.subtitle)),
		offerText: stringValue(
			value.offerText,
			stringValue(defaults.offerText)
		),
		dataType: CONTACT_DATA_TYPES.has(dataType)
			? dataType
			: stringValue(defaults.dataType, 'PHONE'),
		contactTitle: stringValue(
			value.contactTitle,
			stringValue(defaults.contactTitle)
		),
		submitButtonText: stringValue(
			value.submitButtonText,
			stringValue(defaults.submitButtonText)
		),
		successTitle: stringValue(
			value.successTitle,
			stringValue(defaults.successTitle)
		),
		successSubtitle: stringValue(
			value.successSubtitle,
			stringValue(defaults.successSubtitle)
		),
		actionButtonEnabled: booleanValue(value.actionButtonEnabled, false),
		actionButtonText: stringValue(
			value.actionButtonText,
			stringValue(defaults.actionButtonText)
		),
		actionButtonUrl: stringValue(
			value.actionButtonUrl,
			stringValue(defaults.actionButtonUrl)
		),
		privacyUrl: stringValue(
			value.privacyUrl,
			stringValue(defaults.privacyUrl)
		),
		developInfoActive: booleanValue(value.developInfoActive, true),
		filterDuplicates: booleanValue(value.filterDuplicates, true),
		submissionCooldownDays: clamp(value.submissionCooldownDays, 0, 365, 0),
		submissionResetToken: stringValue(value.submissionResetToken),
		integrations: {
			email: stringValue(integrations.email),
			webhookUrl: stringValue(integrations.webhookUrl),
			telegramChatId: stringValue(integrations.telegramChatId),
			yandexMetrikaId: stringValue(integrations.yandexMetrikaId),
			vkPixelId: stringValue(integrations.vkPixelId),
			bitrix24WebhookUrl: stringValue(integrations.bitrix24WebhookUrl),
			roistatEnabled: booleanValue(integrations.roistatEnabled, false),
			amoCrmDomain: stringValue(integrations.amoCrmDomain),
			amoCrmToken: stringValue(integrations.amoCrmToken)
		}
	};
	return toInputJson(result);
};

const normalizeQuickActions = (value: unknown): Prisma.InputJsonArray => {
	if (!Array.isArray(value)) {
		throw new BadRequestException('Добавьте от 2 до 10 вопросов');
	}
	if (value.length < 2 || value.length > 10) {
		throw new BadRequestException('Должно быть от 2 до 10 вопросов');
	}
	return value.map((action, index) => {
		const item = asJsonObject(action);
		const label = stringValue(item.label).trim().slice(0, 40);
		const answer = stringValue(item.answer).trim().slice(0, 1_200);
		if (!label || !answer) {
			throw new BadRequestException(
				`Заполните вопрос и ответ ${index + 1}`
			);
		}
		const buttonText = stringValue(item.buttonText).trim().slice(0, 80);
		const buttonUrl = stringValue(item.buttonUrl).trim().slice(0, 500);
		if (buttonUrl && !buttonText) {
			throw new BadRequestException(
				`Вопрос ${index + 1}: заполните текст кнопки перехода или уберите ссылку`
			);
		}
		const id =
			stringValue(item.id).trim().slice(0, 60) || `action-${index + 1}`;
		return { id, label, answer, buttonText, buttonUrl };
	});
};

const normalizeOnlineConsultant = (
	raw: unknown
): Prisma.InputJsonObject => {
	const { defaults, value, result } = baseConfig(
		WidgetType.ONLINE_CONSULTANT,
		raw
	);
	normalizeButtonLayout(result, defaults);
	const normalizedType = stringValue(value.dataType).toUpperCase();
	result.dataType = CONTACT_DATA_TYPES.has(normalizedType)
		? normalizedType
		: 'PHONE';
	result.quickActions = Array.isArray(value.quickActions)
		? value.quickActions
		: defaults.quickActions;
	return toInputJson(result);
};

export const prepareWidgetConfigPatch = (
	type: WidgetType,
	raw: unknown
): Prisma.InputJsonObject => {
	const patch = { ...asJsonObject(raw) };
	if (type === WidgetType.CALLBACK && Object.hasOwn(patch, 'timeSlots')) {
		if (!Array.isArray(patch.timeSlots)) {
			throw new BadRequestException('Слоты времени должны быть массивом');
		}
		if (
			patch.timeSlots.length < 1 ||
			patch.timeSlots.length > CALLBACK_TIME_SLOTS_MAX
		) {
			throw new BadRequestException(
				`Укажите от 1 до ${CALLBACK_TIME_SLOTS_MAX} слотов времени`
			);
		}
		const slots = patch.timeSlots.map(slot =>
			typeof slot === 'string' ? slot.trim() : ''
		);
		if (
			slots.some(
				slot => !slot || slot.length > CALLBACK_TIME_SLOT_MAX_LENGTH
			)
		) {
			throw new BadRequestException(
				`Каждый слот должен содержать от 1 до ${CALLBACK_TIME_SLOT_MAX_LENGTH} символов`
			);
		}
		if (new Set(slots).size !== slots.length) {
			throw new BadRequestException('Слоты времени не должны повторяться');
		}
		patch.timeSlots = slots;
	}
	if (
		type === WidgetType.ONLINE_CONSULTANT &&
		Object.hasOwn(patch, 'quickActions')
	) {
		patch.quickActions = normalizeQuickActions(patch.quickActions);
	}
	return toInputJson(patch);
};

type CalculatorFieldType = 'select' | 'number' | 'radio' | 'checkbox';

const identifier = (value: unknown, fallback: string): string => {
	const normalized = stringValue(value).trim();
	return /^[a-zA-Z0-9_-]{1,64}$/.test(normalized) ? normalized : fallback;
};

const uniqueIdentifier = (
	value: unknown,
	fallback: string,
	used: Set<string>
): string => {
	let id = identifier(value, fallback);
	let suffix = 2;
	while (used.has(id)) id = `${fallback}-${suffix++}`;
	used.add(id);
	return id;
};

const normalizeCalculatorOptions = (
	value: unknown,
	fieldIndex: number
) => {
	const source = Array.isArray(value)
		? value.slice(0, MAX_CALCULATOR_OPTIONS)
		: [];
	const used = new Set<string>();
	return source.map((option, optionIndex) => {
		const item = asJsonObject(option);
		const fallback = `field-${fieldIndex + 1}-option-${optionIndex + 1}`;
		return {
			id: uniqueIdentifier(item.id, fallback, used),
			label: shortString(item.label, `Вариант ${optionIndex + 1}`, 100),
			add: clamp(item.add, -MAX_CALCULATOR_PRICE, MAX_CALCULATOR_PRICE, 0),
			multiplier: clamp(item.multiplier, 0.01, 100, 1)
		};
	});
};

const isBooleanOptionPair = (
	options: Array<{ label: string }>
): boolean => {
	if (options.length !== 2) return false;
	const labels = new Set(
		options.map(option => option.label.trim().toLocaleLowerCase('ru-RU'))
	);
	return (
		(labels.has('да') && labels.has('нет')) ||
		(labels.has('yes') && labels.has('no'))
	);
};

const normalizeCalculatorFields = (
	value: unknown,
	fallback: unknown
): Prisma.InputJsonArray => {
	const source = Array.isArray(value)
		? value.slice(0, MAX_CALCULATOR_FIELDS)
		: (fallback as unknown[]);
	const used = new Set<string>();
	return source.map((field, index) => {
		const item = asJsonObject(field);
		const fallbackId = `field-${index + 1}`;
		const id = uniqueIdentifier(item.id, fallbackId, used);
		const type: CalculatorFieldType = [
			'select',
			'number',
			'radio',
			'checkbox'
		].includes(stringValue(item.type))
			? (item.type as CalculatorFieldType)
			: 'select';
		const base = {
			id,
			label: shortString(item.label, `Параметр ${index + 1}`, 100),
			type,
			required: item.required === true
		};
		if (type !== 'number') {
			const options = normalizeCalculatorOptions(item.options, index);
			return {
				...base,
				type:
					type === 'checkbox' && isBooleanOptionPair(options)
						? 'radio'
						: type,
				options
			};
		}
		const min = clamp(item.min, 0, MAX_CALCULATOR_PRICE, 0);
		const max = clamp(
			item.max,
			min,
			MAX_CALCULATOR_PRICE,
			Math.max(min, 100)
		);
		return {
			...base,
			min,
			max,
			step: clamp(item.step, 0.01, MAX_CALCULATOR_PRICE, 1),
			defaultValue: clamp(item.defaultValue, min, max, min),
			unit: shortString(item.unit, '', 30),
			unitPrice: clamp(
				item.unitPrice,
				-MAX_CALCULATOR_PRICE,
				MAX_CALCULATOR_PRICE,
				0
			)
		};
	});
};

const calculatorColor = (value: unknown, fallback: string): string => {
	const normalized = shortString(value, fallback, 32).trim();
	return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(normalized)
		? normalized
		: fallback;
};

const httpUrl = (value: unknown, fallback: string): string => {
	if (value === undefined || value === null) return fallback;
	const normalized = shortString(value, fallback, 500).trim();
	if (!normalized) return '';
	try {
		const parsed = new URL(normalized);
		return ['http:', 'https:'].includes(parsed.protocol)
			? parsed.toString()
			: fallback;
	} catch {
		return fallback;
	}
};

const normalizeCalculator = (raw: unknown): Prisma.InputJsonObject => {
	const { defaults, value, result } = baseConfig(
		WidgetType.CALCULATOR,
		raw
	);
	normalizeButtonLayout(result, defaults);
	result.color = calculatorColor(value.color, stringValue(defaults.color));
	result.bgColor = calculatorColor(
		value.bgColor,
		stringValue(defaults.bgColor)
	);
	result.glassEffect = booleanValue(value.glassEffect, false);
	result.buttonColor = calculatorColor(
		value.buttonColor,
		stringValue(defaults.buttonColor)
	);
	result.openButtonColor = calculatorColor(
		value.openButtonColor,
		stringValue(defaults.openButtonColor)
	);
	result.textColor = calculatorColor(
		value.textColor,
		stringValue(defaults.textColor)
	);
	result.buttonSide = value.buttonSide === 'left' ? 'left' : 'right';
	result.buttonPulse = booleanValue(value.buttonPulse, true);
	result.buttonImageUrl = shortString(value.buttonImageUrl, '', 500);
	result.bubbleEnabled = booleanValue(value.bubbleEnabled, true);
	result.bubbleText = shortString(
		value.bubbleText,
		stringValue(defaults.bubbleText),
		100
	);
	result.title = shortString(
		value.title,
		stringValue(defaults.title),
		100
	);
	result.subtitle = shortString(
		value.subtitle,
		stringValue(defaults.subtitle),
		300
	);
	result.calculateButtonText = shortString(
		value.calculateButtonText,
		stringValue(defaults.calculateButtonText),
		50
	);
	result.contactTitle = shortString(
		value.contactTitle,
		stringValue(defaults.contactTitle),
		150
	);
	result.resultTitle = shortString(
		value.resultTitle,
		stringValue(defaults.resultTitle),
		100
	);
	result.dataType = ['NONE', 'EMAIL', 'PHONE_AND_EMAIL'].includes(
		stringValue(value.dataType)
	)
		? value.dataType
		: 'PHONE';
	result.privacyUrl = httpUrl(
		value.privacyUrl,
		stringValue(defaults.privacyUrl)
	);
	result.developInfoActive = booleanValue(value.developInfoActive, true);
	result.filterDuplicates = booleanValue(value.filterDuplicates, false);
	result.basePrice = clamp(
		value.basePrice,
		0,
		MAX_CALCULATOR_PRICE,
		numberValue(defaults.basePrice, 1_000)
	);
	const currency = shortString(
		value.currency,
		stringValue(defaults.currency, 'RUB'),
		3
	)
		.trim()
		.toUpperCase();
	result.currency = /^[A-Z]{3}$/.test(currency) ? currency : 'RUB';
	result.roundingStep = clamp(
		value.roundingStep,
		0.01,
		MAX_CALCULATOR_PRICE,
		1
	);
	result.fields = normalizeCalculatorFields(value.fields, defaults.fields);
	const integrations = asJsonObject(value.integrations);
	result.integrations = {
		email: shortString(integrations.email, '', 200),
		webhookUrl: shortString(integrations.webhookUrl, '', 500),
		telegramChatId: shortString(integrations.telegramChatId, '', 100),
		yandexMetrikaId: shortString(integrations.yandexMetrikaId, '', 100),
		vkPixelId: shortString(integrations.vkPixelId, '', 100),
		bitrix24WebhookUrl: shortString(
			integrations.bitrix24WebhookUrl,
			'',
			500
		),
		roistatEnabled: integrations.roistatEnabled === true,
		amoCrmDomain: shortString(integrations.amoCrmDomain, '', 253),
		amoCrmToken: shortString(integrations.amoCrmToken, '', 1_000)
	};
	return toInputJson(result);
};

export const normalizeWidgetConfig = (
	type: WidgetType,
	raw: unknown
): Prisma.InputJsonObject => {
	switch (type) {
		case WidgetType.WHEEL:
			return normalizeWheel(raw);
		case WidgetType.QUIZ:
			return normalizeQuiz(raw);
		case WidgetType.CALLBACK:
			return normalizeCallback(raw);
		case WidgetType.TIMER:
			return normalizeTimer(raw);
		case WidgetType.STOP_OFFER:
			return normalizeStopOffer(raw);
		case WidgetType.ONLINE_CONSULTANT:
			return normalizeOnlineConsultant(raw);
		case WidgetType.CALCULATOR:
			return normalizeCalculator(raw);
	}
};
