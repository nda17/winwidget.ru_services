import { CreateCountdownTimerDto } from '@/countdown-timer/dto/create-countdown-timer.dto';
import { SubmitCountdownTimerLeadDto } from '@/countdown-timer/dto/submit-countdown-timer-lead.dto';
import { UpdateCountdownTimerDto } from '@/countdown-timer/dto/update-countdown-timer.dto';
import { FileService } from '@/file/file.service';
import { enqueueLeadIntegrationEvents } from '@/messaging/lead-integration-event';
import { enqueueEntityLimitReachedEvent } from '@/messaging/limit-reached-event';
import { PrismaService } from '@/prisma.service';
import { SafeOutboundHttpService } from '@/safe-outbound-http/safe-outbound-http.service';
import { PLAN_LIMITS } from '@/subscription/subscription.constants';
import { SubscriptionService } from '@/subscription/subscription.service';
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

const DEFAULT_PRIVACY_URL =
	'https://winwidget.ru/legal-documentation/consent-processing';

const createDefaultConfig = () => ({
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
	bubbleText: 'Акция',
	title: 'Скидка ограничена по времени',
	subtitle: 'Успейте воспользоваться предложением до окончания таймера',
	timerMode: 'EVERGREEN',
	deadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
	evergreenDurationMinutes: 15,
	expiredBehavior: 'showExpired',
	expiredTitle: 'Акция завершена',
	expiredSubtitle: 'Предложение больше недоступно',
	dataType: 'NONE',
	contactTitle: 'Оставьте контакт, чтобы получить предложение',
	submitButtonText: 'Получить предложение',
	successTitle: 'Спасибо! Заявка отправлена',
	successSubtitle: 'Мы скоро свяжемся с вами',
	actionButtonText: 'Перейти к акции',
	actionButtonUrl: '',
	privacyUrl: DEFAULT_PRIVACY_URL,
	developInfoActive: true,
	filterDuplicates: false,
	submissionCooldownDays: 0,
	timerResetToken: '',
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
});

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

const normalizeCountdownTimerConfig = (rawConfig: unknown) => {
	const defaults = createDefaultConfig();
	const raw = toPlainObject(rawConfig);

	return {
		...defaults,
		...raw,
		buttonBottom: clampNumber(
			raw.buttonBottom,
			1,
			50,
			defaults.buttonBottom
		),
		buttonOffset: clampNumber(
			raw.buttonOffset,
			1,
			50,
			defaults.buttonOffset
		),
		buttonSize: clampNumber(raw.buttonSize, 40, 100, defaults.buttonSize),
		autoOpenDelay: toOptionalDelay(raw.autoOpenDelay),
		evergreenDurationMinutes: clampNumber(
			raw.evergreenDurationMinutes,
			1,
			10080,
			defaults.evergreenDurationMinutes
		),
		submissionCooldownDays: clampNumber(
			raw.submissionCooldownDays,
			0,
			365,
			defaults.submissionCooldownDays
		),
		integrations: {
			...defaults.integrations,
			...toPlainObject(raw.integrations)
		}
	};
};

@Injectable()
export class CountdownTimerService {
	constructor(
		private prisma: PrismaService,
		private subscriptionService: SubscriptionService,
		private fileService: FileService,
		private safeOutboundHttpService: SafeOutboundHttpService
	) {}

	async getMyCountdownTimers(userId: string) {
		const sub = await this.subscriptionService.checkAndResetPeriod(userId);
		const countdownTimers = await this.prisma.countdownTimer.findMany({
			where: { userId },
			orderBy: { createdAt: 'desc' },
			include: { _count: { select: { leads: true } } }
		});
		return {
			countdownTimers: countdownTimers.map(timer =>
				projectWidgetDraft(timer)
			),
			subscription: sub
		};
	}

	async createCountdownTimer(
		userId: string,
		dto: CreateCountdownTimerDto
	) {
		const config = createDefaultConfig();
		return this.subscriptionService.createWidgetWithinLimit(
			userId,
			transaction =>
				transaction.countdownTimer.create({
					data: {
						userId,
						publicKey: this.generatePublicKey(),
						name: dto.name || 'Таймер',
						config,
						draftConfig: config,
						draftInstallDomain: '',
						draftRevision: 1
					}
				})
		);
	}

