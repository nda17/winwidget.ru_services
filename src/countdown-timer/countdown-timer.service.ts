import { CreateCountdownTimerDto } from '@/countdown-timer/dto/create-countdown-timer.dto';
import { SubmitCountdownTimerLeadDto } from '@/countdown-timer/dto/submit-countdown-timer-lead.dto';
import { UpdateCountdownTimerDto } from '@/countdown-timer/dto/update-countdown-timer.dto';
import { EmailService } from '@/email/email.service';
import { FileService } from '@/file/file.service';
import { PrismaService } from '@/prisma.service';
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

@Injectable()
export class CountdownTimerService {
	constructor(
		private prisma: PrismaService,
		private subscriptionService: SubscriptionService,
		private emailService: EmailService,
		private fileService: FileService
	) {}

	async getMyCountdownTimers(userId: string) {
		const sub = await this.subscriptionService.checkAndResetPeriod(userId);
		const countdownTimers = await this.prisma.countdownTimer.findMany({
			where: { userId },
			orderBy: { createdAt: 'desc' },
			include: { _count: { select: { leads: true } } }
		});
		return { countdownTimers, subscription: sub };
	}

	async createCountdownTimer(
		userId: string,
		dto: CreateCountdownTimerDto
	) {
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

		await this.subscriptionService.getOrCreateTrialSubscription(userId);

		return this.prisma.countdownTimer.create({
			data: {
				userId,
				publicKey: this.generatePublicKey(),
				name: dto.name || 'Таймер',
				config: createDefaultConfig()
			}
		});
	}

	async updateCountdownTimer(
		userId: string,
		countdownTimerId: string,
		dto: UpdateCountdownTimerDto
	) {
		const timer = await this.getByIdAndOwner(countdownTimerId, userId);
		const currentConfig = timer.config as Record<string, any>;
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

		const updated = await this.prisma.countdownTimer.update({
			where: { id: timer.id },
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

	async deleteCountdownTimer(userId: string, countdownTimerId: string) {
		const timer = await this.getByIdAndOwner(countdownTimerId, userId);
		await this.fileService.deleteWidgetButtonImage(
			(timer.config as Record<string, any>).buttonImageUrl
		);
		return this.prisma.countdownTimer.delete({ where: { id: timer.id } });
	}

	async uploadButtonImage(
		userId: string,
		countdownTimerId: string,
		file: Express.Multer.File | undefined
	) {
		const timer = await this.getByIdAndOwner(countdownTimerId, userId);
		await this.assertCanUseButtonImage(userId);

		const currentConfig = timer.config as Record<string, any>;
		let uploadedUrl = '';

		try {
			const uploadedFile = await this.fileService.saveWidgetButtonImage(
				file,
				'timer',
				timer.id
			);
			uploadedUrl = uploadedFile.url;

			const updated = await this.prisma.countdownTimer.update({
				where: { id: timer.id },
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

		const config = timer.config as any;
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
				sub?.status === SubscriptionStatus.ACTIVE &&
					sub?.plan === Plan.HARD
			),
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
			developInfoActive: config.developInfoActive !== false,
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

		const config = timer.config as any;
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

		const check =
			await this.subscriptionService.canSubmitCountdownTimerLead(timer.id);
		if (!check.allowed) {
			throw new ForbiddenException(
				'Лимит заявок исчерпан или подписка неактивна'
			);
		}

		if (config?.filterDuplicates) {
			const submissionCooldownDays = config.submissionCooldownDays ?? 0;
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
				const existing = await this.prisma.countdownTimerLead.findFirst({
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

		const lead = await this.prisma.countdownTimerLead.create({
			data: {
				countdownTimerId: timer.id,
				phone: dto.phone || null,
				email: dto.email || null,
				url: dto.url,
				ip: ip || null,
				timerResetToken: config.timerResetToken || ''
			}
		});

		await this.subscriptionService.incrementLeadCount(timer.userId);

		const sub = timer.user.subscription;
		if (sub) {
			const limits = PLAN_LIMITS[sub.plan as Plan];
			const newCount = sub.leadsThisPeriod + 1;
			if (!limits.unlimited && newCount === limits.maxLeadsPerPeriod) {
				this.sendLimitReachedNotifications(timer, config, newCount).catch(
					() => {}
				);
			}
		}

		await this.sendNotifications(timer, config, dto);

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

	private async sendNotifications(
		timer: any,
		config: any,
		dto: SubmitCountdownTimerLeadDto
	) {
		const notificationEmail = config?.integrations?.email;
		if (notificationEmail) {
			try {
				await this.emailService.sendLeadNotification(notificationEmail, {
					widgetName: timer.name,
					phone: dto.phone,
					email: dto.email,
					bonus: 'Таймер обратного отсчёта',
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
						name: timer.name,
						lead: dto.phone || dto.email || null,
						phone: dto.phone || null,
						email: dto.email || null,
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
							text: this.buildTelegramMessage({ timer, dto }),
							parse_mode: 'HTML'
						})
					}
				);
			} catch {}
		}
	}

	private async sendLimitReachedNotifications(
		timer: any,
		config: any,
		limit: number
	) {
		const sentTo = new Set<string>();
		const accountEmail = timer.user?.authIdentities?.[0]?.value as
			| string
			| undefined;
		const integrationEmail = config?.integrations?.email as
			| string
			| undefined;

		if (accountEmail) {
			try {
				await this.emailService.sendLimitReachedNotification(
					accountEmail,
					timer.name,
					limit
				);
			} catch {}
			sentTo.add(accountEmail);
		}
		if (integrationEmail && !sentTo.has(integrationEmail)) {
			try {
				await this.emailService.sendLimitReachedNotification(
					integrationEmail,
					timer.name,
					limit
				);
			} catch {}
		}
	}

	private buildTelegramMessage(data: {
		timer: any;
		dto: SubmitCountdownTimerLeadDto;
	}): string {
		const dateStr = new Date().toLocaleString('ru-RU', {
			timeZone: 'Europe/Moscow'
		});
		const lines: string[] = [
			`⏳ <b>Новая заявка с таймера</b>`,
			`<i>${data.timer.name}</i>`,
			``,
			`📅 <b>Дата:</b> ${dateStr}`
		];
		if (data.dto.phone) lines.push(`📞 <b>Телефон:</b> ${data.dto.phone}`);
		if (data.dto.email) lines.push(`✉️ <b>Email:</b> ${data.dto.email}`);
		if (data.dto.url) lines.push(`🌐 <b>Страница:</b> ${data.dto.url}`);
		return lines.join('\n');
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
