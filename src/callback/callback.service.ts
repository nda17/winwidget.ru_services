import { EmailService } from '@/email/email.service';
import { FileService } from '@/file/file.service';
import { PrismaService } from '@/prisma.service';
import { PLAN_LIMITS } from '@/subscription/subscription.constants';
import { SubscriptionService } from '@/subscription/subscription.service';
import { CreateCallbackDto } from '@/callback/dto/create-callback.dto';
import { SubmitCallbackLeadDto } from '@/callback/dto/submit-callback-lead.dto';
import { UpdateCallbackDto } from '@/callback/dto/update-callback.dto';
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

@Injectable()
export class CallbackService {
	constructor(
		private prisma: PrismaService,
		private subscriptionService: SubscriptionService,
		private emailService: EmailService,
		private fileService: FileService
	) {}

	async getMyCallbacks(userId: string) {
		const sub = await this.subscriptionService.checkAndResetPeriod(userId);
		const callbacks = await this.prisma.callback.findMany({
			where: { userId },
			orderBy: { createdAt: 'desc' },
			include: { _count: { select: { leads: true } } }
		});
		return { callbacks, subscription: sub };
	}

	async createCallback(userId: string, dto: CreateCallbackDto) {
		const check = await this.subscriptionService.isWidgetAllowed(userId);
		if (!check.allowed) {
			if (check.reason === 'widget_limit_reached')
				throw new ForbiddenException(
					'Достигнут лимит виджетов для вашего тарифа'
				);
			if (check.reason === 'subscription_expired')
				throw new ForbiddenException('Ваша подписка истекла');
			throw new ForbiddenException('Создание виджета недоступно');
		}

		await this.subscriptionService.getOrCreateTrialSubscription(userId);

		return this.prisma.callback.create({
			data: {
				userId,
				publicKey: this.generatePublicKey(),
				name: dto.name || 'Обратный звонок',
				config: DEFAULT_CONFIG
			}
		});
	}

