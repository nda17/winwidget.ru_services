import { CreateCalculatorDto } from '@/calculator/dto/create-calculator.dto';
import {
	CalculatorAnswerDto,
	SubmitCalculatorLeadDto
} from '@/calculator/dto/submit-calculator-lead.dto';
import { UpdateCalculatorDto } from '@/calculator/dto/update-calculator.dto';
import { FileService } from '@/file/file.service';
import { enqueueLeadIntegrationEvents } from '@/messaging/lead-integration-event';
import { enqueueEntityLimitReachedEvent } from '@/messaging/limit-reached-event';
import { PrismaService } from '@/prisma.service';
import { SafeOutboundHttpService } from '@/safe-outbound-http/safe-outbound-http.service';
import { PLAN_LIMITS } from '@/subscription/subscription.constants';
import { SubscriptionService } from '@/subscription/subscription.service';
import { normalizePhone } from '@/utils/phone.util';
import {
	isWidgetDomainAllowed,
	normalizeInstallDomain
} from '@/widget-domain/widget-domain.util';
import { cleanupUnreferencedWidgetButtonImage } from '@/widget-domain/widget-button-image-lifecycle';
import {
	assertExpectedDraftRevision,
	getWidgetDraftConfig,
	projectWidgetDraft,
	WidgetType
} from '@/widget-domain/widget-lifecycle';
import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { Plan, Prisma, SubscriptionStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import * as XLSX from 'xlsx';

const MAX_FIELDS = 20;
const MAX_OPTIONS = 20;
const MAX_PRICE = 1_000_000_000;
const MAX_RESULT_PRICE = new Prisma.Decimal('999999999999.99');

type CalculatorFieldType = 'select' | 'number' | 'radio' | 'checkbox';

interface CalculatorOption {
	id: string;
	label: string;
	add: number;
	multiplier: number;
}

interface CalculatorField {
	id: string;
	label: string;
	type: CalculatorFieldType;
	required: boolean;
	options?: CalculatorOption[];
	min?: number;
	max?: number;
	step?: number;
	defaultValue?: number;
	unit?: string;
	unitPrice?: number;
}

interface NormalizedCalculatorAnswer {
	fieldId: string;
	fieldLabel: string;
	type: CalculatorFieldType;
	value: string | number | string[];
	valueLabel: string;
}

const DEFAULT_CONFIG = {
	color: '#4705fb',
	bgColor: '',
	glassEffect: false,
	buttonColor: '',
	openButtonColor: '',
	textColor: '',
	buttonSide: 'right',
	buttonPulse: true,
	buttonBottom: 3,
	buttonOffset: 3,
	buttonSize: 60,
	buttonImageUrl: '',
	bubbleEnabled: true,
	bubbleText: 'Рассчитайте стоимость!',
	autoOpenDelay: null,
	title: 'Калькулятор стоимости',
	subtitle: 'Выберите параметры и узнайте ориентировочную стоимость',
	calculateButtonText: 'Рассчитать',
	contactTitle: 'Оставьте контакт для получения расчёта',
	resultTitle: 'Ориентировочная стоимость',
	dataType: 'NONE',
	privacyUrl:
		'https://winwidget.ru/legal-documentation/consent-processing',
	developInfoActive: true,
	filterDuplicates: false,
	basePrice: 1000,
	currency: 'RUB',
	roundingStep: 1,
	fields: [
		{
			id: 'service',
			label: 'Тип услуги',
			type: 'select',
			required: true,
			options: [
				{
					id: 'standard',
					label: 'Стандарт',
					add: 0,
					multiplier: 1
				},
				{
					id: 'premium',
					label: 'Премиум',
					add: 1000,
					multiplier: 1
				}
			]
		},
		{
			id: 'quantity',
			label: 'Количество',
			type: 'number',
			required: true,
			min: 1,
			max: 1000,
			step: 1,
			defaultValue: 1,
			unit: 'шт.',
			unitPrice: 100
		},
		{
			id: 'extras',
			label: 'Дополнительные услуги',
			type: 'checkbox',
			required: false,
			options: [
				{
					id: 'delivery',
					label: 'Доставка',
					add: 500,
					multiplier: 1
				}
			]
		}
	] as CalculatorField[],
	integrations: {
		email: '',
		webhookUrl: '',
		telegramChatId: '',
		yandexMetrikaId: '',
		vkPixelId: '',
		bitrix24WebhookUrl: '',
		roistatEnabled: false,
		amoCrmDomain: '',
		amoCrmToken: ''
	}
};

const toPlainObject = (value: unknown): Record<string, any> =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, any>)
		: {};

const toNumberValue = (value: unknown, fallback: number): number => {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : fallback;
};

const clampNumber = (
	value: unknown,
	min: number,
	max: number,
	fallback: number
): number => Math.min(max, Math.max(min, toNumberValue(value, fallback)));

