import { FileService } from '@/file/file.service';
import { enqueueLeadIntegrationEvents } from '@/messaging/lead-integration-event';
import { enqueueEntityLimitReachedEvent } from '@/messaging/limit-reached-event';
import { PrismaService } from '@/prisma.service';
import { SafeOutboundHttpService } from '@/safe-outbound-http/safe-outbound-http.service';
import { PLAN_LIMITS } from '@/subscription/subscription.constants';
import { SubscriptionService } from '@/subscription/subscription.service';
import { CreateOnlineConsultantDto } from '@/online-consultant/dto/create-online-consultant.dto';
import { SubmitOnlineConsultantLeadDto } from '@/online-consultant/dto/submit-online-consultant-lead.dto';
import { UpdateOnlineConsultantDto } from '@/online-consultant/dto/update-online-consultant.dto';
import {
	isWidgetDomainAllowed,
	normalizeInstallDomain
} from '@/widget-domain/widget-domain.util';
import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { Plan, SubscriptionStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import * as XLSX from 'xlsx';

const DEFAULT_CONFIG = {
	color: '#ef2b17',
	bgColor: '',
	buttonColor: '',
	openButtonColor: '',
	buttonSide: 'right',
	buttonPulse: true,
	buttonBottom: 3,
	buttonOffset: 3,
	buttonSize: 60,
	buttonImageUrl: '',
	autoOpenDelay: null,
	bubbleEnabled: false,
	bubbleText: '',
	title: 'Онлайн-консультант',
	subtitle: 'Выберите популярный вопрос и получите быстрый ответ.',
	dataType: 'PHONE',
	contactTitle: 'Оставьте контакт, если нужен персональный ответ',
	submitButtonText: 'Отправить',
	successTitle: 'Спасибо! Заявка отправлена',
	successSubtitle: 'Мы скоро свяжемся с вами',
	privacyUrl:
		'https://winwidget.ru/legal-documentation/consent-processing',
	developInfoActive: true,
	filterDuplicates: false,
	quickActions: [
		{
			id: 'price',
			label: 'Цена',
			answer:
				'Стоимость зависит от задачи и комплектации. Оставьте контакт, и мы быстро подскажем актуальный вариант.',
			buttonText: '',
			buttonUrl: ''
		},
		{
			id: 'delivery',
			label: 'Доставка',
			answer:
				'Доставка рассчитывается по адресу и способу получения. Мы уточним детали и предложим удобный вариант.',
			buttonText: '',
			buttonUrl: ''
		},
		{
			id: 'terms',
			label: 'Сроки',
			answer:
				'Сроки зависят от наличия и региона. Обычно мы можем подсказать ориентир сразу после заявки.',
			buttonText: '',
			buttonUrl: ''
		},
		{
			id: 'selection',
			label: 'Подбор',
			answer:
				'Опишите задачу, и мы поможем подобрать подходящий вариант без полноценного чата.',
			buttonText: '',
			buttonUrl: ''
		}
	],
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

const ONLINE_CONSULTANT_DATA_TYPES = new Set([
	'PHONE',
	'EMAIL',
	'PHONE_AND_EMAIL',
	'NONE'
]);
const MIN_QUICK_ACTIONS = 2;
const MAX_QUICK_ACTIONS = 10;

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

const getDataType = (value: unknown): string => {
	const normalized = typeof value === 'string' ? value.toUpperCase() : '';
	return ONLINE_CONSULTANT_DATA_TYPES.has(normalized)
		? normalized
		: 'PHONE';
};

const getQuickActions = (value: unknown) => {
	if (!Array.isArray(value)) {
		throw new BadRequestException('Добавьте от 2 до 10 вопросов');
	}

	if (
		value.length < MIN_QUICK_ACTIONS ||
		value.length > MAX_QUICK_ACTIONS
	) {
		throw new BadRequestException('Должно быть от 2 до 10 вопросов');
	}

	return value.map((action, index) => {
		if (!action || typeof action !== 'object') {
			throw new BadRequestException(
				`Вопрос ${index + 1} заполнен некорректно`
			);
		}

		const item = action as Record<string, unknown>;
		const label =
			typeof item.label === 'string' ? item.label.trim().slice(0, 40) : '';
		const answer =
			typeof item.answer === 'string'
				? item.answer.trim().slice(0, 1200)
				: '';

		if (!label || !answer) {
			throw new BadRequestException(
				`Заполните вопрос и ответ ${index + 1}`
			);
		}

		const buttonText =
			typeof item.buttonText === 'string'
				? item.buttonText.trim().slice(0, 80)
				: '';
		const buttonUrl =
			typeof item.buttonUrl === 'string'
				? item.buttonUrl.trim().slice(0, 500)
				: '';

		if (buttonUrl && !buttonText) {
			throw new BadRequestException(
				`Вопрос ${index + 1}: заполните текст кнопки перехода или уберите ссылку`
			);
		}

		return {
			id:
				typeof item.id === 'string' && item.id.trim()
					? item.id.trim().slice(0, 60)
					: `action-${index + 1}`,
			label,
			answer,
			buttonText,
			buttonUrl
		};
	});
};

const normalizeOnlineConsultantConfig = (rawConfig: unknown) => {
	const raw = toPlainObject(rawConfig);

	return {
		...DEFAULT_CONFIG,
		...raw,
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
		autoOpenDelay: toOptionalDelay(raw.autoOpenDelay),
		quickActions: Array.isArray(raw.quickActions)
			? raw.quickActions
			: DEFAULT_CONFIG.quickActions,
		integrations: {
			...DEFAULT_CONFIG.integrations,
			...toPlainObject(raw.integrations)
		}
	};
};

@Injectable()
export class OnlineConsultantService {
	constructor(
		private prisma: PrismaService,
		private subscriptionService: SubscriptionService,
		private fileService: FileService,
		private safeOutboundHttpService: SafeOutboundHttpService
	) {}

	async getMyOnlineConsultants(userId: string) {
		const sub = await this.subscriptionService.checkAndResetPeriod(userId);
		const onlineConsultants = await this.prisma.onlineConsultant.findMany({
			where: { userId },
			orderBy: { createdAt: 'desc' },
			include: { _count: { select: { leads: true } } }
		});
		return { onlineConsultants, subscription: sub };
	}

	async createOnlineConsultant(
		userId: string,
		dto: CreateOnlineConsultantDto
	) {
		return this.subscriptionService.createWidgetWithinLimit(
			userId,
			transaction =>
				transaction.onlineConsultant.create({
					data: {
						userId,
						publicKey: this.generatePublicKey(),
						name: dto.name || 'Онлайн-консультант',
						config: DEFAULT_CONFIG
					}
				})
		);
	}

	async updateOnlineConsultant(
		userId: string,
		onlineConsultantId: string,
		dto: UpdateOnlineConsultantDto
	) {
		const onlineConsultant = await this.getByIdAndOwner(
			onlineConsultantId,
			userId
		);
		const currentConfig = onlineConsultant.config as Record<string, any>;
		const configPatch =
			dto.config !== undefined
				? this.prepareButtonImageConfigPatch(currentConfig, dto.config)
				: undefined;
		const nextConfig =
			configPatch !== undefined
				? normalizeOnlineConsultantConfig({
						...currentConfig,
						...configPatch,
						integrations: {
							...(currentConfig.integrations || {}),
							...(configPatch.integrations || {})
						},
						...(Object.prototype.hasOwnProperty.call(
							configPatch,
							'quickActions'
						) && {
							quickActions: getQuickActions(configPatch.quickActions)
						})
					})
				: undefined;
		if (dto.config !== undefined && nextConfig) {
			await this.safeOutboundHttpService.validateIntegrationConfig(
				nextConfig.integrations
			);
		}

		const updated = await this.prisma.onlineConsultant.update({
			where: { id: onlineConsultant.id },
			data: {
				...(dto.name !== undefined && { name: dto.name }),
				...(dto.isActive !== undefined && { isActive: dto.isActive }),
				...(dto.installDomain !== undefined && {
					installDomain: normalizeInstallDomain(dto.installDomain)
				}),
				...(nextConfig !== undefined && { config: nextConfig })
			}
		});

		if (nextConfig) {
			await this.deleteButtonImageIfRemoved(currentConfig, nextConfig);
		}

		return updated;
	}

	async deleteOnlineConsultant(
		userId: string,
		onlineConsultantId: string
	) {
		const onlineConsultant = await this.getByIdAndOwner(
			onlineConsultantId,
			userId
		);
		await this.fileService.deleteWidgetButtonImage(
			(onlineConsultant.config as Record<string, any>).buttonImageUrl
		);
		return this.prisma.onlineConsultant.delete({
			where: { id: onlineConsultant.id }
		});
	}

	async uploadButtonImage(
		userId: string,
		onlineConsultantId: string,
		file: Express.Multer.File | undefined
	) {
		const onlineConsultant = await this.getByIdAndOwner(
			onlineConsultantId,
			userId
		);
		await this.assertCanUseButtonImage(userId);

		const currentConfig = onlineConsultant.config as Record<string, any>;
		let uploadedUrl = '';

		try {
			const uploadedFile = await this.fileService.saveWidgetButtonImage(
				file,
				'online-consultant',
				onlineConsultant.id
			);
			uploadedUrl = uploadedFile.url;

			const updated = await this.prisma.onlineConsultant.update({
				where: { id: onlineConsultant.id },
				data: {
					config: normalizeOnlineConsultantConfig({
						...currentConfig,
						buttonImageUrl: uploadedUrl
					})
				}
			});

			await this.fileService
				.deleteWidgetButtonImage(currentConfig.buttonImageUrl)
				.catch(() => undefined);

			return updated;
		} catch (error) {
			if (uploadedUrl) {
				await this.fileService
					.deleteWidgetButtonImage(uploadedUrl)
					.catch(() => undefined);
			}
			throw error;
		}
	}

	async getLeads(
		userId: string,
		onlineConsultantId: string,
		page = 1,
		limit = 50
	) {
		await this.getByIdAndOwner(onlineConsultantId, userId);

		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? limit : 50;
		const skip = (normalizedPage - 1) * normalizedLimit;
		const [leads, total] = await Promise.all([
			this.prisma.onlineConsultantLead.findMany({
				where: { onlineConsultantId },
				orderBy: { createdAt: 'desc' },
				skip,
				take: normalizedLimit
			}),
			this.prisma.onlineConsultantLead.count({
				where: { onlineConsultantId }
			})
		]);

		return {
			leads,
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async exportLeads(
		userId: string,
		onlineConsultantId: string,
		format: 'csv' | 'xlsx'
	) {
		const onlineConsultant = await this.getByIdAndOwner(
			onlineConsultantId,
			userId
		);

		const sub = await this.subscriptionService.checkAndResetPeriod(userId);
		if (sub?.plan === Plan.EASY)
			throw new ForbiddenException(
				'Экспорт заявок недоступен на тарифе Easy'
			);

		const leads = await this.prisma.onlineConsultantLead.findMany({
			where: { onlineConsultantId },
			orderBy: { createdAt: 'asc' }
		});

		const safeName = onlineConsultant.name.replace(/[^\wЀ-ӿ\-]/g, '_');

		if (format === 'csv') {
			return {
				data: this.buildCsv(leads),
				contentType: 'text/csv; charset=utf-8',
				filename: `online_consultant_leads_${safeName}.csv`
			};
		}

		const rows = leads.map((lead: any, i: number) => ({
			'№': i + 1,
			Дата: new Date(lead.createdAt).toLocaleString('ru-RU'),
			Телефон: lead.phone || '',
			Email: lead.email || '',
			'Быстрый вопрос': lead.actionLabel || '',
			Ответ: lead.actionValue || '',
			Страница: lead.url || ''
		}));
		const ws = XLSX.utils.json_to_sheet(rows);
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, 'Заявки');
		const buf = XLSX.write(wb, {
			type: 'buffer',
			bookType: 'xlsx'
		}) as Buffer;

		return {
			data: buf,
			contentType:
				'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			filename: `online_consultant_leads_${safeName}.xlsx`
		};
	}

	async getPublicConfig(
		publicKey: string,
		ip?: string,
		requestDomain: string | null = null,
		directPageAccessAllowed = false
	): Promise<object | null> {
		const onlineConsultant = await this.prisma.onlineConsultant.findUnique(
			{
				where: { publicKey },
				include: { user: { include: { subscription: true } } }
			}
		);

		if (!onlineConsultant) return null;

		const config = normalizeOnlineConsultantConfig(
			onlineConsultant.config
		);
		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(onlineConsultant.installDomain, requestDomain)
		) {
			return { isActive: false };
		}

		const sub = await this.subscriptionService.checkAndResetPeriod(
			onlineConsultant.userId
		);
		const isActive = onlineConsultant.isActive && sub?.status === 'ACTIVE';
		const hasActiveHardSubscription =
			sub?.status === SubscriptionStatus.ACTIVE && sub?.plan === Plan.HARD;
		const dataType = getDataType(config.dataType);

		let canAcceptLeads = isActive;
		if (isActive && sub && dataType !== 'NONE') {
			const limits = PLAN_LIMITS[sub.plan as Plan];
			if (
				!limits.unlimited &&
				sub.leadsThisPeriod >= limits.maxLeadsPerPeriod
			)
				canAcceptLeads = false;
		}

		if (!canAcceptLeads) return { isActive: false };

		let hasSubmittedByIp = false;
		if (ip && config?.filterDuplicates) {
			const existing = await this.prisma.onlineConsultantLead.findFirst({
				where: { onlineConsultantId: onlineConsultant.id, ip }
			});
			hasSubmittedByIp = !!existing;
		}

		return {
			isActive: true,
			color: config.color || DEFAULT_CONFIG.color,
			bgColor: config.bgColor || null,
			buttonColor: config.buttonColor || '',
			openButtonColor: config.openButtonColor || '',
			buttonSide: config.buttonSide || 'right',
			buttonPulse: config.buttonPulse !== false,
			buttonBottom: config.buttonBottom ?? 3,
			buttonOffset: config.buttonOffset ?? 3,
			buttonSize: config.buttonSize ?? DEFAULT_CONFIG.buttonSize,
			buttonImageUrl: this.fileService.getWidgetButtonImageUrl(
				config.buttonImageUrl,
				hasActiveHardSubscription
			),
			hideBranding: hasActiveHardSubscription,
			autoOpenDelay: config.autoOpenDelay || null,
			bubbleEnabled: false,
			bubbleText: '',
			title: config.title || DEFAULT_CONFIG.title,
			subtitle: config.subtitle || '',
			dataType,
			contactTitle: config.contactTitle || DEFAULT_CONFIG.contactTitle,
			submitButtonText:
				config.submitButtonText || DEFAULT_CONFIG.submitButtonText,
			successTitle: config.successTitle || DEFAULT_CONFIG.successTitle,
			successSubtitle: config.successSubtitle || '',
			privacyUrl: config.privacyUrl || null,
			developInfoActive:
				config.developInfoActive !== false && !hasActiveHardSubscription,
			filterDuplicates: config.filterDuplicates === true,
			quickActions: getQuickActions(config.quickActions),
			hasSubmittedByIp,
			yandexMetrikaId: config?.integrations?.yandexMetrikaId || null,
			vkPixelId: config?.integrations?.vkPixelId || null,
			roistatEnabled: config?.integrations?.roistatEnabled === true
		};
	}

	async submitLead(
		dto: SubmitOnlineConsultantLeadDto,
		ip?: string,
		requestDomain: string | null = null,
		directPageAccessAllowed = false
	) {
		const onlineConsultant = await this.prisma.onlineConsultant.findUnique(
			{
				where: { publicKey: dto.key },
				include: {
					user: {
						include: {
							subscription: true,
							authIdentities: { where: { type: 'EMAIL' } }
						}
					}
				}
			}
		);

		if (!onlineConsultant)
			throw new NotFoundException('Онлайн-консультант не найден');

		const config = normalizeOnlineConsultantConfig(
			onlineConsultant.config
		);
		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(onlineConsultant.installDomain, requestDomain)
		) {
			throw new ForbiddenException('Домен установки виджета не совпадает');
		}

		const dataType = getDataType(config.dataType);
		if (dataType === 'NONE') {
			throw new BadRequestException('Сбор контактов отключён');
		}
		this.validateContact(dataType, dto);

		if (!onlineConsultant.isActive) {
			throw new ForbiddenException(
				'Лимит заявок исчерпан или подписка неактивна'
			);
		}

		const { lead } = await this.subscriptionService.createLeadWithinLimit(
			onlineConsultant.userId,
			async transaction => {
				if (config?.filterDuplicates && ip) {
					const orConditions: object[] = [];
					if (dto.phone) orConditions.push({ phone: dto.phone });
					if (dto.email) orConditions.push({ email: dto.email });
					if (ip) orConditions.push({ ip });

					const existing =
						await transaction.onlineConsultantLead.findFirst({
							where: {
								onlineConsultantId: onlineConsultant.id,
								OR: orConditions
							}
						});
					if (existing) {
						throw new BadRequestException(
							'Заявка с таким контактом уже существует'
						);
					}
				}

				const createdLead = await transaction.onlineConsultantLead.create({
					data: {
						onlineConsultantId: onlineConsultant.id,
						phone: dto.phone || null,
						email: dto.email || null,
						actionLabel: dto.actionLabel || '',
						actionValue: dto.actionValue || '',
						url: dto.url,
						ip: ip || null
					}
				});
				await enqueueLeadIntegrationEvents(transaction, {
					source: 'online-consultant',
					entity: {
						id: onlineConsultant.id,
						name: onlineConsultant.name
					},
					lead: {
						id: createdLead.id,
						phone: dto.phone,
						email: dto.email,
						actionLabel: dto.actionLabel,
						actionValue: dto.actionValue,
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
						id: onlineConsultant.id,
						name: onlineConsultant.name,
						type: 'online-consultant'
					},
					limit,
					accountEmail: onlineConsultant.user?.authIdentities?.[0]?.value,
					integrationEmail: config?.integrations?.email,
					telegramChatId: config?.integrations?.telegramChatId
				})
		);

		return { success: true, lead };
	}

	private validateContact(
		dataType: string,
		dto: SubmitOnlineConsultantLeadDto
	) {
		if (dataType === 'PHONE' && !dto.phone) {
			throw new BadRequestException('Введите телефон');
		}
		if (dataType === 'EMAIL' && !dto.email) {
			throw new BadRequestException('Введите email');
		}
		if (dataType === 'PHONE_AND_EMAIL' && (!dto.phone || !dto.email)) {
			throw new BadRequestException('Введите телефон и email');
		}
	}

	private buildCsv(leads: any[]): Buffer {
		const headers = [
			'№',
			'Дата',
			'Телефон',
			'Email',
			'Быстрый вопрос',
			'Ответ',
			'Страница'
		];
		const esc = (v: any) => {
			const s = String(v ?? '');
			return s.includes(',') || s.includes('"') || s.includes('\n')
				? `"${s.replace(/"/g, '""')}"`
				: s;
		};
		const rows = leads.map((l, i) => [
			i + 1,
			new Date(l.createdAt).toLocaleString('ru-RU'),
			l.phone || '',
			l.email || '',
			l.actionLabel || '',
			l.actionValue || '',
			l.url || ''
		]);
		const csv = [headers, ...rows]
			.map(r => r.map(esc).join(','))
			.join('\r\n');
		return Buffer.from('﻿' + csv, 'utf-8');
	}

	private async getByIdAndOwner(
		onlineConsultantId: string,
		userId: string
	) {
		const onlineConsultant = await this.prisma.onlineConsultant.findUnique(
			{
				where: { id: onlineConsultantId }
			}
		);
		if (!onlineConsultant)
			throw new NotFoundException('Онлайн-консультант не найден');
		if (onlineConsultant.userId !== userId)
			throw new ForbiddenException('Нет доступа');
		return onlineConsultant;
	}

	private async assertCanUseButtonImage(userId: string) {
		const sub = await this.subscriptionService.checkAndResetPeriod(userId);

		if (
			!sub ||
			sub.status !== SubscriptionStatus.ACTIVE ||
			sub.plan !== Plan.HARD
		) {
			throw new ForbiddenException(
				'Загрузка своей картинки кнопки доступна только на тарифе Hard'
			);
		}
	}

	private prepareButtonImageConfigPatch(
		currentConfig: Record<string, any>,
		configPatch: Record<string, any>
	) {
		const nextPatch = { ...configPatch };

		if (
			!Object.prototype.hasOwnProperty.call(nextPatch, 'buttonImageUrl')
		) {
			return nextPatch;
		}

		const currentUrl =
			typeof currentConfig.buttonImageUrl === 'string'
				? currentConfig.buttonImageUrl
				: '';
		const nextUrl =
			typeof nextPatch.buttonImageUrl === 'string'
				? nextPatch.buttonImageUrl
				: '';

		if (nextUrl && nextUrl !== currentUrl) {
			throw new BadRequestException(
				'Картинку кнопки нужно загружать через отдельное поле загрузки'
			);
		}

		nextPatch.buttonImageUrl = nextUrl;
		return nextPatch;
	}

	private async deleteButtonImageIfRemoved(
		previousConfig: Record<string, any>,
		nextConfig: Record<string, any>
	) {
		const previousUrl = previousConfig.buttonImageUrl;
		const nextUrl = nextConfig.buttonImageUrl;

		if (previousUrl && previousUrl !== nextUrl) {
			await this.fileService
				.deleteWidgetButtonImage(previousUrl)
				.catch(() => undefined);
		}
	}

	private generatePublicKey(): string {
		return randomBytes(6).toString('hex');
	}
}
