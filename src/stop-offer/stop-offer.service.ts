import { EmailService } from '@/email/email.service';
import { enqueueLeadIntegrationEvents } from '@/messaging/lead-integration-event';
import { PrismaService } from '@/prisma.service';
import { SafeOutboundHttpService } from '@/safe-outbound-http/safe-outbound-http.service';
import { CreateStopOfferDto } from '@/stop-offer/dto/create-stop-offer.dto';
import { SubmitStopOfferLeadDto } from '@/stop-offer/dto/submit-stop-offer-lead.dto';
import { UpdateStopOfferDto } from '@/stop-offer/dto/update-stop-offer.dto';
import { PLAN_LIMITS } from '@/subscription/subscription.constants';
import { SubscriptionService } from '@/subscription/subscription.service';
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

const DEFAULT_PRIVACY_URL =
	'https://winwidget.ru/legal-documentation/consent-processing';

const STOP_OFFER_DATA_TYPES = new Set([
	'PHONE',
	'EMAIL',
	'PHONE_AND_EMAIL',
	'NONE'
]);

const toPlainObject = (value: unknown): Record<string, any> =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, any>)
		: {};

const toStringValue = (value: unknown, fallback = ''): string =>
	typeof value === 'string' ? value : fallback;

const toBooleanValue = (value: unknown, fallback: boolean): boolean =>
	typeof value === 'boolean' ? value : fallback;

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

