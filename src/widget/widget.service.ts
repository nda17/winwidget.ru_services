import { EmailService } from '@/email/email.service';
import { FileService } from '@/file/file.service';
import { PrismaService } from '@/prisma.service';
import { PLAN_LIMITS } from '@/subscription/subscription.constants';
import { SubscriptionService } from '@/subscription/subscription.service';
import { CreateWidgetDto } from '@/widget/dto/create-widget.dto';
import { SubmitLeadDto } from '@/widget/dto/submit-lead.dto';
import { UpdateWidgetDto } from '@/widget/dto/update-widget.dto';
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
import { Plan, Prisma, SubscriptionStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import * as XLSX from 'xlsx';

const DEFAULT_CONFIG = {
	color: '#4705fb',
	bgColor: '',
	autoOpenDelay: null,
	spinDuration: 5,
	buttonSide: 'right',
	buttonPulse: true,
	buttonBottom: 3,
	buttonOffset: 3,
	buttonSize: 60,
	buttonImageUrl: '',
	bubbleEnabled: true,
	bubbleText: 'Испытайте удачу!',
	alreadyPlayedTitle: '🎉 Вы уже участвовали!',
	alreadyPlayedSubtitle:
		'Каждый посетитель может крутить колесо только один раз',
	hideIfPlayed: false,
	dataType: 'PHONE',
	title: 'Крутите колесо!',
	subtitle: '',
	winMessage: 'Поздравляем! Не пропустите звонок, мы скоро свяжемся',
	privacyUrl:
		'https://winwidget.ru/legal-documentation/consent-processing',
	developInfoActive: true,
	buttonText: 'Крутить!',
	filterDuplicates: false,
	buttonColor: '',
	centerColor: '#ffffff',
	arrowColor: '#ffcc00',
	spinCooldownDays: 0,
	spinResetToken: '',
	actionButton: null,
	bonuses: [
		{ name: 'Бонус #1', active: true },
		{ name: 'Бонус #2', active: true },
		{ name: 'Бонус #3', active: true },
		{ name: 'Бонус #4', active: true },
		{ name: 'Бонус #5', active: true },
		{ name: 'Бонус #6', active: true },
		{ name: 'Бонус #7', active: true },
		{ name: 'Бонус #8', active: true }
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

type AdminWidgetType =
	| 'WHEEL'
	| 'QUIZ'
	| 'CALLBACK'
	| 'TIMER'
	| 'STOP_OFFER';

interface AdminWidgetMonitoringFilters {
	type?: string;
	isActive?: string;
	plan?: string;
	search?: string;
}

interface AdminWidgetMonitoringRow {
	widget_type: AdminWidgetType;
	id: string;
	name: string;
	public_key: string;
	is_active: boolean;
	install_domain: string;
	owner_id: string;
	owner_name: string | null;
	owner_email: string | null;
	owner_phone: string | null;
	owner_plan: Plan | null;
	subscription_status: SubscriptionStatus | null;
	lead_count: number | bigint;
	last_lead_at: Date | null;
	created_at: Date;
	updated_at: Date;
}

@Injectable()
export class WidgetService {
	constructor(
		private prisma: PrismaService,
		private subscriptionService: SubscriptionService,
		private emailService: EmailService,
		private fileService: FileService
	) {}

	async getMyWidgets(userId: string) {
		const sub = await this.subscriptionService.checkAndResetPeriod(userId);
		const widgets = await this.prisma.widget.findMany({
			where: { userId },
			orderBy: { createdAt: 'desc' },
			include: {
				_count: { select: { leads: true } }
			}
		});

		return { widgets, subscription: sub };
	}

	async getAdminWidgetMonitoring(
		page = 1,
		limit = 20,
		filters: AdminWidgetMonitoringFilters = {}
	) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const skip = (normalizedPage - 1) * normalizedLimit;
		const whereSql = this.getAdminWidgetMonitoringWhere(filters);
		const baseSql = this.getAdminWidgetMonitoringBaseSql();

		const [items, totalRows] = await this.prisma.$transaction([
			this.prisma.$queryRaw<AdminWidgetMonitoringRow[]>(Prisma.sql`
				SELECT *
				FROM (${baseSql}) AS admin_widgets
				${whereSql}
				ORDER BY last_lead_at DESC NULLS LAST, created_at DESC
				LIMIT ${normalizedLimit}
				OFFSET ${skip}
			`),
			this.prisma.$queryRaw<Array<{ count: number | bigint }>>(Prisma.sql`
				SELECT COUNT(*)::int AS count
				FROM (${baseSql}) AS admin_widgets
				${whereSql}
			`)
		]);

		const total = this.toNumber(totalRows[0]?.count ?? 0);

		return {
			items: items.map(item => this.serializeAdminWidgetMonitoring(item)),
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async createWidget(userId: string, dto: CreateWidgetDto) {
		const check = await this.subscriptionService.isWidgetAllowed(userId);

		if (!check.allowed) {
			if (check.reason === 'widget_limit_reached') {
				throw new ForbiddenException(
					'Достигнут лимит виджетов для вашего тарифа'
				);
			}
			if (check.reason === 'subscription_expired') {
				throw new ForbiddenException('Ваша подписка истекла');
			}
			throw new ForbiddenException('Создание виджета недоступно');
		}

		// Ensure subscription exists (trial for new users)
		await this.subscriptionService.getOrCreateTrialSubscription(userId);

		const publicKey = this.generatePublicKey();

		return this.prisma.widget.create({
			data: {
				userId,
				publicKey,
				name: dto.name || 'Виджет',
				config: DEFAULT_CONFIG
			}
		});
	}

	async updateWidget(
		userId: string,
		widgetId: string,
		dto: UpdateWidgetDto
	) {
		const widget = await this.getWidgetByIdAndOwner(widgetId, userId);
		const currentConfig = widget.config as Record<string, any>;
		const configPatch =
			dto.config !== undefined
				? this.prepareButtonImageConfigPatch(currentConfig, dto.config)
				: undefined;
		const nextConfig =
			configPatch !== undefined
				? {
						...currentConfig,
						...configPatch
					}
				: undefined;

		const updated = await this.prisma.widget.update({
			where: { id: widget.id },
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

	async deleteWidget(userId: string, widgetId: string) {
		const widget = await this.getWidgetByIdAndOwner(widgetId, userId);
		await this.fileService.deleteWidgetButtonImage(
			(widget.config as Record<string, any>).buttonImageUrl
		);
		return this.prisma.widget.delete({ where: { id: widget.id } });
	}

	async uploadButtonImage(
		userId: string,
		widgetId: string,
		file: Express.Multer.File | undefined
	) {
		const widget = await this.getWidgetByIdAndOwner(widgetId, userId);
		await this.assertCanUseButtonImage(userId);

		const currentConfig = widget.config as Record<string, any>;
		let uploadedUrl = '';

		try {
			const uploadedFile = await this.fileService.saveWidgetButtonImage(
				file,
				'wheel',
				widget.id
			);
			uploadedUrl = uploadedFile.url;

			const updated = await this.prisma.widget.update({
				where: { id: widget.id },
				data: {
					config: {
						...currentConfig,
						buttonImageUrl: uploadedUrl
					}
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

	async getLeads(userId: string, widgetId: string, page = 1, limit = 50) {
		await this.getWidgetByIdAndOwner(widgetId, userId);

		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? limit : 50;
		const skip = (normalizedPage - 1) * normalizedLimit;
		const [leads, total] = await Promise.all([
			this.prisma.lead.findMany({
				where: { widgetId },
				orderBy: { createdAt: 'desc' },
				skip,
				take: normalizedLimit
			}),
			this.prisma.lead.count({ where: { widgetId } })
		]);

		return {
			leads,
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async getLeadsStats(userId: string, widgetId: string) {
		await this.getWidgetByIdAndOwner(widgetId, userId);

		const sub = await this.subscriptionService.checkAndResetPeriod(userId);
		if (sub?.plan === Plan.EASY) {
			throw new ForbiddenException('Аналитика недоступна на тарифе Easy');
		}

		const grouped = await this.prisma.lead.groupBy({
			by: ['bonus'],
			where: { widgetId },
			_count: { id: true },
			orderBy: { _count: { id: 'desc' } }
		});

		const total = grouped.reduce((sum, g) => sum + g._count.id, 0);

		const stats = grouped.map(g => ({
			bonus: g.bonus || 'Без бонуса',
			count: g._count.id,
			percent: total > 0 ? Math.round((g._count.id / total) * 100) : 0
		}));

		return { stats, total };
	}

	async exportLeads(
		userId: string,
		widgetId: string,
		format: 'csv' | 'xlsx'
	) {
		const widget = await this.getWidgetByIdAndOwner(widgetId, userId);

		const sub = await this.subscriptionService.checkAndResetPeriod(userId);
		if (sub?.plan === Plan.EASY) {
			throw new ForbiddenException(
				'Экспорт заявок недоступен на тарифе Easy'
			);
		}

		const leads = await this.prisma.lead.findMany({
			where: { widgetId },
			orderBy: { createdAt: 'asc' }
		});

		const safeName = widget.name.replace(/[^\w\u0400-\u04FF\-]/g, '_');

		if (format === 'csv') {
			return {
				data: this.buildCsv(leads),
				contentType: 'text/csv; charset=utf-8',
				filename: `leads_${safeName}.csv`
			};
		}

		const rows = leads.map((lead: any, i: number) => ({
			'№': i + 1,
			Дата: new Date(lead.createdAt).toLocaleString('ru-RU'),
			Телефон: lead.phone || lead.contact || '',
			Email: lead.email || '',
			Бонус: lead.bonus || '',
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
			filename: `leads_${safeName}.xlsx`
		};
	}

	private buildCsv(leads: any[]): Buffer {
		const headers = ['№', 'Дата', 'Телефон', 'Email', 'Бонус', 'Страница'];
		const esc = (v: any) => {
			const s = String(v ?? '');
			return s.includes(',') || s.includes('"') || s.includes('\n')
				? `"${s.replace(/"/g, '""')}"`
				: s;
		};
		const rows = leads.map((l, i) => [
			i + 1,
			new Date(l.createdAt).toLocaleString('ru-RU'),
			l.phone || l.contact || '',
			l.email || '',
			l.bonus || '',
			l.url || ''
		]);
		const csv = [headers, ...rows]
			.map(r => r.map(esc).join(','))
			.join('\r\n');
		return Buffer.from('\uFEFF' + csv, 'utf-8');
	}

	/**
	 * Returns widget config in the format expected by drum-widget.js mapServerConfig.
	 * Returns null if widget not found, { isActive: false } if inactive/limit reached.
	 */
	async getPublicConfig(
		publicKey: string,
		ip?: string,
		requestDomain: string | null = null,
		directPageAccessAllowed = false
	): Promise<object | null> {
		const widget = await this.prisma.widget.findUnique({
			where: { publicKey },
			include: {
				user: { include: { subscription: true } }
			}
		});

		if (!widget) return null;

		const config = widget.config as any;
		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(widget.installDomain, requestDomain)
		) {
			return { isActive: false };
		}

		const sub = await this.subscriptionService.checkAndResetPeriod(
			widget.userId
		);
		const isActive = widget.isActive && sub?.status === 'ACTIVE';
		const hasActiveHardSubscription =
			sub?.status === SubscriptionStatus.ACTIVE && sub?.plan === Plan.HARD;

		let canAcceptLeads = isActive;
		if (isActive && sub) {
			const limits = PLAN_LIMITS[sub.plan as Plan];
			if (
				!limits.unlimited &&
				sub.leadsThisPeriod >= limits.maxLeadsPerPeriod
			) {
				canAcceptLeads = false;
			}
		}

		if (!canAcceptLeads) {
			return { isActive: false };
		}

		// IP-based played check
		let hasPlayedByIp = false;
		if (ip) {
			const spinCooldownDays = config.spinCooldownDays ?? 0;
			const spinResetToken = config.spinResetToken || '';
			const since =
				spinCooldownDays > 0
					? new Date(Date.now() - spinCooldownDays * 24 * 60 * 60 * 1000)
					: null;
			const existing = await this.prisma.lead.findFirst({
				where: {
					widgetId: widget.id,
					ip,
					spinResetToken,
					...(since ? { createdAt: { gte: since } } : {})
				}
			});
			hasPlayedByIp = !!existing;
		}

		const dataType = (config.dataType || 'PHONE').toUpperCase();

		return {
			isActive: true,
			color: config.color || '#4705fb',
			bgColor: config.bgColor || null,
			title: config.title || 'Крутите колесо!',
			subtitle:
				config.subtitle ||
				(() => {
					const dt = (config.dataType || 'PHONE').toUpperCase();
					if (dt === 'EMAIL')
						return 'Введите свою почту, чтобы выиграть приз';
					if (dt === 'PHONE_AND_EMAIL')
						return 'Введите свой номер телефона и почту, чтобы выиграть приз';
					if (dt === 'NONE') return 'Крутите барабан, чтобы выиграть приз';
					return 'Введите свой номер телефона, чтобы выиграть приз';
				})(),
			winMessage: config.winMessage || '',
			buttonText: config.buttonText || 'Крутить!',
			autoOpenDelay: config.autoOpenDelay || null,
			privacyUrl: config.privacyUrl || null,
			dataType,
			developInfoActive:
				config.developInfoActive !== false && !hasActiveHardSubscription,
			spinDuration: config.spinDuration ?? 5,
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
			bubbleEnabled: config.bubbleEnabled !== false,
			bubbleText: config.bubbleText || 'Испытайте удачу!',
			alreadyPlayedTitle:
				config.alreadyPlayedTitle || '🎉 Вы уже участвовали!',
			alreadyPlayedSubtitle:
				config.alreadyPlayedSubtitle ||
				'Каждый посетитель может крутить колесо только один раз',
			hideIfPlayed: config.hideIfPlayed === true,
			buttonColor: config.buttonColor || '',
			centerColor: config.centerColor || '#ffffff',
			arrowColor: config.arrowColor || '#ffcc00',
			spinCooldownDays: config.spinCooldownDays ?? 0,
			spinResetToken: config.spinResetToken || '',
			hasPlayedByIp,
			yandexMetrikaId: config?.integrations?.yandexMetrikaId || null,
			vkPixelId: config?.integrations?.vkPixelId || null,
			roistatEnabled: config?.integrations?.roistatEnabled === true,
			bonuses: (config.bonuses || []) as any[]
		};
	}

	/**
	 * Submit lead from public widget (drum-widget.js API)
	 */
	async submitLeadByKey(
		key: string,
		phone?: string,
		email?: string,
		name?: string,
		bonus?: string,
		ip?: string,
		requestDomain: string | null = null,
		directPageAccessAllowed = false
	) {
		const contact = phone ? phone : email || name || 'unknown';
		return this.submitLead(
			{ key, contact, phone, email, name, bonus, url: undefined },
			ip,
			requestDomain,
			directPageAccessAllowed
		);
	}

	async getWidgetConfig(
		publicKey: string,
		requestDomain: string | null = null,
		directPageAccessAllowed = false
	) {
		const widget = await this.prisma.widget.findUnique({
			where: { publicKey },
			include: {
				user: {
					include: { subscription: true }
				}
			}
		});

		if (!widget) {
			return null;
		}

		if (!widget.isActive) return null;

		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(widget.installDomain, requestDomain)
		) {
			return null;
		}

		const sub = widget.user.subscription;
		if (!sub || sub.status !== 'ACTIVE') return null;

		const limits = PLAN_LIMITS[sub.plan as Plan];
		if (
			!limits.unlimited &&
			sub.leadsThisPeriod >= limits.maxLeadsPerPeriod
		) {
			return null;
		}

		return widget.config;
	}

	async submitLead(
		dto: SubmitLeadDto,
		ip?: string,
		requestDomain: string | null = null,
		directPageAccessAllowed = false
	) {
		const widget = await this.prisma.widget.findUnique({
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

		if (!widget) {
			throw new NotFoundException('Виджет не найден');
		}

		const check = await this.subscriptionService.canSubmitLead(widget.id);
		if (!check.allowed) {
			throw new ForbiddenException(
				'Лимит заявок исчерпан или подписка неактивна'
			);
		}

		const config = widget.config as any;
		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(widget.installDomain, requestDomain)
		) {
			throw new ForbiddenException('Домен установки виджета не совпадает');
		}

		// Filter duplicates if enabled
		if (config?.filterDuplicates) {
			const spinResetToken = config.spinResetToken || '';
			const orConditions: object[] = [{ contact: dto.contact }];
			if (ip) orConditions.push({ ip });
			const existingLead = await this.prisma.lead.findFirst({
				where: { widgetId: widget.id, spinResetToken, OR: orConditions }
			});
			if (existingLead) {
				throw new BadRequestException(
					'Заявка с таким контактом уже существует'
				);
			}
		}

		const lead = await this.prisma.lead.create({
			data: {
				widgetId: widget.id,
				contact: dto.contact,
				phone: dto.phone,
				email: dto.email,
				bonus: dto.bonus,
				url: dto.url,
				ip: ip || null,
				spinResetToken: config.spinResetToken || ''
			}
		});

		await this.subscriptionService.incrementLeadCount(widget.userId);

		// Notify owner if lead limit just reached
		const sub = widget.user.subscription;
		if (sub) {
			const limits = PLAN_LIMITS[sub.plan as Plan];
			const newCount = sub.leadsThisPeriod + 1;
			if (!limits.unlimited && newCount === limits.maxLeadsPerPeriod) {
				this.sendLimitReachedNotifications(widget, config, newCount).catch(
					() => {}
				);
			}
		}

		// Send email notification to widget owner if configured
		const notificationEmail = config?.integrations?.email;
		if (notificationEmail) {
			try {
				await this.emailService.sendLeadNotification(notificationEmail, {
					widgetName: widget.name,
					phone: dto.phone,
					email: dto.email,
					name: dto.name,
					bonus: dto.bonus,
					url: dto.url,
					date: new Date()
				});
			} catch {
				// Email errors shouldn't fail the lead submission
			}
		}

		// Webhook notification
		const webhookUrl = config?.integrations?.webhookUrl;
		if (webhookUrl) {
			try {
				await fetch(webhookUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						name: widget.name,
						lead: dto.contact,
						phone: dto.phone || null,
						email: dto.email || null,
						bonus: dto.bonus || null,
						url: dto.url || null,
						time: new Date().toISOString()
					})
				});
			} catch {
				// Webhook errors shouldn't fail the lead submission
			}
		}

		// Telegram notification
		const telegramChatId = config?.integrations?.telegramChatId;
		const telegramBotToken = process.env.TELEGRAM_INFO_BOT_TOKEN;
		if (telegramChatId && telegramBotToken) {
			try {
				await fetch(
					`https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							chat_id: telegramChatId,
							text: this.buildTelegramMessage({
								widgetName: widget.name,
								phone: dto.phone,
								email: dto.email,
								name: dto.name,
								bonus: dto.bonus,
								url: dto.url,
								date: new Date()
							}),
							parse_mode: 'HTML'
						})
					}
				);
			} catch {
				// Telegram errors shouldn't fail the lead submission
			}
		}

		// Bitrix24 notification
		const bitrix24WebhookUrl = config?.integrations?.bitrix24WebhookUrl;
		if (bitrix24WebhookUrl) {
			try {
				const fields: Record<string, any> = {
					TITLE: `Заявка с виджета «${widget.name}»${dto.bonus ? ` — ${dto.bonus}` : ''}`,
					SOURCE_ID: 'WEB',
					COMMENTS: [
						`Виджет: ${widget.name}`,
						dto.bonus ? `Приз: ${dto.bonus}` : '',
						dto.url ? `Страница: ${dto.url}` : ''
					]
						.filter(Boolean)
						.join('\n')
				};
				if (dto.name) fields.NAME = dto.name;
				if (dto.phone)
					fields.PHONE = [{ VALUE: dto.phone, VALUE_TYPE: 'WORK' }];
				if (dto.email)
					fields.EMAIL = [{ VALUE: dto.email, VALUE_TYPE: 'WORK' }];

				const base = bitrix24WebhookUrl.replace(/\/$/, '');
				await fetch(`${base}/crm.lead.add.json`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ fields })
				});
			} catch {
				// Bitrix24 errors shouldn't fail the lead submission
			}
		}

		// amoCRM notification
		const amoCrmDomain = config?.integrations?.amoCrmDomain;
		const amoCrmToken = config?.integrations?.amoCrmToken;
		if (amoCrmDomain && amoCrmToken) {
			try {
				// Normalize domain: strip protocol and trailing slash, append .amocrm.ru if needed
				let domain = amoCrmDomain
					.replace(/^https?:\/\//, '')
					.replace(/\/$/, '');
				if (!domain.includes('.')) domain = `${domain}.amocrm.ru`;
				const baseUrl = `https://${domain}`;

				const contactFields: any[] = [];
				if (dto.phone)
					contactFields.push({
						field_code: 'PHONE',
						values: [{ value: dto.phone, enum_code: 'WORK' }]
					});
				if (dto.email)
					contactFields.push({
						field_code: 'EMAIL',
						values: [{ value: dto.email, enum_code: 'WORK' }]
					});

				const leadNote = [
					`Виджет: ${widget.name}`,
					dto.bonus ? `Приз: ${dto.bonus}` : '',
					dto.url ? `Страница: ${dto.url}` : ''
				]
					.filter(Boolean)
					.join('\n');

				const body: any = [
					{
						name: `Заявка с виджета «${widget.name}»${dto.bonus ? ` — ${dto.bonus}` : ''}`,
						_embedded: {
							contacts: [
								{
									...(dto.name ? { first_name: dto.name } : {}),
									...(contactFields.length
										? { custom_fields_values: contactFields }
										: {})
								}
							]
						},
						...(leadNote
							? {
									custom_fields_values: [
										{
											field_code: 'DESCRIPTION',
											values: [{ value: leadNote }]
										}
									]
								}
							: {})
					}
				];

				await fetch(`${baseUrl}/api/v4/leads/complex`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${amoCrmToken}`
					},
					body: JSON.stringify(body)
				});
			} catch {
				// amoCRM errors shouldn't fail the lead submission
			}
		}

		return { success: true, lead };
	}

	private async sendLimitReachedNotifications(
		widget: any,
		config: any,
		limit: number
	) {
		const sentTo = new Set<string>();

		// Account email from AuthIdentity
		const accountEmail = widget.user?.authIdentities?.[0]?.value as
			| string
			| undefined;

		// Integration email (may differ from account email)
		const integrationEmail = config?.integrations?.email as
			| string
			| undefined;

		if (accountEmail) {
			try {
				await this.emailService.sendLimitReachedNotification(
					accountEmail,
					widget.name,
					limit
				);
			} catch {}
			sentTo.add(accountEmail);
		}

		if (integrationEmail && !sentTo.has(integrationEmail)) {
			try {
				await this.emailService.sendLimitReachedNotification(
					integrationEmail,
					widget.name,
					limit
				);
			} catch {}
		}

		// Telegram
		const telegramChatId = config?.integrations?.telegramChatId as
			| string
			| undefined;
		const telegramBotToken = process.env.TELEGRAM_INFO_BOT_TOKEN;
		if (telegramChatId && telegramBotToken) {
			try {
				await fetch(
					`https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							chat_id: telegramChatId,
							parse_mode: 'HTML',
							text: [
								`⚠️ <b>Лимит заявок исчерпан</b>`,
								`Виджет <i>${widget.name}</i> принял последнюю заявку (${limit} из ${limit}).`,
								``,
								`Виджет больше не будет принимать новые заявки.`,
								`Для продолжения работы перейдите на платный тариф:`,
								`👉 https://winwidget.ru/#pricing`
							].join('\n')
						})
					}
				);
			} catch {}
		}
	}

	private getAdminWidgetMonitoringBaseSql() {
		const ownerFieldsSql = Prisma.sql`
			u.id AS owner_id,
			u.name AS owner_name,
			email_identity.value AS owner_email,
			phone_identity.value AS owner_phone,
			s.plan::text AS owner_plan,
			s.status::text AS subscription_status
		`;
		const ownerJoinsSql = Prisma.sql`
			JOIN "User" u ON u.id = entity.user_id
			LEFT JOIN subscriptions s ON s.user_id = u.id
			LEFT JOIN LATERAL (
				SELECT ai.value
				FROM auth_identities ai
				WHERE ai.user_id = u.id AND ai.type::text = 'EMAIL'
				ORDER BY ai.created_at ASC
				LIMIT 1
			) email_identity ON true
			LEFT JOIN LATERAL (
				SELECT ai.value
				FROM auth_identities ai
				WHERE ai.user_id = u.id AND ai.type::text = 'PHONE'
				ORDER BY ai.created_at ASC
				LIMIT 1
			) phone_identity ON true
		`;

		return Prisma.sql`
			SELECT
				'WHEEL'::text AS widget_type,
				entity.id,
				entity.name,
				entity.public_key,
				entity.is_active,
				entity.install_domain,
				${ownerFieldsSql},
				(SELECT COUNT(*)::int FROM leads l WHERE l.widget_id = entity.id) AS lead_count,
				(SELECT MAX(l.created_at) FROM leads l WHERE l.widget_id = entity.id) AS last_lead_at,
				entity.created_at,
				entity.updated_at
			FROM widgets entity
			${ownerJoinsSql}

			UNION ALL

			SELECT
				'QUIZ'::text AS widget_type,
				entity.id,
				entity.name,
				entity.public_key,
				entity.is_active,
				entity.install_domain,
				${ownerFieldsSql},
				(SELECT COUNT(*)::int FROM quiz_leads l WHERE l.quiz_id = entity.id) AS lead_count,
				(SELECT MAX(l.created_at) FROM quiz_leads l WHERE l.quiz_id = entity.id) AS last_lead_at,
				entity.created_at,
				entity.updated_at
			FROM quizzes entity
			${ownerJoinsSql}

			UNION ALL

			SELECT
				'CALLBACK'::text AS widget_type,
				entity.id,
				entity.name,
				entity.public_key,
				entity.is_active,
				entity.install_domain,
				${ownerFieldsSql},
				(SELECT COUNT(*)::int FROM callback_leads l WHERE l.callback_id = entity.id) AS lead_count,
				(SELECT MAX(l.created_at) FROM callback_leads l WHERE l.callback_id = entity.id) AS last_lead_at,
				entity.created_at,
				entity.updated_at
			FROM callbacks entity
			${ownerJoinsSql}

			UNION ALL

			SELECT
				'TIMER'::text AS widget_type,
				entity.id,
				entity.name,
				entity.public_key,
				entity.is_active,
				entity.install_domain,
				${ownerFieldsSql},
				(SELECT COUNT(*)::int FROM countdown_timer_leads l WHERE l.countdown_timer_id = entity.id) AS lead_count,
				(SELECT MAX(l.created_at) FROM countdown_timer_leads l WHERE l.countdown_timer_id = entity.id) AS last_lead_at,
				entity.created_at,
				entity.updated_at
			FROM countdown_timers entity
			${ownerJoinsSql}

			UNION ALL

			SELECT
				'STOP_OFFER'::text AS widget_type,
				entity.id,
				entity.name,
				entity.public_key,
				entity.is_active,
				entity.install_domain,
				${ownerFieldsSql},
				(SELECT COUNT(*)::int FROM stop_offer_leads l WHERE l.stop_offer_id = entity.id) AS lead_count,
				(SELECT MAX(l.created_at) FROM stop_offer_leads l WHERE l.stop_offer_id = entity.id) AS last_lead_at,
				entity.created_at,
				entity.updated_at
			FROM stop_offers entity
			${ownerJoinsSql}
		`;
	}

	private getAdminWidgetMonitoringWhere(
		filters: AdminWidgetMonitoringFilters
	) {
		const and: Prisma.Sql[] = [];
		const type = this.normalizeAdminWidgetType(filters.type);
		const isActive = this.normalizeAdminWidgetActive(filters.isActive);
		const plan = this.normalizeAdminWidgetPlan(filters.plan);
		const search = filters.search?.trim();

		if (type) and.push(Prisma.sql`widget_type = ${type}`);
		if (isActive !== undefined) {
			and.push(Prisma.sql`is_active = ${isActive}`);
		}
		if (plan === null) {
			and.push(Prisma.sql`owner_plan IS NULL`);
		} else if (plan) {
			and.push(Prisma.sql`owner_plan = ${plan}`);
		}
		if (search) {
			and.push(Prisma.sql`
				concat_ws(
					' ',
					id,
					name,
					public_key,
					install_domain,
					owner_id,
					owner_name,
					owner_email,
					owner_phone
				) ILIKE ${`%${search}%`}
			`);
		}

		return and.length
			? Prisma.sql`WHERE ${Prisma.join(and, ' AND ')}`
			: Prisma.empty;
	}

	private normalizeAdminWidgetType(value?: string) {
		const normalized = value?.trim().toUpperCase();
		const allowed: AdminWidgetType[] = [
			'WHEEL',
			'QUIZ',
			'CALLBACK',
			'TIMER',
			'STOP_OFFER'
		];

		if (!normalized) return undefined;
		if (!allowed.includes(normalized as AdminWidgetType)) {
			throw new BadRequestException('Некорректный тип виджета');
		}

		return normalized as AdminWidgetType;
	}

	private normalizeAdminWidgetActive(value?: string) {
		const normalized = value?.trim().toLowerCase();

		if (!normalized) return undefined;
		if (normalized === 'true') return true;
		if (normalized === 'false') return false;

		throw new BadRequestException('Некорректный статус виджета');
	}

	private normalizeAdminWidgetPlan(value?: string) {
		const normalized = value?.trim().toUpperCase();

		if (!normalized) return undefined;
		if (normalized === 'NONE') return null;
		if (!Object.values(Plan).includes(normalized as Plan)) {
			throw new BadRequestException('Некорректный тариф владельца');
		}

		return normalized as Plan;
	}

	private serializeAdminWidgetMonitoring(item: AdminWidgetMonitoringRow) {
		return {
			type: item.widget_type,
			id: item.id,
			name: item.name,
			publicKey: item.public_key,
			isActive: item.is_active,
			installDomain: item.install_domain,
			owner: {
				id: item.owner_id,
				name: item.owner_name,
				email: item.owner_email,
				phone: item.owner_phone
			},
			ownerPlan: item.owner_plan,
			subscriptionStatus: item.subscription_status,
			leadCount: this.toNumber(item.lead_count),
			lastLeadAt: item.last_lead_at?.toISOString() ?? null,
			createdAt: item.created_at.toISOString(),
			updatedAt: item.updated_at.toISOString()
		};
	}

	private toNumber(value: number | bigint) {
		return typeof value === 'bigint' ? Number(value) : value;
	}

	private buildTelegramMessage(data: {
		widgetName: string;
		phone?: string;
		email?: string;
		name?: string;
		bonus?: string;
		url?: string;
		date: Date;
	}): string {
		const dateStr = data.date.toLocaleString('ru-RU', {
			timeZone: 'Europe/Moscow'
		});
		const lines: string[] = [
			`🎯 <b>Новая заявка с виджета</b>`,
			`<i>${data.widgetName}</i>`,
			``,
			`📅 <b>Дата:</b> ${dateStr}`
		];
		if (data.name) lines.push(`👤 <b>Имя:</b> ${data.name}`);
		if (data.phone) lines.push(`📞 <b>Телефон:</b> ${data.phone}`);
		if (data.email) lines.push(`✉️ <b>Email:</b> ${data.email}`);
		if (data.bonus) lines.push(`🎁 <b>Приз:</b> ${data.bonus}`);
		if (data.url) lines.push(`🌐 <b>Страница:</b> ${data.url}`);
		return lines.join('\n');
	}

	private async getWidgetByIdAndOwner(widgetId: string, userId: string) {
		const widget = await this.prisma.widget.findUnique({
			where: { id: widgetId }
		});

		if (!widget) throw new NotFoundException('Виджет не найден');
		if (widget.userId !== userId)
			throw new ForbiddenException('Нет доступа');

		return widget;
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
		return randomBytes(6).toString('hex'); // 12 символов hex
	}
}