	async updateCallback(
		userId: string,
		callbackId: string,
		dto: UpdateCallbackDto
	) {
		const callback = await this.getByIdAndOwner(callbackId, userId);
		const currentConfig = callback.config as Record<string, any>;
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

		const updated = await this.prisma.callback.update({
			where: { id: callback.id },
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

	async deleteCallback(userId: string, callbackId: string) {
		const callback = await this.getByIdAndOwner(callbackId, userId);
		await this.fileService.deleteWidgetButtonImage(
			(callback.config as Record<string, any>).buttonImageUrl
		);
		return this.prisma.callback.delete({ where: { id: callback.id } });
	}

	async uploadButtonImage(
		userId: string,
		callbackId: string,
		file: Express.Multer.File | undefined
	) {
		const callback = await this.getByIdAndOwner(callbackId, userId);
		await this.assertCanUseButtonImage(userId);

		const currentConfig = callback.config as Record<string, any>;
		let uploadedUrl = '';

		try {
			const uploadedFile = await this.fileService.saveWidgetButtonImage(
				file,
				'callback',
				callback.id
			);
			uploadedUrl = uploadedFile.url;

			const updated = await this.prisma.callback.update({
				where: { id: callback.id },
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

		const config = callback.config as any;
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

		const check = await this.subscriptionService.canSubmitCallbackLead(
			callback.id
		);
		if (!check.allowed)
			throw new ForbiddenException(
				'Лимит заявок исчерпан или подписка неактивна'
			);

		const config = callback.config as any;
		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(callback.installDomain, requestDomain)
		) {
			throw new ForbiddenException('Домен установки виджета не совпадает');
		}

		if (config?.filterDuplicates && ip) {
			const existing = await this.prisma.callbackLead.findFirst({
				where: { callbackId: callback.id, ip }
			});
			if (existing)
				throw new BadRequestException(
					'Заявка с этого устройства уже существует'
				);
		}

		const lead = await this.prisma.callbackLead.create({
			data: {
				callbackId: callback.id,
				phone: dto.phone,
				timeSlot: dto.timeSlot || '',
				timezone: dto.timezone || '',
				url: dto.url,
				ip: ip || null
			}
		});

		await this.subscriptionService.incrementLeadCount(callback.userId);

		const sub = callback.user.subscription;
		if (sub) {
			const limits = PLAN_LIMITS[sub.plan as Plan];
			const newCount = sub.leadsThisPeriod + 1;
			if (!limits.unlimited && newCount === limits.maxLeadsPerPeriod) {
				this.sendLimitReachedNotifications(
					callback,
					config,
					newCount
				).catch(() => {});
			}
		}

		await this.sendNotifications(callback, config, dto);

		return { success: true, lead };
	}

	private async sendNotifications(
		callback: any,
		config: any,
		dto: SubmitCallbackLeadDto
	) {
		const notificationEmail = config?.integrations?.email;
		if (notificationEmail) {
			try {
				await this.emailService.sendLeadNotification(notificationEmail, {
					widgetName: callback.name,
					phone: dto.phone,
					bonus: dto.timeSlot
						? `Время звонка: ${dto.timeSlot}${dto.timezone ? ` (${dto.timezone})` : ''}`
						: undefined,
					url: dto.url,
					date: new Date()
				});
			} catch {}
		}

		const webhookUrl = config?.integrations?.webhookUrl;
		if (webhookUrl) {
			try {
				await fetch(webhookUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						name: callback.name,
						phone: dto.phone,
						timeSlot: dto.timeSlot || null,
						timezone: dto.timezone || null,
						url: dto.url || null,
						time: new Date().toISOString()
					})
				});
			} catch {}
		}

		const telegramChatId = config?.integrations?.telegramChatId;
		const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
		if (telegramChatId && telegramBotToken) {
			try {
				await fetch(
					`https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							chat_id: telegramChatId,
							text: this.buildTelegramMessage({ callback, dto }),
							parse_mode: 'HTML'
						})
					}
				);
			} catch {}
		}

		const bitrix24WebhookUrl = config?.integrations?.bitrix24WebhookUrl;
		if (bitrix24WebhookUrl) {
			try {
				const fields: Record<string, any> = {
					TITLE: `Обратный звонок — «${callback.name}»`,
					SOURCE_ID: 'WEB',
					COMMENTS: [
						`Виджет: ${callback.name}`,
						dto.timeSlot ? `Время звонка: ${dto.timeSlot}` : '',
						dto.timezone ? `Часовой пояс: ${dto.timezone}` : '',
						dto.url ? `Страница: ${dto.url}` : ''
					]
						.filter(Boolean)
						.join('\n'),
					PHONE: [{ VALUE: dto.phone, VALUE_TYPE: 'WORK' }]
				};
				const base = bitrix24WebhookUrl.replace(/\/$/, '');
				await fetch(`${base}/crm.lead.add.json`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ fields })
				});
			} catch {}
		}

		const amoCrmDomain = config?.integrations?.amoCrmDomain;
		const amoCrmToken = config?.integrations?.amoCrmToken;
		if (amoCrmDomain && amoCrmToken) {
			try {
				let domain = amoCrmDomain
					.replace(/^https?:\/\//, '')
					.replace(/\/$/, '');
				if (!domain.includes('.')) domain = `${domain}.amocrm.ru`;

				const body: any = [
					{
						name: `Обратный звонок — «${callback.name}»`,
						_embedded: {
							contacts: [
								{
									custom_fields_values: [
										{
											field_code: 'PHONE',
											values: [{ value: dto.phone, enum_code: 'WORK' }]
										}
									]
								}
							]
						}
					}
				];
				await fetch(`https://${domain}/api/v4/leads/complex`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${amoCrmToken}`
					},
					body: JSON.stringify(body)
				});
			} catch {}
		}
	}

	private async sendLimitReachedNotifications(
		callback: any,
		config: any,
		limit: number
	) {
		const sentTo = new Set<string>();
		const accountEmail = callback.user?.authIdentities?.[0]?.value as
			| string
			| undefined;
		const integrationEmail = config?.integrations?.email as
			| string
			| undefined;

		if (accountEmail) {
			try {
				await this.emailService.sendLimitReachedNotification(
					accountEmail,
					callback.name,
					limit
				);
			} catch {}
			sentTo.add(accountEmail);
		}

		if (integrationEmail && !sentTo.has(integrationEmail)) {
			try {
				await this.emailService.sendLimitReachedNotification(
					integrationEmail,
					callback.name,
					limit
				);
			} catch {}
		}

		const telegramChatId = config?.integrations?.telegramChatId as
			| string
			| undefined;
		const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
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
								`Виджет <i>${callback.name}</i> принял последнюю заявку (${limit} из ${limit}).`,
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

	private buildTelegramMessage(data: {
		callback: any;
		dto: SubmitCallbackLeadDto;
	}): string {
		const dateStr = new Date().toLocaleString('ru-RU', {
			timeZone: 'Europe/Moscow'
		});
		const lines: string[] = [
			`📞 <b>Заявка на обратный звонок</b>`,
			`<i>${data.callback.name}</i>`,
			``,
			`📅 <b>Дата:</b> ${dateStr}`,
			`📞 <b>Телефон:</b> ${data.dto.phone}`
		];
		if (data.dto.timeSlot)
			lines.push(`🕐 <b>Время звонка:</b> ${data.dto.timeSlot}`);
		if (data.dto.timezone)
			lines.push(`🌍 <b>Часовой пояс:</b> ${data.dto.timezone}`);
		if (data.dto.url) lines.push(`🌐 <b>Страница:</b> ${data.dto.url}`);
		return lines.join('\n');
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