const createDefaultConfig = () => ({
	color: '#4705fb',
	bgColor: '',
	buttonColor: '',
	autoOpenDelay: null,
	desktopExitIntent: true,
	mobileAutoOpenDelay: 8,
	scrollPercent: 70,
	showOnce: true,
	displayCooldownDays: 7,
	displayResetToken: '',
	hideIfSubmitted: true,
	badgeText: 'Подождите',
	title: 'Персональное предложение',
	subtitle: 'Оставьте контакт или перейдите к предложению прямо сейчас',
	offerText: 'Скидка 10%',
	dataType: 'PHONE',
	contactTitle: 'Куда отправить скидку?',
	submitButtonText: 'Забрать скидку',
	successTitle: 'Спасибо! Скидка закреплена',
	successSubtitle: 'Мы скоро свяжемся с вами',
	actionButtonEnabled: false,
	actionButtonText: 'Перейти к акции',
	actionButtonUrl: '',
	privacyUrl: DEFAULT_PRIVACY_URL,
	developInfoActive: true,
	filterDuplicates: true,
	submissionCooldownDays: 0,
	submissionResetToken: '',
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

const normalizeStopOfferConfig = (rawConfig: unknown) => {
	const defaults = createDefaultConfig();
	const raw = toPlainObject(rawConfig);
	const integrations = toPlainObject(raw.integrations);
	const dataType = toStringValue(
		raw.dataType,
		defaults.dataType
	).toUpperCase();

	return {
		color: toStringValue(raw.color, defaults.color),
		bgColor: toStringValue(raw.bgColor, defaults.bgColor),
		buttonColor: toStringValue(raw.buttonColor, defaults.buttonColor),
		autoOpenDelay: toOptionalDelay(raw.autoOpenDelay),
		desktopExitIntent: toBooleanValue(
			raw.desktopExitIntent,
			defaults.desktopExitIntent
		),
		mobileAutoOpenDelay: clampNumber(
			raw.mobileAutoOpenDelay,
			1,
			86400,
			defaults.mobileAutoOpenDelay
		),
		scrollPercent: clampNumber(
			raw.scrollPercent,
			1,
			100,
			defaults.scrollPercent
		),
		showOnce: toBooleanValue(raw.showOnce, defaults.showOnce),
		displayCooldownDays: clampNumber(
			raw.displayCooldownDays,
			0,
			365,
			defaults.displayCooldownDays
		),
		displayResetToken: toStringValue(
			raw.displayResetToken,
			defaults.displayResetToken
		),
		hideIfSubmitted: toBooleanValue(
			raw.hideIfSubmitted,
			defaults.hideIfSubmitted
		),
		badgeText: toStringValue(raw.badgeText, defaults.badgeText),
		title: toStringValue(raw.title, defaults.title),
		subtitle: toStringValue(raw.subtitle, defaults.subtitle),
		offerText: toStringValue(raw.offerText, defaults.offerText),
		dataType: STOP_OFFER_DATA_TYPES.has(dataType)
			? dataType
			: defaults.dataType,
		contactTitle: toStringValue(raw.contactTitle, defaults.contactTitle),
		submitButtonText: toStringValue(
			raw.submitButtonText,
			defaults.submitButtonText
		),
		successTitle: toStringValue(raw.successTitle, defaults.successTitle),
		successSubtitle: toStringValue(
			raw.successSubtitle,
			defaults.successSubtitle
		),
		actionButtonEnabled: toBooleanValue(
			raw.actionButtonEnabled,
			defaults.actionButtonEnabled
		),
		actionButtonText: toStringValue(
			raw.actionButtonText,
			defaults.actionButtonText
		),
		actionButtonUrl: toStringValue(
			raw.actionButtonUrl,
			defaults.actionButtonUrl
		),
		privacyUrl: toStringValue(raw.privacyUrl, defaults.privacyUrl),
		developInfoActive: toBooleanValue(
			raw.developInfoActive,
			defaults.developInfoActive
		),
		filterDuplicates: toBooleanValue(
			raw.filterDuplicates,
			defaults.filterDuplicates
		),
		submissionCooldownDays: clampNumber(
			raw.submissionCooldownDays,
			0,
			365,
			defaults.submissionCooldownDays
		),
		submissionResetToken: toStringValue(
			raw.submissionResetToken,
			defaults.submissionResetToken
		),
		integrations: {
			email: toStringValue(integrations.email),
			webhookUrl: toStringValue(integrations.webhookUrl),
			telegramChatId: toStringValue(integrations.telegramChatId),
			yandexMetrikaId: toStringValue(integrations.yandexMetrikaId),
			vkPixelId: toStringValue(integrations.vkPixelId),
			bitrix24WebhookUrl: toStringValue(integrations.bitrix24WebhookUrl),
			roistatEnabled: toBooleanValue(integrations.roistatEnabled, false),
			amoCrmDomain: toStringValue(integrations.amoCrmDomain),
			amoCrmToken: toStringValue(integrations.amoCrmToken)
		}
	};
};

@Injectable()
export class StopOfferService {
	constructor(
		private prisma: PrismaService,
		private subscriptionService: SubscriptionService,
		private emailService: EmailService,
		private safeOutboundHttpService: SafeOutboundHttpService
	) {}

	async getMyStopOffers(userId: string) {
		const sub = await this.subscriptionService.checkAndResetPeriod(userId);
		const stopOffers = await this.prisma.stopOffer.findMany({
			where: { userId },
			orderBy: { createdAt: 'desc' },
			include: { _count: { select: { leads: true } } }
		});

		return { stopOffers, subscription: sub };
	}

	async createStopOffer(userId: string, dto: CreateStopOfferDto) {
		return this.subscriptionService.createWidgetWithinLimit(
			userId,
			transaction =>
				transaction.stopOffer.create({
					data: {
						userId,
						publicKey: this.generatePublicKey(),
						name: dto.name || 'Стоп-оффер',
						config: createDefaultConfig()
					}
				})
		);
	}

	async updateStopOffer(
		userId: string,
		stopOfferId: string,
		dto: UpdateStopOfferDto
	) {
		const stopOffer = await this.getByIdAndOwner(stopOfferId, userId);
		const currentConfig = stopOffer.config as Record<string, any>;
		const nextConfig =
			dto.config !== undefined
				? normalizeStopOfferConfig({
						...currentConfig,
						...dto.config,
						integrations: {
							...(currentConfig.integrations || {}),
							...(dto.config.integrations || {})
						}
					})
				: undefined;
		if (dto.config !== undefined && nextConfig) {
			await this.safeOutboundHttpService.validateIntegrationConfig(
				nextConfig.integrations
			);
		}

		return this.prisma.stopOffer.update({
			where: { id: stopOffer.id },
			data: {
				...(dto.name !== undefined && { name: dto.name }),
				...(dto.isActive !== undefined && { isActive: dto.isActive }),
				...(dto.installDomain !== undefined && {
					installDomain: normalizeInstallDomain(dto.installDomain)
				}),
				...(nextConfig !== undefined && { config: nextConfig })
			}
		});
	}

	async deleteStopOffer(userId: string, stopOfferId: string) {
		const stopOffer = await this.getByIdAndOwner(stopOfferId, userId);

		return this.prisma.stopOffer.delete({ where: { id: stopOffer.id } });
	}

	async getLeads(
		userId: string,
		stopOfferId: string,
		page = 1,
		limit = 50
	) {
		await this.getByIdAndOwner(stopOfferId, userId);
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? limit : 50;
		const skip = (normalizedPage - 1) * normalizedLimit;
		const [leads, total] = await Promise.all([
			this.prisma.stopOfferLead.findMany({
				where: { stopOfferId },
				orderBy: { createdAt: 'desc' },
				skip,
				take: normalizedLimit
			}),
			this.prisma.stopOfferLead.count({ where: { stopOfferId } })
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
		stopOfferId: string,
		format: 'csv' | 'xlsx'
	) {
		const stopOffer = await this.getByIdAndOwner(stopOfferId, userId);
		const sub = await this.subscriptionService.checkAndResetPeriod(userId);

		if (sub?.plan === Plan.EASY) {
			throw new ForbiddenException(
				'Экспорт заявок недоступен на тарифе Easy'
			);
		}

		const leads = await this.prisma.stopOfferLead.findMany({
			where: { stopOfferId },
			orderBy: { createdAt: 'asc' }
		});
		const safeName = stopOffer.name.replace(/[^\w\u0400-\u04FF\-]/g, '_');

		if (format === 'csv') {
			return {
				data: this.buildCsv(leads),
				contentType: 'text/csv; charset=utf-8',
				filename: `stop_offer_leads_${safeName}.csv`
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
			filename: `stop_offer_leads_${safeName}.xlsx`
		};
	}

	async getPublicConfig(
		publicKey: string,
		ip?: string,
		requestDomain: string | null = null,
		directPageAccessAllowed = false
	) {
		const stopOffer = await this.prisma.stopOffer.findUnique({
			where: { publicKey },
			include: { user: { include: { subscription: true } } }
		});
		if (!stopOffer) return null;

		const config = normalizeStopOfferConfig(stopOffer.config);
		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(stopOffer.installDomain, requestDomain)
		) {
			return { isActive: false };
		}

		const sub = await this.subscriptionService.checkAndResetPeriod(
			stopOffer.userId
		);
		const dataType = (config.dataType || 'NONE').toUpperCase();
		const isActive = stopOffer.isActive && sub?.status === 'ACTIVE';
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
		if (
			ip &&
			(config.filterDuplicates || config.hideIfSubmitted) &&
			dataType !== 'NONE'
		) {
			const submissionCooldownDays = config.submissionCooldownDays ?? 0;
			const submissionResetToken = config.submissionResetToken || '';
			const since =
				submissionCooldownDays > 0
					? new Date(
							Date.now() - submissionCooldownDays * 24 * 60 * 60 * 1000
						)
					: null;
			const existing = await this.prisma.stopOfferLead.findFirst({
				where: {
					stopOfferId: stopOffer.id,
					ip,
					resetToken: submissionResetToken,
					...(since ? { createdAt: { gte: since } } : {})
				}
			});
			hasSubmittedByIp = !!existing;
		}

		return {
			isActive: true,
			color: config.color || '#4705fb',
			bgColor: config.bgColor || '',
			buttonColor: config.buttonColor || '',
			hideBranding: hasActiveHardSubscription,
			autoOpenDelay: config.autoOpenDelay || null,
			desktopExitIntent: config.desktopExitIntent !== false,
			mobileAutoOpenDelay: config.mobileAutoOpenDelay ?? 8,
			scrollPercent: config.scrollPercent ?? 70,
			showOnce: config.showOnce !== false,
			displayCooldownDays: config.displayCooldownDays ?? 7,
			displayResetToken: config.displayResetToken || '',
			hideIfSubmitted: config.hideIfSubmitted !== false,
			badgeText: config.badgeText || 'Подождите',
			title: config.title || 'Персональное предложение',
			subtitle: config.subtitle || '',
			offerText: config.offerText || 'Скидка 10%',
			dataType,
			contactTitle: config.contactTitle || 'Куда отправить скидку?',
			submitButtonText: config.submitButtonText || 'Забрать скидку',
			successTitle: config.successTitle || 'Спасибо! Скидка закреплена',
			successSubtitle: config.successSubtitle || '',
			actionButtonEnabled: config.actionButtonEnabled === true,
			actionButtonText: config.actionButtonText || 'Перейти к акции',
			actionButtonUrl: config.actionButtonUrl || '',
			privacyUrl: config.privacyUrl || null,
			developInfoActive:
				config.developInfoActive !== false && !hasActiveHardSubscription,
			filterDuplicates: config.filterDuplicates === true,
			submissionCooldownDays: config.submissionCooldownDays ?? 0,
			submissionResetToken: config.submissionResetToken || '',
			hasSubmittedByIp,
			yandexMetrikaId: config?.integrations?.yandexMetrikaId || null,
			vkPixelId: config?.integrations?.vkPixelId || null,
			roistatEnabled: config?.integrations?.roistatEnabled === true
		};
	}

	async submitLead(
		dto: SubmitStopOfferLeadDto,
		ip?: string,
		requestDomain: string | null = null,
		directPageAccessAllowed = false
	) {
		const stopOffer = await this.prisma.stopOffer.findUnique({
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
		if (!stopOffer) throw new NotFoundException('Стоп-оффер не найден');

		const config = normalizeStopOfferConfig(stopOffer.config);
		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(stopOffer.installDomain, requestDomain)
		) {
			throw new ForbiddenException('Домен установки виджета не совпадает');
		}

		const dataType = (config.dataType || 'NONE').toUpperCase();
		if (dataType === 'NONE') {
			throw new BadRequestException('Сбор контактов отключён');
		}
		this.validateContact(dataType, dto);

		if (!stopOffer.isActive) {
			throw new ForbiddenException(
				'Лимит заявок исчерпан или подписка неактивна'
			);
		}

		const { lead, newCount, limitReached } =
			await this.subscriptionService.createLeadWithinLimit(
				stopOffer.userId,
				async transaction => {
					if (config?.filterDuplicates) {
						const submissionCooldownDays =
							config.submissionCooldownDays ?? 0;
						const submissionResetToken = config.submissionResetToken || '';
						const since =
							submissionCooldownDays > 0
								? new Date(
										Date.now() -
											submissionCooldownDays * 24 * 60 * 60 * 1000
									)
								: null;
						const orConditions: object[] = [];
						if (dto.phone) orConditions.push({ phone: dto.phone });
						if (dto.email) orConditions.push({ email: dto.email });
						if (ip) orConditions.push({ ip });

						if (orConditions.length) {
							const existing = await transaction.stopOfferLead.findFirst({
								where: {
									stopOfferId: stopOffer.id,
									resetToken: submissionResetToken,
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

					const createdLead = await transaction.stopOfferLead.create({
						data: {
							stopOfferId: stopOffer.id,
							phone: dto.phone || null,
							email: dto.email || null,
							url: dto.url,
							ip: ip || null,
							resetToken: config.submissionResetToken || ''
						}
					});
					await enqueueLeadIntegrationEvents(transaction, {
						source: 'stop-offer',
						entity: { id: stopOffer.id, name: stopOffer.name },
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
				}
			);

		if (limitReached) {
			this.sendLimitReachedNotifications(
				stopOffer,
				config,
				newCount
			).catch(() => {});
		}

		return { success: true, lead };
	}

	private validateContact(dataType: string, dto: SubmitStopOfferLeadDto) {
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

	private async sendLimitReachedNotifications(
		stopOffer: any,
		config: any,
		limit: number
	) {
		const sentTo = new Set<string>();
		const accountEmail = stopOffer.user?.authIdentities?.[0]?.value as
			| string
			| undefined;
		const integrationEmail = config?.integrations?.email as
			| string
			| undefined;

		if (accountEmail) {
			try {
				await this.emailService.sendLimitReachedNotification(
					accountEmail,
					stopOffer.name,
					limit
				);
			} catch {}
			sentTo.add(accountEmail);
		}
		if (integrationEmail && !sentTo.has(integrationEmail)) {
			try {
				await this.emailService.sendLimitReachedNotification(
					integrationEmail,
					stopOffer.name,
					limit
				);
			} catch {}
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
		const rows = leads.map((lead, i) => [
			i + 1,
			new Date(lead.createdAt).toLocaleString('ru-RU'),
			lead.phone || '',
			lead.email || '',
			lead.url || ''
		]);
		const csv = [headers, ...rows]
			.map(row => row.map(esc).join(','))
			.join('\r\n');

		return Buffer.from('\uFEFF' + csv, 'utf-8');
	}

	private async getByIdAndOwner(stopOfferId: string, userId: string) {
		const stopOffer = await this.prisma.stopOffer.findUnique({
			where: { id: stopOfferId }
		});
		if (!stopOffer) throw new NotFoundException('Стоп-оффер не найден');
		if (stopOffer.userId !== userId) {
			throw new ForbiddenException('Нет доступа');
		}

		return stopOffer;
	}

	private generatePublicKey(): string {
		return randomBytes(6).toString('hex');
	}
}
