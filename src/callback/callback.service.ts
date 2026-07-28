import { FileService } from '@/file/file.service';
import { enqueueLeadIntegrationEvents } from '@/messaging/lead-integration-event';
import { enqueueEntityLimitReachedEvent } from '@/messaging/limit-reached-event';
import { PrismaService } from '@/prisma.service';
import { SafeOutboundHttpService } from '@/safe-outbound-http/safe-outbound-http.service';
import { PLAN_LIMITS } from '@/subscription/subscription.constants';
import { SubscriptionService } from '@/subscription/subscription.service';
import { CreateCallbackDto } from '@/callback/dto/create-callback.dto';
import { SubmitCallbackLeadDto } from '@/callback/dto/submit-callback-lead.dto';
import { UpdateCallbackDto } from '@/callback/dto/update-callback.dto';
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
import { normalizePhone } from '@/utils/phone.util';
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

const CALLBACK_REPEAT_COOLDOWN_MS = 30 * 60 * 1000;
const CALLBACK_TIME_SLOTS_MAX = 12;
const CALLBACK_TIME_SLOT_MAX_LENGTH = 60;

const DEFAULT_CONFIG = {
	color: '#4705fb',
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
	bubbleEnabled: true,
	bubbleText: 'Перезвоним!',
	title: 'Заказать звонок',
	subtitle: 'Оставьте номер телефона — мы перезвоним в удобное время',
	submitButtonText: 'Заказать звонок',
	successTitle: 'Спасибо! Мы перезвоним',
	successSubtitle: 'Ожидайте звонка в выбранное время',
	privacyUrl:
		'https://winwidget.ru/legal-documentation/consent-processing',
	developInfoActive: true,
	filterDuplicates: false,
	timeSlots: [
		'9:00–11:00',
		'11:00–13:00',
		'13:00–15:00',
		'15:00–17:00',
		'17:00–19:00'
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

const normalizeTimeSlots = (value: unknown): string[] => {
	if (!Array.isArray(value)) return DEFAULT_CONFIG.timeSlots;

	const slots = value
		.filter((slot): slot is string => typeof slot === 'string')
		.map(slot => slot.trim())
		.filter(Boolean);

	return [...new Set(slots)].slice(0, CALLBACK_TIME_SLOTS_MAX);
};

const assertValidTimeSlots = (value: unknown): void => {
	if (!Array.isArray(value)) {
		throw new BadRequestException('Слоты времени должны быть массивом');
	}

	if (value.length < 1 || value.length > CALLBACK_TIME_SLOTS_MAX) {
		throw new BadRequestException(
			`Укажите от 1 до ${CALLBACK_TIME_SLOTS_MAX} слотов времени`
		);
	}

	const normalizedSlots = value.map(slot =>
		typeof slot === 'string' ? slot.trim() : ''
	);
	if (
		normalizedSlots.some(
			slot => !slot || slot.length > CALLBACK_TIME_SLOT_MAX_LENGTH
		)
	) {
		throw new BadRequestException(
			`Каждый слот должен содержать от 1 до ${CALLBACK_TIME_SLOT_MAX_LENGTH} символов`
		);
	}

	if (new Set(normalizedSlots).size !== normalizedSlots.length) {
		throw new BadRequestException('Слоты времени не должны повторяться');
	}
};

const normalizeCallbackConfig = (rawConfig: unknown) => {
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
		timeSlots: normalizeTimeSlots(raw.timeSlots),
		integrations: {
			...DEFAULT_CONFIG.integrations,
			...toPlainObject(raw.integrations)
		}
	};
};

@Injectable()
export class CallbackService {
	constructor(
		private prisma: PrismaService,
		private subscriptionService: SubscriptionService,
		private fileService: FileService,
		private safeOutboundHttpService: SafeOutboundHttpService
	) {}

	async getMyCallbacks(userId: string) {
		const sub = await this.subscriptionService.checkAndResetPeriod(userId);
		const callbacks = await this.prisma.callback.findMany({
			where: { userId },
			orderBy: { createdAt: 'desc' },
			include: { _count: { select: { leads: true } } }
		});
		return {
			callbacks: callbacks.map(callback => projectWidgetDraft(callback)),
			subscription: sub
		};
	}

	async createCallback(userId: string, dto: CreateCallbackDto) {
		return this.subscriptionService.createWidgetWithinLimit(
			userId,
			transaction =>
				transaction.callback.create({
					data: {
						userId,
						publicKey: this.generatePublicKey(),
						name: dto.name || 'Обратный звонок',
						config: DEFAULT_CONFIG,
						draftConfig: DEFAULT_CONFIG,
						draftInstallDomain: '',
						draftRevision: 1
					}
				})
		);
	}

	async updateCallback(
		userId: string,
		callbackId: string,
		dto: UpdateCallbackDto
	) {
		const callback = await this.getByIdAndOwner(callbackId, userId);
		const currentConfig = getWidgetDraftConfig(callback) as Record<
			string,
			any
		>;
		const hasDraftChanges =
			dto.config !== undefined || dto.installDomain !== undefined;
		if (hasDraftChanges) {
			assertExpectedDraftRevision(callback, dto.expectedDraftRevision);
		}
		const configPatch =
			dto.config !== undefined
				? this.prepareButtonImageConfigPatch(currentConfig, dto.config)
				: undefined;
		if (
			configPatch &&
			Object.prototype.hasOwnProperty.call(configPatch, 'timeSlots')
		) {
			assertValidTimeSlots(configPatch.timeSlots);
		}
		const nextConfig =
			configPatch !== undefined
				? normalizeCallbackConfig({
						...currentConfig,
						...configPatch,
						integrations: {
							...(currentConfig.integrations || {}),
							...(configPatch.integrations || {})
						}
					})
				: undefined;

		if (dto.config !== undefined && nextConfig) {
			await this.safeOutboundHttpService.validateIntegrationConfig(
				nextConfig.integrations
			);
		}

		const data: Prisma.CallbackUpdateManyMutationInput = {
			...(dto.name !== undefined && { name: dto.name }),
			...(dto.isActive !== undefined && { isActive: dto.isActive }),
			...(dto.installDomain !== undefined && {
				draftInstallDomain: normalizeInstallDomain(dto.installDomain)
			}),
			...(nextConfig !== undefined && { draftConfig: nextConfig }),
			...(hasDraftChanges && { draftRevision: { increment: 1 } })
		};
		if (hasDraftChanges) {
			const result = await this.prisma.callback.updateMany({
				where: {
					id: callback.id,
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
			await this.prisma.callback.update({
				where: { id: callback.id },
				data
			});
		}

		const updated = await this.prisma.callback.findUniqueOrThrow({
			where: { id: callback.id }
		});
		if (nextConfig !== undefined) {
			await cleanupUnreferencedWidgetButtonImage(
				this.prisma,
				this.fileService,
				WidgetType.CALLBACK,
				callback.id,
				currentConfig.buttonImageUrl
			);
		}
		return projectWidgetDraft(updated);
	}

	async deleteCallback(userId: string, callbackId: string) {
		const callback = await this.getByIdAndOwner(callbackId, userId);
		const { deleted, imageUrls } = await this.prisma.$transaction(
			async transaction => {
				const deleted = await transaction.callback.delete({
					where: { id: callback.id }
				});
				const revisions = await transaction.widgetConfigRevision.findMany({
					where: {
						widgetType: WidgetType.CALLBACK,
						widgetId: callback.id
					},
					select: { config: true }
				});
				await transaction.widgetConfigRevision.deleteMany({
					where: {
						widgetType: WidgetType.CALLBACK,
						widgetId: callback.id
					}
				});
				await transaction.widgetRuntimeDailyMetric.deleteMany({
					where: {
						widgetType: WidgetType.CALLBACK,
						widgetId: callback.id
					}
				});
				await transaction.widgetRuntimePresence.deleteMany({
					where: {
						widgetType: WidgetType.CALLBACK,
						widgetId: callback.id
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
		callbackId: string,
		file: Express.Multer.File | undefined,
		expectedDraftRevision: number
	) {
		const callback = await this.getByIdAndOwner(callbackId, userId);
		assertExpectedDraftRevision(callback, expectedDraftRevision);
		await this.assertCanUseButtonImage(userId);

		const currentConfig = getWidgetDraftConfig(callback) as Record<
			string,
			any
		>;
		let uploadedUrl = '';
		let draftUpdated = false;

		try {
			const uploadedFile = await this.fileService.saveWidgetButtonImage(
				file,
				'callback',
				callback.id
			);
			uploadedUrl = uploadedFile.url;

			const updated = await this.prisma.$transaction(async transaction => {
				const result = await transaction.callback.updateMany({
					where: {
						id: callback.id,
						userId,
						draftRevision: expectedDraftRevision
					},
					data: {
						draftConfig: normalizeCallbackConfig({
							...currentConfig,
							buttonImageUrl: uploadedUrl
						}),
						draftRevision: { increment: 1 }
					}
				});
				if (result.count !== 1) {
					throw new ConflictException(
						'Настройки уже изменены в другой сессии. Обновите страницу'
					);
				}
				return transaction.callback.findUniqueOrThrow({
					where: { id: callback.id }
				});
			});
			draftUpdated = true;

			await cleanupUnreferencedWidgetButtonImage(
				this.prisma,
				this.fileService,
				WidgetType.CALLBACK,
				callback.id,
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
		callbackId: string,
		page = 1,
		limit = 50
	) {
		await this.getByIdAndOwner(callbackId, userId);

		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? limit : 50;
		const skip = (normalizedPage - 1) * normalizedLimit;
		const [leads, total] = await Promise.all([
			this.prisma.callbackLead.findMany({
				where: { callbackId },
				orderBy: { createdAt: 'desc' },
				skip,
				take: normalizedLimit
			}),
			this.prisma.callbackLead.count({ where: { callbackId } })
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
		callbackId: string,
		format: 'csv' | 'xlsx'
	) {
		const callback = await this.getByIdAndOwner(callbackId, userId);

		const sub = await this.subscriptionService.checkAndResetPeriod(userId);
		if (sub?.plan === Plan.EASY)
			throw new ForbiddenException(
				'Экспорт заявок недоступен на тарифе Easy'
			);

		const leads = await this.prisma.callbackLead.findMany({
			where: { callbackId },
			orderBy: { createdAt: 'asc' }
		});

		const safeName = callback.name.replace(/[^\wЀ-ӿ\-]/g, '_');

		if (format === 'csv') {
			return {
				data: this.buildCsv(leads),
				contentType: 'text/csv; charset=utf-8',
				filename: `callback_leads_${safeName}.csv`
			};
		}

		const rows = leads.map((lead: any, i: number) => ({
			'№': i + 1,
			Дата: new Date(lead.createdAt).toLocaleString('ru-RU'),
			Телефон: lead.phone,
			Время: lead.timeSlot || '',
			'Часовой пояс': lead.timezone || '',
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
			filename: `callback_leads_${safeName}.xlsx`
		};
	}

	async getPublicConfig(
		publicKey: string,
		ip?: string,
		requestDomain: string | null = null,
		directPageAccessAllowed = false
	): Promise<object | null> {
		const callback = await this.prisma.callback.findUnique({
			where: { publicKey },
			include: { user: { include: { subscription: true } } }
		});

		if (!callback) return null;
		if (!callback.publishedAt || callback.publishedVersion === 0) {
			return { isActive: false };
		}

		const config = normalizeCallbackConfig(callback.config);
		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(callback.installDomain, requestDomain)
		) {
			return { isActive: false };
		}

		const sub = await this.subscriptionService.checkAndResetPeriod(
			callback.userId
		);
		const isActive = callback.isActive && sub?.status === 'ACTIVE';
		const hasActiveHardSubscription =
			sub?.status === SubscriptionStatus.ACTIVE && sub?.plan === Plan.HARD;

		let canAcceptLeads = isActive;
		if (isActive && sub) {
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
			const existing = await this.prisma.callbackLead.findFirst({
				where: { callbackId: callback.id, ip }
			});
			hasSubmittedByIp = !!existing;
		}

		return {
			isActive: true,
			publishedVersion: callback.publishedVersion,
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
				hasActiveHardSubscription
			),
			hideBranding: hasActiveHardSubscription,
			autoOpenDelay: config.autoOpenDelay || null,
			bubbleEnabled: config.bubbleEnabled !== false,
			bubbleText: config.bubbleText || config.title || 'Перезвоним!',
			title: config.title || 'Заказать звонок',
			subtitle: config.subtitle || '',
			submitButtonText: config.submitButtonText || 'Заказать звонок',
			successTitle: config.successTitle || 'Спасибо! Мы перезвоним',
			successSubtitle: config.successSubtitle || '',
			privacyUrl: config.privacyUrl || null,
			developInfoActive:
				config.developInfoActive !== false && !hasActiveHardSubscription,
			filterDuplicates: config.filterDuplicates === true,
			timeSlots: config.timeSlots || [],
			hasSubmittedByIp,
			yandexMetrikaId: config?.integrations?.yandexMetrikaId || null,
			vkPixelId: config?.integrations?.vkPixelId || null,
			roistatEnabled: config?.integrations?.roistatEnabled === true
		};
	}

	async submitLead(
		dto: SubmitCallbackLeadDto,
		ip?: string,
		requestDomain: string | null = null,
		directPageAccessAllowed = false
	) {
		const callback = await this.prisma.callback.findUnique({
			where: { publicKey: dto.key },
			include: {
				user: {
					include: {
						subscription: true,
						authIdentities: { where: { type: 'EMAIL' } }
					}
				}
			}
		});

		if (!callback) throw new NotFoundException('Виджет не найден');
		if (!callback.publishedAt || callback.publishedVersion === 0) {
			throw new ForbiddenException('Виджет ещё не опубликован');
		}
		if (!callback.isActive) {
			throw new ForbiddenException(
				'Лимит заявок исчерпан или подписка неактивна'
			);
		}

		const config = normalizeCallbackConfig(callback.config);
		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(callback.installDomain, requestDomain)
		) {
			throw new ForbiddenException('Домен установки виджета не совпадает');
		}

		const normalizedPhone = normalizePhone(dto.phone);
		if (!/^[+][1-9][0-9]{7,14}$/.test(normalizedPhone)) {
			throw new BadRequestException('Укажите корректный телефон');
		}

		const { lead } = await this.subscriptionService.createLeadWithinLimit(
			callback.userId,
			async transaction => {
				const recentLead = await transaction.callbackLead.findFirst({
					where: {
						callbackId: callback.id,
						phone: normalizedPhone,
						createdAt: {
							gte: new Date(Date.now() - CALLBACK_REPEAT_COOLDOWN_MS)
						}
					}
				});
				if (recentLead) {
					throw new BadRequestException(
						'Заявка уже отправлена, мы скоро вам перезвоним'
					);
				}

				if (config?.filterDuplicates && ip) {
					const existing = await transaction.callbackLead.findFirst({
						where: { callbackId: callback.id, ip }
					});
					if (existing) {
						throw new BadRequestException(
							'Заявка с этого устройства уже существует'
						);
					}
				}

				const createdLead = await transaction.callbackLead.create({
					data: {
						callbackId: callback.id,
						phone: normalizedPhone,
						timeSlot: dto.timeSlot || '',
						timezone: dto.timezone || '',
						url: dto.url,
						ip: ip || null
					}
				});
				await enqueueLeadIntegrationEvents(transaction, {
					source: 'callback',
					entity: { id: callback.id, name: callback.name },
					lead: {
						id: createdLead.id,
						phone: dto.phone,
						timeSlot: dto.timeSlot,
						timezone: dto.timezone,
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
						id: callback.id,
						name: callback.name,
						type: 'callback'
					},
					limit,
					accountEmail: callback.user?.authIdentities?.[0]?.value,
					integrationEmail: config?.integrations?.email,
					telegramChatId: config?.integrations?.telegramChatId
				})
		);

		return { success: true, lead };
	}

	private buildCsv(leads: any[]): Buffer {
		const headers = [
			'№',
			'Дата',
			'Телефон',
			'Время звонка',
			'Часовой пояс',
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
			l.phone,
			l.timeSlot || '',
			l.timezone || '',
			l.url || ''
		]);
		const csv = [headers, ...rows]
			.map(r => r.map(esc).join(','))
			.join('\r\n');
		return Buffer.from('﻿' + csv, 'utf-8');
	}

	private async getByIdAndOwner(callbackId: string, userId: string) {
		const callback = await this.prisma.callback.findUnique({
			where: { id: callbackId }
		});
		if (!callback) throw new NotFoundException('Виджет не найден');
		if (callback.userId !== userId)
			throw new ForbiddenException('Нет доступа');
		return callback;
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

	private collectButtonImageUrls(configs: unknown[]) {
		return Array.from(
			new Set(
				configs
					.map(config =>
						config && typeof config === 'object' && !Array.isArray(config)
							? (config as Record<string, unknown>).buttonImageUrl
							: null
					)
					.filter(
						(value): value is string =>
							typeof value === 'string' && value.trim().length > 0
					)
			)
		);
	}

	private generatePublicKey(): string {
		return randomBytes(6).toString('hex');
	}
}
