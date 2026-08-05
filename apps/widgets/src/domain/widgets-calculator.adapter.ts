import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/widgets-client';
import { asJsonObject, WidgetType } from './widgets-domain.types';
import {
	assertContact,
	brandingPublicFields,
	buttonPublicFields,
	dataType,
	DuplicateLeadRule,
	formatCalculatorAnswers,
	integrationPublicFields,
	normalizeEmail,
	normalizePhone,
	numberValue,
	PreparedWidgetLead,
	PublicDuplicateRule,
	stringValue,
	toInputJson,
	WidgetExportSpec,
	WidgetPublicContext,
	WidgetTypeAdapter
} from './widgets-type-adapter';

const MAX_RESULT_PRICE = new Prisma.Decimal('999999999999.99');

interface CalculatorAnswer {
	fieldId: string;
	value: unknown;
}

interface NormalizedAnswer extends Prisma.InputJsonObject {
	fieldId: string;
	fieldLabel: string;
	type: string;
	value: Prisma.InputJsonValue;
	valueLabel: string;
}

const decimalText = (value: Prisma.Decimal | null | undefined) =>
	value?.toFixed(2) ?? null;

export const calculatorWidgetAdapter: WidgetTypeAdapter = {
	type: WidgetType.CALCULATOR,

	publicConfig(config, context: WidgetPublicContext) {
		return {
			isActive: true,
			publishedVersion: context.publishedVersion,
			color: stringValue(config.color, '#4705fb'),
			bgColor: stringValue(config.bgColor) || null,
			...buttonPublicFields(config, context.hardPlan),
			bubbleEnabled: config.bubbleEnabled !== false,
			bubbleText: stringValue(config.bubbleText, 'Рассчитайте стоимость!'),
			autoOpenDelay: config.autoOpenDelay || null,
			title: stringValue(config.title, 'Калькулятор стоимости'),
			subtitle: stringValue(config.subtitle),
			glassEffect: config.glassEffect === true,
			textColor: stringValue(config.textColor),
			calculateButtonText: stringValue(
				config.calculateButtonText,
				'Рассчитать'
			),
			contactTitle: stringValue(config.contactTitle),
			resultTitle: stringValue(
				config.resultTitle,
				'Ориентировочная стоимость'
			),
			dataType: dataType(config, 'NONE'),
			privacyUrl: stringValue(config.privacyUrl) || null,
			...brandingPublicFields(config, context.hardPlan),
			basePrice: numberValue(config.basePrice, 0),
			currency: stringValue(config.currency, 'RUB'),
			roundingStep: numberValue(config.roundingStep, 1),
			fields: Array.isArray(config.fields) ? config.fields : [],
			...integrationPublicFields(config)
		};
	},

	prepareLead(input, config): PreparedWidgetLead {
		const phone = normalizePhone(input.phone);
		const email = normalizeEmail(input.email);
		assertContact(dataType(config, 'NONE'), phone, email);
		const calculation = calculate(config, input.answers || []);
		const currency = stringValue(config.currency, 'RUB')
			.slice(0, 3)
			.toUpperCase();
		return {
			data: {
				contact: phone || email || '',
				phone,
				email,
				answers: toInputJson(calculation.answers),
				calculatedPrice: calculation.price,
				currency,
				url: input.url?.slice(0, 500)
			},
			response: {
				calculatedPrice: calculation.price.toFixed(2),
				currency
			}
		};
	},

	duplicateRules(prepared, config, ip): DuplicateLeadRule[] {
		if (config.filterDuplicates !== true) return [];
		return [
			{
				lookup: {
					phone: prepared.phone,
					email: prepared.email,
					ip: ip || undefined
				},
				message: 'Заявка с таким контактом уже существует'
			}
		];
	},

	publicDuplicateRule(): PublicDuplicateRule | null {
		return null;
	},

	presentLead(lead) {
		return lead;
	},

	stats(aggregate) {
		if (aggregate.kind !== 'calculator') {
			throw new Error('Calculator stats aggregation kind is invalid');
		}
		if (!aggregate.total) {
			return { total: 0, min: null, max: null, average: null };
		}
		return {
			total: aggregate.total,
			min: decimalText(aggregate.min),
			max: decimalText(aggregate.max),
			average: decimalText(aggregate.average)
		};
	},

	exportSpec(leads): WidgetExportSpec {
		return {
			filenamePrefix: 'calculator_leads',
			headers: [
				'№',
				'Дата',
				'Телефон',
				'Email',
				'Стоимость',
				'Валюта',
				'Параметры',
				'Страница'
			],
			rows: leads.map((lead, index) => [
				index + 1,
				lead.createdAt.toLocaleString('ru-RU'),
				lead.phone || lead.contact || '',
				lead.email || '',
				lead.calculatedPrice?.toFixed(2) || '',
				lead.currency || '',
				formatCalculatorAnswers(lead.answers),
				lead.url || ''
			])
		};
	}
};