	async updateCountdownTimer(
		userId: string,
		countdownTimerId: string,
		dto: UpdateCountdownTimerDto
	) {
		const timer = await this.getByIdAndOwner(countdownTimerId, userId);
		const currentConfig = getWidgetDraftConfig(timer) as Record<
			string,
			any
		>;
		const hasDraftChanges =
			dto.config !== undefined || dto.installDomain !== undefined;
		if (hasDraftChanges) {
			assertExpectedDraftRevision(timer, dto.expectedDraftRevision);
		}
		const configPatch =
			dto.config !== undefined
				? this.prepareButtonImageConfigPatch(currentConfig, dto.config)
				: undefined;
		const nextConfig =
			configPatch !== undefined
				? normalizeCountdownTimerConfig({
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

		const data: Prisma.CountdownTimerUpdateManyMutationInput = {
			...(dto.name !== undefined && { name: dto.name }),
			...(dto.isActive !== undefined && { isActive: dto.isActive }),
			...(dto.installDomain !== undefined && {
				draftInstallDomain: normalizeInstallDomain(dto.installDomain)
			}),
			...(nextConfig !== undefined && { draftConfig: nextConfig }),
			...(hasDraftChanges && { draftRevision: { increment: 1 } })
		};
		if (hasDraftChanges) {
			const result = await this.prisma.countdownTimer.updateMany({
				where: {
					id: timer.id,
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
			await this.prisma.countdownTimer.update({
				where: { id: timer.id },
				data
			});
		}

		const updated = await this.prisma.countdownTimer.findUniqueOrThrow({
			where: { id: timer.id }
		});
		if (nextConfig !== undefined) {
			await cleanupUnreferencedWidgetButtonImage(
				this.prisma,
				this.fileService,
				WidgetType.TIMER,
				timer.id,
				currentConfig.buttonImageUrl
			);
		}
		return projectWidgetDraft(updated);
	}

	async deleteCountdownTimer(userId: string, countdownTimerId: string) {
		const timer = await this.getByIdAndOwner(countdownTimerId, userId);
		const { deleted, imageUrls } = await this.prisma.$transaction(
			async transaction => {
				const deleted = await transaction.countdownTimer.delete({
					where: { id: timer.id }
				});
				const revisions = await transaction.widgetConfigRevision.findMany({
					where: {
						widgetType: WidgetType.TIMER,
						widgetId: timer.id
					},
					select: { config: true }
				});
				await transaction.widgetConfigRevision.deleteMany({
					where: { widgetType: WidgetType.TIMER, widgetId: timer.id }
				});
				await transaction.widgetRuntimeDailyMetric.deleteMany({
					where: { widgetType: WidgetType.TIMER, widgetId: timer.id }
				});
				await transaction.widgetRuntimePresence.deleteMany({
					where: { widgetType: WidgetType.TIMER, widgetId: timer.id }
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
		countdownTimerId: string,
		file: Express.Multer.File | undefined,
		expectedDraftRevision: number
	) {
		const timer = await this.getByIdAndOwner(countdownTimerId, userId);
		assertExpectedDraftRevision(timer, expectedDraftRevision);
		await this.assertCanUseButtonImage(userId);

		const currentConfig = getWidgetDraftConfig(timer) as Record<
			string,
			any
		>;
		let uploadedUrl = '';
		let draftUpdated = false;

		try {
			const uploadedFile = await this.fileService.saveWidgetButtonImage(
				file,
				'timer',
				timer.id
			);
			uploadedUrl = uploadedFile.url;

			const result = await this.prisma.countdownTimer.updateMany({
				where: {
					id: timer.id,
					userId,
					draftRevision: expectedDraftRevision
				},
				data: {
					draftConfig: normalizeCountdownTimerConfig({
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
			draftUpdated = true;

			const updated = await this.prisma.countdownTimer.findUniqueOrThrow({
				where: { id: timer.id }
			});
			await cleanupUnreferencedWidgetButtonImage(
				this.prisma,
				this.fileService,
				WidgetType.TIMER,
				timer.id,
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
		countdownTimerId: string,
		page = 1,
		limit = 50
	) {
		await this.getByIdAndOwner(countdownTimerId, userId);
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? limit : 50;
		const skip = (normalizedPage - 1) * normalizedLimit;
		const [leads, total] = await Promise.all([
			this.prisma.countdownTimerLead.findMany({
				where: { countdownTimerId },
				orderBy: { createdAt: 'desc' },
				skip,
				take: normalizedLimit
			}),
			this.prisma.countdownTimerLead.count({
				where: { countdownTimerId }
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
		countdownTimerId: string,
		format: 'csv' | 'xlsx'
	) {
		const timer = await this.getByIdAndOwner(countdownTimerId, userId);
		const sub = await this.subscriptionService.checkAndResetPeriod(userId);
		if (sub?.plan === Plan.EASY) {
			throw new ForbiddenException(
				'Экспорт заявок недоступен на тарифе Easy'
			);
		}

		const leads = await this.prisma.countdownTimerLead.findMany({
			where: { countdownTimerId },
			orderBy: { createdAt: 'asc' }
		});
		const safeName = timer.name.replace(/[^\w\u0400-\u04FF\-]/g, '_');

		if (format === 'csv') {
			return {
				data: this.buildCsv(leads),
				contentType: 'text/csv; charset=utf-8',
				filename: `timer_leads_${safeName}.csv`
			};
		}

		const rows = leads.map((lead: any, i: number) => ({
			'№': i + 1,
			Дата: new Date(lead.createdAt).toLocaleString('ru-RU'),
			Телефон: lead.phone || '',
			Email: lead.email || '',
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
			filename: `timer_leads_${safeName}.xlsx`
		};
	}

	async getPublicConfig(
		publicKey: string,
		ip?: string,
		requestDomain: string | null = null,
		directPageAccessAllowed = false
	) {
		const timer = await this.prisma.countdownTimer.findUnique({
			where: { publicKey },
			include: { user: { include: { subscription: true } } }
		});
		if (!timer) return null;
		if (!timer.publishedAt || timer.publishedVersion === 0) {
			return { isActive: false };
		}

		const config = normalizeCountdownTimerConfig(timer.config);
		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(timer.installDomain, requestDomain)
		) {
			return { isActive: false };
		}

		const sub = await this.subscriptionService.checkAndResetPeriod(
			timer.userId
		);
		const dataType = (config.dataType || 'NONE').toUpperCase();
		const isActive = timer.isActive && sub?.status === 'ACTIVE';
		const hasActiveHardSubscription =
			sub?.status === SubscriptionStatus.ACTIVE && sub?.plan === Plan.HARD;

		let canShowWidget = isActive;
		if (isActive && sub && dataType !== 'NONE') {
			const limits = PLAN_LIMITS[sub.plan as Plan];
			if (
				!limits.unlimited &&
				sub.leadsThisPeriod >= limits.maxLeadsPerPeriod
			) {
				canShowWidget = false;
			}
		}
		if (!canShowWidget) return { isActive: false };

		let hasSubmittedByIp = false;
		if (ip && config?.filterDuplicates && dataType !== 'NONE') {
			const submissionCooldownDays = config.submissionCooldownDays ?? 0;
			const timerResetToken = config.timerResetToken || '';
			const since =
				submissionCooldownDays > 0
					? new Date(
							Date.now() - submissionCooldownDays * 24 * 60 * 60 * 1000
						)
					: null;
			const existing = await this.prisma.countdownTimerLead.findFirst({
				where: {
					countdownTimerId: timer.id,
					ip,
					timerResetToken,
					...(since ? { createdAt: { gte: since } } : {})
				}
			});
			hasSubmittedByIp = !!existing;
		}

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
				hasActiveHardSubscription
			),
			hideBranding: hasActiveHardSubscription,
			autoOpenDelay: config.autoOpenDelay || null,
			bubbleText: config.bubbleText || 'Акция',
			title: config.title || 'Скидка ограничена по времени',
			subtitle: config.subtitle || '',
			timerMode: config.timerMode || 'EVERGREEN',
			deadlineAt: config.deadlineAt || null,
			evergreenDurationMinutes: config.evergreenDurationMinutes ?? 15,
			expiredBehavior: config.expiredBehavior || 'showExpired',
			expiredTitle: config.expiredTitle || 'Акция завершена',
			expiredSubtitle: config.expiredSubtitle || '',
			dataType,
			contactTitle:
				config.contactTitle ||
				'Оставьте контакт, чтобы получить предложение',
			submitButtonText: config.submitButtonText || 'Получить предложение',
			successTitle: config.successTitle || 'Спасибо! Заявка отправлена',
			successSubtitle: config.successSubtitle || '',
			actionButtonText: config.actionButtonText || 'Перейти к акции',
			actionButtonUrl: config.actionButtonUrl || '',
			privacyUrl: config.privacyUrl || null,
			developInfoActive:
				config.developInfoActive !== false && !hasActiveHardSubscription,
			filterDuplicates: config.filterDuplicates === true,
			submissionCooldownDays: config.submissionCooldownDays ?? 0,
			timerResetToken: config.timerResetToken || '',
			hasSubmittedByIp,
			yandexMetrikaId: config?.integrations?.yandexMetrikaId || null,
			vkPixelId: config?.integrations?.vkPixelId || null,
			roistatEnabled: config?.integrations?.roistatEnabled === true
		};
	}

	async submitLead(
		dto: SubmitCountdownTimerLeadDto,
		ip?: string,
		requestDomain: string | null = null,
		directPageAccessAllowed = false
	) {
		const timer = await this.prisma.countdownTimer.findUnique({
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
		if (!timer) throw new NotFoundException('Таймер не найден');
		if (!timer.publishedAt || timer.publishedVersion === 0) {
			throw new ForbiddenException('Виджет ещё не опубликован');
		}
		if (!timer.isActive) {
			throw new ForbiddenException(
				'Лимит заявок исчерпан или подписка неактивна'
			);
		}

		const config = normalizeCountdownTimerConfig(timer.config);
		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(timer.installDomain, requestDomain)
		) {
			throw new ForbiddenException('Домен установки виджета не совпадает');
		}

		const dataType = (config.dataType || 'NONE').toUpperCase();
		if (dataType === 'NONE') {
			throw new BadRequestException('Сбор контактов отключён');
		}
		this.validateContact(dataType, dto);

		const { lead } = await this.subscriptionService.createLeadWithinLimit(
			timer.userId,
			async transaction => {
				if (config?.filterDuplicates) {
					const submissionCooldownDays =
						config.submissionCooldownDays ?? 0;
					const timerResetToken = config.timerResetToken || '';
					const since =
						submissionCooldownDays > 0
							? new Date(
									Date.now() - submissionCooldownDays * 24 * 60 * 60 * 1000
								)
							: null;
					const orConditions: object[] = [];
					if (dto.phone) orConditions.push({ phone: dto.phone });
					if (dto.email) orConditions.push({ email: dto.email });
					if (ip) orConditions.push({ ip });

					if (orConditions.length) {
						const existing =
							await transaction.countdownTimerLead.findFirst({
								where: {
									countdownTimerId: timer.id,
									timerResetToken,
									...(since ? { createdAt: { gte: since } } : {}),
									OR: orConditions
								}
							});
						if (existing) {
							throw new BadRequestException(
								'Заявка с таким контактом уже существует'
							);
						}
					}
				}

				const createdLead = await transaction.countdownTimerLead.create({
					data: {
						countdownTimerId: timer.id,
						phone: dto.phone || null,
						email: dto.email || null,
						url: dto.url,
						ip: ip || null,
						timerResetToken: config.timerResetToken || ''
					}
				});
				await enqueueLeadIntegrationEvents(transaction, {
					source: 'countdown-timer',
					entity: { id: timer.id, name: timer.name },
					lead: {
						id: createdLead.id,
						phone: dto.phone,
						email: dto.email,
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
						id: timer.id,
						name: timer.name,
						type: 'countdown-timer'
					},
					limit,
					accountEmail: timer.user?.authIdentities?.[0]?.value,
					integrationEmail: config?.integrations?.email,
					telegramChatId: config?.integrations?.telegramChatId
				})
		);

		return { success: true, lead };
	}

	private validateContact(
		dataType: string,
		dto: SubmitCountdownTimerLeadDto
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
		const headers = ['№', 'Дата', 'Телефон', 'Email', 'Страница'];
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
			l.url || ''
		]);
		const csv = [headers, ...rows]
			.map(r => r.map(esc).join(','))
			.join('\r\n');
		return Buffer.from('\uFEFF' + csv, 'utf-8');
	}

	private async getByIdAndOwner(countdownTimerId: string, userId: string) {
		const timer = await this.prisma.countdownTimer.findUnique({
			where: { id: countdownTimerId }
		});
		if (!timer) throw new NotFoundException('Таймер не найден');
		if (timer.userId !== userId)
			throw new ForbiddenException('Нет доступа');
		return timer;
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