const toOptionalDelay = (value: unknown): number | null => {
	if (value === null || value === '' || value === undefined) return null;
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return null;
	return Math.min(86400, numeric);
};

const toShortString = (value: unknown, fallback: string, max = 200) =>
	typeof value === 'string' ? value.slice(0, max) : fallback;

const toColorValue = (value: unknown, fallback: string) => {
	const normalized = toShortString(value, fallback, 32).trim();
	return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(normalized)
		? normalized
		: fallback;
};

const toHttpUrl = (value: unknown, fallback: string, max = 500) => {
	if (value === undefined || value === null) return fallback;
	const normalized = toShortString(value, fallback, max).trim();
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

const toBooleanValue = (value: unknown, fallback: boolean) =>
	typeof value === 'boolean' ? value : fallback;

const toIdentifier = (value: unknown, fallback: string) => {
	if (typeof value !== 'string') return fallback;
	const normalized = value.trim();
	return /^[a-zA-Z0-9_-]{1,64}$/.test(normalized) ? normalized : fallback;
};

const toUniqueIdentifier = (
	value: unknown,
	fallback: string,
	usedIds: Set<string>
) => {
	let id = toIdentifier(value, fallback);
	let suffix = 2;
	while (usedIds.has(id)) {
		id = `${fallback}-${suffix}`;
		suffix += 1;
	}
	usedIds.add(id);
	return id;
};

const normalizeOptions = (
	value: unknown,
	fieldIndex: number
): CalculatorOption[] => {
	const source = Array.isArray(value) ? value.slice(0, MAX_OPTIONS) : [];
	const usedIds = new Set<string>();

	return source.map((option, optionIndex) => {
		const raw = toPlainObject(option);
		const fallbackId = `field-${fieldIndex + 1}-option-${optionIndex + 1}`;
		const id = toUniqueIdentifier(raw.id, fallbackId, usedIds);

		return {
			id,
			label: toShortString(raw.label, `Вариант ${optionIndex + 1}`, 100),
			add: clampNumber(raw.add, -MAX_PRICE, MAX_PRICE, 0),
			multiplier: clampNumber(raw.multiplier, 0.01, 100, 1)
		};
	});
};

const isBooleanOptionPair = (options: CalculatorOption[]) => {
	if (options.length !== 2) return false;
	const labels = new Set(
		options.map(option => option.label.trim().toLocaleLowerCase('ru-RU'))
	);
	return (
		(labels.has('да') && labels.has('нет')) ||
		(labels.has('yes') && labels.has('no'))
	);
};

const normalizeFields = (value: unknown): CalculatorField[] => {
	const source = Array.isArray(value)
		? value.slice(0, MAX_FIELDS)
		: DEFAULT_CONFIG.fields;
	const usedIds = new Set<string>();

	return source.map((field, index) => {
		const raw = toPlainObject(field);
		const fallbackId = `field-${index + 1}`;
		const id = toUniqueIdentifier(raw.id, fallbackId, usedIds);

		const type: CalculatorFieldType = [
			'select',
			'number',
			'radio',
			'checkbox'
		].includes(raw.type)
			? raw.type
			: 'select';
		const base = {
			id,
			label: toShortString(raw.label, `Параметр ${index + 1}`, 100),
			type,
			required: raw.required === true
		};

		if (type !== 'number') {
			const options = normalizeOptions(raw.options, index);
			return {
				...base,
				type:
					type === 'checkbox' && isBooleanOptionPair(options)
						? 'radio'
						: type,
				options
			};
		}

		const min = clampNumber(raw.min, 0, MAX_PRICE, 0);
		const max = clampNumber(raw.max, min, MAX_PRICE, Math.max(min, 100));
		const step = clampNumber(raw.step, 0.01, MAX_PRICE, 1);
		const defaultValue = clampNumber(raw.defaultValue, min, max, min);

		return {
			...base,
			min,
			max,
			step,
			defaultValue,
			unit: toShortString(raw.unit, '', 30),
			unitPrice: clampNumber(raw.unitPrice, -MAX_PRICE, MAX_PRICE, 0)
		};
	});
};

const normalizeCalculatorConfig = (rawConfig: unknown) => {
	const raw = toPlainObject(rawConfig);
	const integrations = toPlainObject(raw.integrations);
	const currency = toShortString(raw.currency, DEFAULT_CONFIG.currency, 3)
		.trim()
		.toUpperCase();

	return {
		...DEFAULT_CONFIG,
		...raw,
		color: toColorValue(raw.color, DEFAULT_CONFIG.color),
		bgColor: toColorValue(raw.bgColor, DEFAULT_CONFIG.bgColor),
		glassEffect: toBooleanValue(
			raw.glassEffect,
			DEFAULT_CONFIG.glassEffect
		),
		buttonColor: toColorValue(raw.buttonColor, DEFAULT_CONFIG.buttonColor),
		openButtonColor: toColorValue(
			raw.openButtonColor,
			DEFAULT_CONFIG.openButtonColor
		),
		textColor: toColorValue(raw.textColor, DEFAULT_CONFIG.textColor),
		buttonSide: raw.buttonSide === 'left' ? 'left' : 'right',
		buttonPulse: toBooleanValue(
			raw.buttonPulse,
			DEFAULT_CONFIG.buttonPulse
		),
		buttonBottom: clampNumber(
			raw.buttonBottom,
			1,
			50,
			DEFAULT_CONFIG.buttonBottom
		),
		buttonOffset: clampNumber(
			raw.buttonOffset,
			1,
			50,
			DEFAULT_CONFIG.buttonOffset
		),
		buttonSize: clampNumber(
			raw.buttonSize,
			40,
			100,
			DEFAULT_CONFIG.buttonSize
		),
		buttonImageUrl: toShortString(
			raw.buttonImageUrl,
			DEFAULT_CONFIG.buttonImageUrl,
			500
		),
		bubbleEnabled: toBooleanValue(
			raw.bubbleEnabled,
			DEFAULT_CONFIG.bubbleEnabled
		),
		bubbleText: toShortString(
			raw.bubbleText,
			DEFAULT_CONFIG.bubbleText,
			100
		),
		autoOpenDelay: toOptionalDelay(raw.autoOpenDelay),
		title: toShortString(raw.title, DEFAULT_CONFIG.title, 100),
		subtitle: toShortString(raw.subtitle, DEFAULT_CONFIG.subtitle, 300),
		calculateButtonText: toShortString(
			raw.calculateButtonText,
			DEFAULT_CONFIG.calculateButtonText,
			50
		),
		contactTitle: toShortString(
			raw.contactTitle,
			DEFAULT_CONFIG.contactTitle,
			150
		),
		dataType: ['NONE', 'EMAIL', 'PHONE_AND_EMAIL'].includes(raw.dataType)
			? raw.dataType
			: 'PHONE',
		resultTitle: toShortString(
			raw.resultTitle,
			DEFAULT_CONFIG.resultTitle,
			100
		),
		privacyUrl: toHttpUrl(raw.privacyUrl, DEFAULT_CONFIG.privacyUrl, 500),
		developInfoActive: toBooleanValue(
			raw.developInfoActive,
			DEFAULT_CONFIG.developInfoActive
		),
		filterDuplicates: toBooleanValue(
			raw.filterDuplicates,
			DEFAULT_CONFIG.filterDuplicates
		),
		basePrice: clampNumber(
			raw.basePrice,
			0,
			MAX_PRICE,
			DEFAULT_CONFIG.basePrice
		),
		currency: /^[A-Z]{3}$/.test(currency)
			? currency
			: DEFAULT_CONFIG.currency,
		roundingStep: clampNumber(
			raw.roundingStep,
			0.01,
			MAX_PRICE,
			DEFAULT_CONFIG.roundingStep
		),
		fields: normalizeFields(raw.fields),
		integrations: {
			email: toShortString(integrations.email, '', 200),
			webhookUrl: toShortString(integrations.webhookUrl, '', 500),
			telegramChatId: toShortString(integrations.telegramChatId, '', 100),
			yandexMetrikaId: toShortString(
				integrations.yandexMetrikaId,
				'',
				100
			),
			vkPixelId: toShortString(integrations.vkPixelId, '', 100),
			bitrix24WebhookUrl: toShortString(
				integrations.bitrix24WebhookUrl,
				'',
				500
			),
			roistatEnabled: integrations.roistatEnabled === true,
			amoCrmDomain: toShortString(integrations.amoCrmDomain, '', 253),
			amoCrmToken: toShortString(integrations.amoCrmToken, '', 1000)
		}
	};
};

@Injectable()
export class CalculatorService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly subscriptionService: SubscriptionService,
		private readonly fileService: FileService,
		private readonly safeOutboundHttpService: SafeOutboundHttpService
	) {}

	async getMyCalculators(userId: string) {
		const subscription =
			await this.subscriptionService.checkAndResetPeriod(userId);
		const calculators = await this.prisma.calculator.findMany({
			where: { userId },
			orderBy: { createdAt: 'desc' },
			include: { _count: { select: { leads: true } } }
		});

		return {
			calculators: calculators.map(calculator =>
				projectWidgetDraft(calculator)
			),
			subscription
		};
	}

	async createCalculator(userId: string, dto: CreateCalculatorDto) {
		const config = DEFAULT_CONFIG as unknown as Prisma.InputJsonValue;
		return this.subscriptionService.createWidgetWithinLimit(
			userId,
			transaction =>
				transaction.calculator.create({
					data: {
						userId,
						publicKey: this.generatePublicKey(),
						name: dto.name || 'Калькулятор',
						config,
						draftConfig: config,
						draftInstallDomain: '',
						draftRevision: 1
					}
				})
		);
	}

	async updateCalculator(
		userId: string,
		calculatorId: string,
		dto: UpdateCalculatorDto
	) {
		const calculator = await this.getByIdAndOwner(calculatorId, userId);
		const currentConfig = toPlainObject(getWidgetDraftConfig(calculator));
		const hasDraftChanges =
			dto.config !== undefined || dto.installDomain !== undefined;
		if (hasDraftChanges) {
			assertExpectedDraftRevision(calculator, dto.expectedDraftRevision);
		}
		const configPatch =
			dto.config !== undefined
				? this.prepareButtonImageConfigPatch(currentConfig, dto.config)
				: undefined;
		const nextConfig =
			configPatch !== undefined
				? normalizeCalculatorConfig({
						...currentConfig,
						...configPatch,
						integrations: {
							...toPlainObject(currentConfig.integrations),
							...toPlainObject(configPatch.integrations)
						}
					})
				: undefined;
		if (dto.config !== undefined && nextConfig) {
			await this.safeOutboundHttpService.validateIntegrationConfig(
				nextConfig.integrations
			);
		}

		const data: Prisma.CalculatorUpdateManyMutationInput = {
			...(dto.name !== undefined && { name: dto.name }),
			...(dto.isActive !== undefined && { isActive: dto.isActive }),
			...(dto.installDomain !== undefined && {
				draftInstallDomain: normalizeInstallDomain(dto.installDomain)
			}),
			...(nextConfig !== undefined && {
				draftConfig: nextConfig as unknown as Prisma.InputJsonValue
			}),
			...(hasDraftChanges && { draftRevision: { increment: 1 } })
		};
		if (hasDraftChanges) {
			const result = await this.prisma.calculator.updateMany({
				where: {
					id: calculator.id,
					userId,
					draftRevision: dto.expectedDraftRevision
				},
				data
			});
			if (result.count !== 1) {
				throw new ConflictException(
					'Настройки уже изменены в другой сессии. Обновите страницу'
				);
			}
		} else {
			await this.prisma.calculator.update({
				where: { id: calculator.id },
				data
			});
		}

		const updated = await this.prisma.calculator.findUniqueOrThrow({
			where: { id: calculator.id }
		});
		if (nextConfig !== undefined) {
			await cleanupUnreferencedWidgetButtonImage(
				this.prisma,
				this.fileService,
				WidgetType.CALCULATOR,
				calculator.id,
				currentConfig.buttonImageUrl
			);
		}
		return projectWidgetDraft(updated);
	}

	async deleteCalculator(userId: string, calculatorId: string) {
		const calculator = await this.getByIdAndOwner(calculatorId, userId);
		const { deleted, imageUrls } = await this.prisma.$transaction(
			async transaction => {
				const deleted = await transaction.calculator.delete({
					where: { id: calculator.id }
				});
				const revisions = await transaction.widgetConfigRevision.findMany({
					where: {
						widgetType: WidgetType.CALCULATOR,
						widgetId: calculator.id
					},
					select: { config: true }
				});
				await transaction.widgetConfigRevision.deleteMany({
					where: {
						widgetType: WidgetType.CALCULATOR,
						widgetId: calculator.id
					}
				});
				await transaction.widgetRuntimeDailyMetric.deleteMany({
					where: {
						widgetType: WidgetType.CALCULATOR,
						widgetId: calculator.id
					}
				});
				await transaction.widgetRuntimePresence.deleteMany({
					where: {
						widgetType: WidgetType.CALCULATOR,
						widgetId: calculator.id
					}
				});
				return {
					deleted,
					imageUrls: this.collectButtonImageUrls([
						deleted.config,
						deleted.draftConfig,
						...revisions.map(revision => revision.config)
					])
				};
			}
		);
		await Promise.all(
			imageUrls.map(url =>
				this.fileService
					.deleteWidgetButtonImage(url)
					.catch(() => undefined)
			)
		);
		return deleted;
	}

	async uploadButtonImage(
		userId: string,
		calculatorId: string,
		file: Express.Multer.File | undefined,
		expectedDraftRevision: number
	) {
		const calculator = await this.getByIdAndOwner(calculatorId, userId);
		assertExpectedDraftRevision(calculator, expectedDraftRevision);
		await this.assertCanUseButtonImage(userId);

		const currentConfig = toPlainObject(getWidgetDraftConfig(calculator));
		let uploadedUrl = '';
		let draftUpdated = false;

		try {
			const uploaded = await this.fileService.saveWidgetButtonImage(
				file,
				'calculator',
				calculator.id
			);
			uploadedUrl = uploaded.url;
			const config = normalizeCalculatorConfig({
				...currentConfig,
				buttonImageUrl: uploadedUrl
			});
			const result = await this.prisma.calculator.updateMany({
				where: {
					id: calculator.id,
					userId,
					draftRevision: expectedDraftRevision
				},
				data: {
					draftConfig: config as unknown as Prisma.InputJsonValue,
					draftRevision: { increment: 1 }
				}
			});
			if (result.count !== 1) {
				throw new ConflictException(
					'Настройки уже изменены в другой сессии. Обновите страницу'
				);
			}
			draftUpdated = true;

			const updated = await this.prisma.calculator.findUniqueOrThrow({
				where: { id: calculator.id }
			});
			await cleanupUnreferencedWidgetButtonImage(
				this.prisma,
				this.fileService,
				WidgetType.CALCULATOR,
				calculator.id,
				currentConfig.buttonImageUrl
			);
			return projectWidgetDraft(updated);
		} catch (error) {
			if (uploadedUrl && !draftUpdated) {
				await this.fileService
					.deleteWidgetButtonImage(uploadedUrl)
					.catch(() => undefined);
			}
			throw error;
		}
	}

	async getLeads(
		userId: string,
		calculatorId: string,
		page = 1,
		limit = 50
	) {
		await this.getByIdAndOwner(calculatorId, userId);
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 50;
		const [leads, total] = await Promise.all([
			this.prisma.calculatorLead.findMany({
				where: { calculatorId },
				orderBy: { createdAt: 'desc' },
				skip: (normalizedPage - 1) * normalizedLimit,
				take: normalizedLimit
			}),
			this.prisma.calculatorLead.count({ where: { calculatorId } })
		]);

		return {
			leads,
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async getLeadsStats(userId: string, calculatorId: string) {
		await this.getByIdAndOwner(calculatorId, userId);
		const subscription =
			await this.subscriptionService.checkAndResetPeriod(userId);
		if (subscription?.plan === Plan.EASY) {
			throw new ForbiddenException('Аналитика недоступна на тарифе Easy');
		}

		const result = await this.prisma.calculatorLead.aggregate({
			where: { calculatorId },
			_count: { id: true },
			_min: { calculatedPrice: true },
			_max: { calculatedPrice: true },
			_avg: { calculatedPrice: true }
		});

		return {
			total: result._count.id,
			min: result._min.calculatedPrice?.toFixed(2) ?? null,
			max: result._max.calculatedPrice?.toFixed(2) ?? null,
			average: result._avg.calculatedPrice?.toFixed(2) ?? null
		};
	}

	async exportLeads(
		userId: string,
		calculatorId: string,
		format: 'csv' | 'xlsx'
	) {
		const calculator = await this.getByIdAndOwner(calculatorId, userId);
		const subscription =
			await this.subscriptionService.checkAndResetPeriod(userId);
		if (subscription?.plan === Plan.EASY) {
			throw new ForbiddenException(
				'Экспорт заявок недоступен на тарифе Easy'
			);
		}

		const leads = await this.prisma.calculatorLead.findMany({
			where: { calculatorId },
			orderBy: { createdAt: 'asc' }
		});
		const safeName = calculator.name.replace(/[^\w\u0400-\u04FF\-]/g, '_');

		if (format === 'csv') {
			return {
				data: this.buildCsv(leads),
				contentType: 'text/csv; charset=utf-8',
				filename: `calculator_leads_${safeName}.csv`
			};
		}

		const rows = leads.map((lead, index) => ({
			'№': index + 1,
			Дата: new Date(lead.createdAt).toLocaleString('ru-RU'),
			Телефон: lead.phone || lead.contact || '',
			Email: lead.email || '',
			Стоимость: lead.calculatedPrice.toFixed(2),
			Валюта: lead.currency,
			Параметры: this.formatAnswers(lead.answers),
			Страница: lead.url || ''
		}));
		const sheet = XLSX.utils.json_to_sheet(rows);
		const workbook = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(workbook, sheet, 'Заявки');
		const data = XLSX.write(workbook, {
			type: 'buffer',
			bookType: 'xlsx'
		}) as Buffer;

		return {
			data,
			contentType:
				'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			filename: `calculator_leads_${safeName}.xlsx`
		};
	}

	async getPublicConfig(
		publicKey: string,
		requestDomain: string | null = null,
		directPageAccessAllowed = false
	): Promise<object | null> {
		const calculator = await this.prisma.calculator.findUnique({
			where: { publicKey },
			include: { user: { include: { subscription: true } } }
		});
		if (!calculator) return null;
		if (!calculator.publishedAt || calculator.publishedVersion === 0) {
			return { isActive: false };
		}

		const config = normalizeCalculatorConfig(calculator.config);
		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(calculator.installDomain, requestDomain)
		) {
			return { isActive: false };
		}

		const subscription =
			await this.subscriptionService.checkAndResetPeriod(
				calculator.userId
			);
		const hasHardSubscription =
			subscription?.status === SubscriptionStatus.ACTIVE &&
			subscription.plan === Plan.HARD;
		let canAcceptLeads =
			calculator.isActive &&
			subscription?.status === SubscriptionStatus.ACTIVE;

		if (canAcceptLeads && subscription) {
			const limits = PLAN_LIMITS[subscription.plan];
			if (
				!limits.unlimited &&
				subscription.leadsThisPeriod >= limits.maxLeadsPerPeriod
			) {
				canAcceptLeads = false;
			}
		}

		if (!canAcceptLeads) return { isActive: false };

		return {
			isActive: true,
			color: config.color || '#4705fb',
			bgColor: config.bgColor || null,
			buttonColor: config.buttonColor || '',
			openButtonColor: config.openButtonColor || '',
			buttonSide: config.buttonSide || 'right',
			buttonPulse: config.buttonPulse !== false,
			buttonBottom: config.buttonBottom ?? 3,
			buttonOffset: config.buttonOffset ?? 3,
			buttonSize: config.buttonSize ?? 60,
			buttonImageUrl: this.fileService.getWidgetButtonImageUrl(
				config.buttonImageUrl,
				hasHardSubscription
			),
			hideBranding: hasHardSubscription,
			bubbleEnabled: config.bubbleEnabled !== false,
			bubbleText: config.bubbleText || 'Рассчитайте стоимость!',
			autoOpenDelay: config.autoOpenDelay || null,
			title: config.title || 'Калькулятор стоимости',
			subtitle: config.subtitle || '',
			glassEffect: config.glassEffect === true,
			textColor: config.textColor || '',
			calculateButtonText: config.calculateButtonText || 'Рассчитать',
			contactTitle: config.contactTitle || '',
			resultTitle: config.resultTitle || 'Ориентировочная стоимость',
			dataType: config.dataType,
			privacyUrl: config.privacyUrl || null,
			developInfoActive:
				config.developInfoActive !== false && !hasHardSubscription,
			basePrice: config.basePrice,
			currency: config.currency,
			roundingStep: config.roundingStep,
			fields: config.fields,
			yandexMetrikaId: config.integrations.yandexMetrikaId || null,
			vkPixelId: config.integrations.vkPixelId || null,
			roistatEnabled: config.integrations.roistatEnabled === true
		};
	}

	async submitLead(
		publicKey: string,
		dto: SubmitCalculatorLeadDto,
		ip?: string,
		requestDomain: string | null = null,
		directPageAccessAllowed = false
	) {
		const calculator = await this.prisma.calculator.findUnique({
			where: { publicKey },
			include: {
				user: {
					include: {
						subscription: true,
						authIdentities: { where: { type: 'EMAIL' } }
					}
				}
			}
		});
		if (!calculator) throw new NotFoundException('Калькулятор не найден');
		if (!calculator.publishedAt || calculator.publishedVersion === 0) {
			throw new ForbiddenException('Виджет ещё не опубликован');
		}

		if (!calculator.isActive) {
			throw new ForbiddenException(
				'Лимит заявок исчерпан или подписка неактивна'
			);
		}

		const config = normalizeCalculatorConfig(calculator.config);
		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(calculator.installDomain, requestDomain)
		) {
			throw new ForbiddenException('Домен установки виджета не совпадает');
		}

		const normalizedPhone = dto.phone
			? normalizePhone(dto.phone)
			: undefined;
		const normalizedEmail = dto.email?.trim().toLowerCase();
		if (
			normalizedPhone &&
			!/^[+][1-9][0-9]{7,14}$/.test(normalizedPhone)
		) {
			throw new BadRequestException('Укажите корректный телефон');
		}
		const normalizedDto: SubmitCalculatorLeadDto = {
			...dto,
			contact: normalizedPhone || normalizedEmail || '',
			phone: normalizedPhone,
			email: normalizedEmail
		};
		this.assertContact(config.dataType, normalizedDto);
		const calculation = this.calculate(config, dto.answers);
		const { lead } = await this.subscriptionService.createLeadWithinLimit(
			calculator.userId,
			async transaction => {
				if (config.filterDuplicates) {
					const or: Prisma.CalculatorLeadWhereInput[] = [];
					if (normalizedPhone) or.push({ phone: normalizedPhone });
					if (normalizedEmail) or.push({ email: normalizedEmail });
					if (ip) or.push({ ip });
					const existing = await transaction.calculatorLead.findFirst({
						where: {
							calculatorId: calculator.id,
							OR: or
						}
					});
					if (existing) {
						throw new BadRequestException(
							'Заявка с таким контактом уже существует'
						);
					}
				}

				const createdLead = await transaction.calculatorLead.create({
					data: {
						calculatorId: calculator.id,
						contact: normalizedDto.contact || '',
						phone: normalizedPhone,
						email: normalizedEmail,
						answers:
							calculation.answers as unknown as Prisma.InputJsonValue,
						calculatedPrice: calculation.price,
						currency: config.currency,
						url: dto.url,
						ip: ip || null
					}
				});
				await enqueueLeadIntegrationEvents(transaction, {
					source: 'calculator',
					entity: { id: calculator.id, name: calculator.name },
					lead: {
						id: createdLead.id,
						contact: normalizedDto.contact,
						phone: normalizedPhone,
						email: normalizedEmail,
						answers: calculation.answers,
						calculatedPrice: calculation.price.toFixed(2),
						currency: config.currency,
						url: dto.url,
						createdAt: createdLead.createdAt
					},
					integrations: config.integrations
				});
				return createdLead;
			},
			(transaction, limit) =>
				enqueueEntityLimitReachedEvent(transaction, {
					entity: {
						id: calculator.id,
						name: calculator.name,
						type: 'calculator'
					},
					limit,
					accountEmail: calculator.user?.authIdentities?.[0]?.value,
					integrationEmail: config.integrations.email,
					telegramChatId: config.integrations.telegramChatId
				})
		);

		return {
			success: true,
			lead,
			calculatedPrice: calculation.price.toFixed(2),
			currency: config.currency
		};
	}

	private calculate(
		config: ReturnType<typeof normalizeCalculatorConfig>,
		answers: CalculatorAnswerDto[]
	) {
		const answersByField = new Map<string, CalculatorAnswerDto>();
		for (const answer of answers) {
			if (answersByField.has(answer.fieldId)) {
				throw new BadRequestException('Параметр передан несколько раз');
			}
			answersByField.set(answer.fieldId, answer);
		}

		const configuredIds = new Set(
			config.fields.map((field: CalculatorField) => field.id)
		);
		for (const fieldId of answersByField.keys()) {
			if (!configuredIds.has(fieldId)) {
				throw new BadRequestException('Передан неизвестный параметр');
			}
		}

		let subtotal = new Prisma.Decimal(config.basePrice);
		let totalMultiplier = new Prisma.Decimal(1);
		const normalizedAnswers: NormalizedCalculatorAnswer[] = [];

		for (const field of config.fields as CalculatorField[]) {
			const answer = answersByField.get(field.id);
			if (!answer) {
				if (field.required) {
					throw new BadRequestException(
						`Заполните параметр «${field.label}»`
					);
				}
				continue;
			}

			if (field.type === 'number') {
				const numeric = Number(answer.value);
				if (!Number.isFinite(numeric)) {
					throw new BadRequestException(
						`Некорректное значение параметра «${field.label}»`
					);
				}
				const min = field.min ?? 0;
				const max = field.max ?? MAX_PRICE;
				const step = field.step ?? 1;
				if (numeric < min || numeric > max) {
					throw new BadRequestException(
						`Значение параметра «${field.label}» вне допустимого диапазона`
					);
				}
				const steps = (numeric - min) / step;
				if (Math.abs(steps - Math.round(steps)) > 1e-7) {
					throw new BadRequestException(
						`Некорректный шаг параметра «${field.label}»`
					);
				}

				subtotal = subtotal.add(
					new Prisma.Decimal(numeric).mul(field.unitPrice ?? 0)
				);
				normalizedAnswers.push({
					fieldId: field.id,
					fieldLabel: field.label,
					type: field.type,
					value: numeric,
					valueLabel: `${numeric}${field.unit ? ` ${field.unit}` : ''}`
				});
				continue;
			}

			const selectedIds =
				field.type === 'checkbox'
					? Array.isArray(answer.value)
						? answer.value
						: null
					: typeof answer.value === 'string'
						? [answer.value]
						: null;
			if (
				!selectedIds ||
				selectedIds.some(value => typeof value !== 'string')
			) {
				throw new BadRequestException(
					`Некорректное значение параметра «${field.label}»`
				);
			}
			const uniqueIds = [...new Set(selectedIds as string[])];
			if (field.required && uniqueIds.length === 0) {
				throw new BadRequestException(
					`Заполните параметр «${field.label}»`
				);
			}
			if (
				(field.type === 'select' || field.type === 'radio') &&
				uniqueIds.length !== 1
			) {
				throw new BadRequestException(
					`Выберите один вариант параметра «${field.label}»`
				);
			}

			const selectedOptions = uniqueIds.map(id => {
				const option = field.options?.find(item => item.id === id);
				if (!option) {
					throw new BadRequestException(
						`Передан неизвестный вариант параметра «${field.label}»`
					);
				}
				return option;
			});
			for (const option of selectedOptions) {
				subtotal = subtotal.add(option.add);
				totalMultiplier = totalMultiplier.mul(option.multiplier);
			}
			normalizedAnswers.push({
				fieldId: field.id,
				fieldLabel: field.label,
				type: field.type,
				value:
					field.type === 'select' || field.type === 'radio'
						? uniqueIds[0] || ''
						: uniqueIds,
				valueLabel: selectedOptions.map(option => option.label).join(', ')
			});
		}

		let price = subtotal.mul(totalMultiplier);
		if (price.isNegative()) price = new Prisma.Decimal(0);
		price = price
			.div(config.roundingStep)
			.round()
			.mul(config.roundingStep)
			.toDecimalPlaces(2);

		if (price.greaterThan(MAX_RESULT_PRICE)) {
			throw new BadRequestException('Результат расчёта слишком большой');
		}

		return { price, answers: normalizedAnswers };
	}

	private assertContact(dataType: string, dto: SubmitCalculatorLeadDto) {
		if (dataType === 'NONE') {
			throw new BadRequestException('Сбор контактов отключён');
		}
		if (dataType === 'EMAIL' && !dto.email) {
			throw new BadRequestException('Укажите email');
		}
		if (dataType === 'PHONE' && !dto.phone) {
			throw new BadRequestException('Укажите телефон');
		}
		if (dataType === 'PHONE_AND_EMAIL' && (!dto.phone || !dto.email)) {
			throw new BadRequestException('Укажите телефон и email');
		}
	}

	private buildCsv(leads: Array<Record<string, any>>) {
		const headers = [
			'№',
			'Дата',
			'Телефон',
			'Email',
			'Стоимость',
			'Валюта',
			'Параметры',
			'Страница'
		];
		const escape = (value: unknown) => {
			const string = String(value ?? '');
			const safeString = /^[=+\-@\t\r]/.test(string)
				? `'${string}`
				: string;
			return safeString.includes(',') ||
				safeString.includes('"') ||
				safeString.includes('\n')
				? `"${safeString.replace(/"/g, '""')}"`
				: safeString;
		};
		const rows = leads.map((lead, index) => [
			index + 1,
			new Date(lead.createdAt).toLocaleString('ru-RU'),
			lead.phone || lead.contact || '',
			lead.email || '',
			lead.calculatedPrice.toFixed(2),
			lead.currency,
			this.formatAnswers(lead.answers),
			lead.url || ''
		]);
		const csv = [headers, ...rows]
			.map(row => row.map(escape).join(','))
			.join('\r\n');
		return Buffer.from('\uFEFF' + csv, 'utf-8');
	}

	private formatAnswers(value: unknown) {
		if (!Array.isArray(value)) return '';
		return value
			.map(item => {
				const answer = toPlainObject(item);
				return answer.fieldLabel && answer.valueLabel
					? `${answer.fieldLabel}: ${answer.valueLabel}`
					: '';
			})
			.filter(Boolean)
			.join('; ');
	}

	private async getByIdAndOwner(calculatorId: string, userId: string) {
		const calculator = await this.prisma.calculator.findUnique({
			where: { id: calculatorId }
		});
		if (!calculator) throw new NotFoundException('Калькулятор не найден');
		if (calculator.userId !== userId) {
			throw new ForbiddenException('Нет доступа');
		}
		return calculator;
	}

	private async assertCanUseButtonImage(userId: string) {
		const subscription =
			await this.subscriptionService.checkAndResetPeriod(userId);
		if (
			!subscription ||
			subscription.status !== SubscriptionStatus.ACTIVE ||
			subscription.plan !== Plan.HARD
		) {
			throw new ForbiddenException(
				'Загрузка своей картинки кнопки доступна только на тарифе Hard'
			);
		}
	}

	private prepareButtonImageConfigPatch(
		currentConfig: Record<string, any>,
		configPatch: Record<string, unknown>
	) {
		const patch = { ...configPatch } as Record<string, any>;
		if (!Object.prototype.hasOwnProperty.call(patch, 'buttonImageUrl')) {
			return patch;
		}

		const currentUrl =
			typeof currentConfig.buttonImageUrl === 'string'
				? currentConfig.buttonImageUrl
				: '';
		const nextUrl =
			typeof patch.buttonImageUrl === 'string' ? patch.buttonImageUrl : '';

		if (nextUrl && nextUrl !== currentUrl) {
			throw new BadRequestException(
				'Картинку кнопки нужно загружать через отдельное поле загрузки'
			);
		}

		patch.buttonImageUrl = nextUrl;
		return patch;
	}

	private collectButtonImageUrls(configs: unknown[]) {
		return [
			...new Set(
				configs
					.map(config => toPlainObject(config).buttonImageUrl)
					.filter(
						(value): value is string =>
							typeof value === 'string' && value.length > 0
					)
			)
		];
	}

	private escapeHtml(value: unknown) {
		return String(value ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}

	private generatePublicKey() {
		return randomBytes(6).toString('hex');
	}
}