function calculate(
	config: Record<string, unknown>,
	rawAnswers: unknown[]
): { price: Prisma.Decimal; answers: NormalizedAnswer[] } {
	const answers = parseAnswers(rawAnswers);
	const answersByField = new Map<string, CalculatorAnswer>();
	for (const answer of answers) {
		if (answersByField.has(answer.fieldId)) {
			throw new BadRequestException('Параметр передан несколько раз');
		}
		answersByField.set(answer.fieldId, answer);
	}
	const fields = Array.isArray(config.fields)
		? config.fields.map(asJsonObject).slice(0, 20)
		: [];
	const configuredIds = new Set(
		fields.map(field => stringValue(field.id))
	);
	for (const fieldId of answersByField.keys()) {
		if (!configuredIds.has(fieldId)) {
			throw new BadRequestException('Передан неизвестный параметр');
		}
	}

	let subtotal = new Prisma.Decimal(numberValue(config.basePrice, 0));
	let multiplier = new Prisma.Decimal(1);
	const normalized: NormalizedAnswer[] = [];
	for (const field of fields) {
		const id = stringValue(field.id);
		const label = stringValue(field.label, id);
		const fieldType = stringValue(field.type);
		const answer = answersByField.get(id);
		if (!answer) {
			if (field.required === true) {
				throw new BadRequestException(`Заполните параметр «${label}»`);
			}
			continue;
		}
		if (fieldType === 'number') {
			const numeric = Number(answer.value);
			if (!Number.isFinite(numeric)) {
				throw new BadRequestException(
					`Некорректное значение параметра «${label}»`
				);
			}
			const min = numberValue(field.min, 0);
			const max = numberValue(
				field.max,
				Number(MAX_RESULT_PRICE.toString())
			);
			const step = numberValue(field.step, 1);
			if (numeric < min || numeric > max) {
				throw new BadRequestException(
					`Значение параметра «${label}» вне допустимого диапазона`
				);
			}
			if (
				step <= 0 ||
				Math.abs(
					(numeric - min) / step - Math.round((numeric - min) / step)
				) > 1e-7
			) {
				throw new BadRequestException(
					`Некорректный шаг параметра «${label}»`
				);
			}
			subtotal = subtotal.add(
				new Prisma.Decimal(numeric).mul(numberValue(field.unitPrice, 0))
			);
			normalized.push({
				fieldId: id,
				fieldLabel: label,
				type: fieldType,
				value: numeric,
				valueLabel: `${numeric}${field.unit ? ` ${String(field.unit)}` : ''}`
			});
			continue;
		}
		const selected =
			fieldType === 'checkbox'
				? Array.isArray(answer.value)
					? answer.value
					: null
				: typeof answer.value === 'string'
					? [answer.value]
					: null;
		if (!selected || selected.some(value => typeof value !== 'string')) {
			throw new BadRequestException(
				`Некорректное значение параметра «${label}»`
			);
		}
		const ids = [...new Set(selected as string[])];
		if (field.required === true && !ids.length) {
			throw new BadRequestException(`Заполните параметр «${label}»`);
		}
		if (['select', 'radio'].includes(fieldType) && ids.length !== 1) {
			throw new BadRequestException(
				`Выберите один вариант параметра «${label}»`
			);
		}
		const options = Array.isArray(field.options)
			? field.options.map(asJsonObject)
			: [];
		const selectedOptions = ids.map(optionId => {
			const option = options.find(item => item.id === optionId);
			if (!option) {
				throw new BadRequestException(
					`Передан неизвестный вариант параметра «${label}»`
				);
			}
			return option;
		});
		for (const option of selectedOptions) {
			subtotal = subtotal.add(numberValue(option.add, 0));
			multiplier = multiplier.mul(numberValue(option.multiplier, 1));
		}
		normalized.push({
			fieldId: id,
			fieldLabel: label,
			type: fieldType,
			value: (['select', 'radio'].includes(fieldType)
				? ids[0] || ''
				: ids) as Prisma.InputJsonValue,
			valueLabel: selectedOptions
				.map(option => stringValue(option.label))
				.join(', ')
		});
	}
	const roundingStep = new Prisma.Decimal(
		Math.max(0.01, numberValue(config.roundingStep, 1))
	);
	let price = subtotal.mul(multiplier);
	if (price.isNegative()) price = new Prisma.Decimal(0);
	price = price
		.div(roundingStep)
		.round()
		.mul(roundingStep)
		.toDecimalPlaces(2);
	if (price.greaterThan(MAX_RESULT_PRICE)) {
		throw new BadRequestException('Результат расчёта слишком большой');
	}
	return { price, answers: normalized };
}

function parseAnswers(value: unknown[]): CalculatorAnswer[] {
	return value.map(item => {
		const record = asJsonObject(item);
		const keys = Object.keys(record).sort();
		if (
			keys.join(',') !== 'fieldId,value' ||
			typeof record.fieldId !== 'string' ||
			!record.fieldId ||
			record.fieldId.length > 64
		) {
			throw new BadRequestException('Некорректный параметр калькулятора');
		}
		return { fieldId: record.fieldId, value: record.value };
	});
}
