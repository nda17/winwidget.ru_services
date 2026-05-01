import { EmailService } from '@/email/email.service';
import { PrismaService } from '@/prisma.service';
import { PLAN_LIMITS } from '@/subscription/subscription.constants';
import { SubscriptionService } from '@/subscription/subscription.service';
import { CreateQuizDto } from '@/quiz/dto/create-quiz.dto';
import { SubmitQuizLeadDto } from '@/quiz/dto/submit-quiz-lead.dto';
import { UpdateQuizDto } from '@/quiz/dto/update-quiz.dto';
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
import { Plan } from '@prisma/client';
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
	bubbleEnabled: true,
	bubbleText: 'Пройдите квиз!',
	autoOpenDelay: null,
	title: 'Пройдите наш квиз!',
	subtitle:
		'Ответьте на несколько вопросов и получите персональную рекомендацию',
	buttonText: 'Начать квиз',
	contactTitle: 'Оставьте контакт для получения результата',
	dataType: 'PHONE',
	privacyUrl:
		'https://winwidget.ru/legal-documentation/consent-processing',
	developInfoActive: true,
	filterDuplicates: false,
	alreadyPlayedTitle: '🎉 Вы уже проходили этот квиз!',
	alreadyPlayedSubtitle:
		'Каждый посетитель может пройти квиз только один раз',
	hideIfPlayed: false,
	quizCooldownDays: 0,
	quizResetToken: '',
	questions: [
		{
			id: 'q1',
			text: 'Вопрос 1',
			type: 'radio',
			options: [
				{ id: 'q1o1', text: 'Вариант А', scores: { r1: 1, r2: 0 } },
				{ id: 'q1o2', text: 'Вариант Б', scores: { r1: 0, r2: 1 } }
			]
		},
		{
			id: 'q2',
			text: 'Вопрос 2',
			type: 'radio',
			options: [
				{ id: 'q2o1', text: 'Вариант А', scores: { r1: 1, r2: 0 } },
				{ id: 'q2o2', text: 'Вариант Б', scores: { r1: 0, r2: 1 } }
			]
		},
		{
			id: 'q3',
			text: 'Вопрос 3',
			type: 'radio',
			options: [
				{ id: 'q3o1', text: 'Вариант А', scores: { r1: 1, r2: 0 } },
				{ id: 'q3o2', text: 'Вариант Б', scores: { r1: 0, r2: 1 } }
			]
		},
		{
			id: 'q4',
			text: 'Вопрос 4',
			type: 'radio',
			options: [
				{ id: 'q4o1', text: 'Вариант А', scores: { r1: 1, r2: 0 } },
				{ id: 'q4o2', text: 'Вариант Б', scores: { r1: 0, r2: 1 } }
			]
		}
	],
	results: [
		{
			id: 'r1',
			title: 'Результат A',
			description: 'Опишите здесь что получит клиент с таким профилем.',
			promoCode: '',
			buttonText: '',
			buttonUrl: ''
		},
		{
			id: 'r2',
			title: 'Результат B',
			description: 'Опишите здесь что получит клиент с таким профилем.',
			promoCode: '',
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

@Injectable()
export class QuizService {
	constructor(
		private prisma: PrismaService,
		private subscriptionService: SubscriptionService,
		private emailService: EmailService
	) {}

	async getMyQuizzes(userId: string) {
		const sub = await this.subscriptionService.checkAndResetPeriod(userId);
		const quizzes = await this.prisma.quiz.findMany({
			where: { userId },
			orderBy: { createdAt: 'desc' },
			include: {
				_count: { select: { leads: true } }
			}
		});

		return { quizzes, subscription: sub };
	}

	async createQuiz(userId: string, dto: CreateQuizDto) {
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

		const publicKey = this.generatePublicKey();

		return this.prisma.quiz.create({
			data: {
				userId,
				publicKey,
				name: dto.name || 'Квиз',
				config: DEFAULT_CONFIG
			}
		});
	}

	async updateQuiz(userId: string, quizId: string, dto: UpdateQuizDto) {
		const quiz = await this.getQuizByIdAndOwner(quizId, userId);

		return this.prisma.quiz.update({
			where: { id: quiz.id },
			data: {
				...(dto.name !== undefined && { name: dto.name }),
				...(dto.isActive !== undefined && { isActive: dto.isActive }),
				...(dto.installDomain !== undefined && {
					installDomain: normalizeInstallDomain(dto.installDomain)
				}),
				...(dto.config !== undefined && {
					config: {
						...(quiz.config as object),
						...dto.config
					}
				})
			}
		});
	}

	async deleteQuiz(userId: string, quizId: string) {
		const quiz = await this.getQuizByIdAndOwner(quizId, userId);
		return this.prisma.quiz.delete({ where: { id: quiz.id } });
	}

	async getLeads(userId: string, quizId: string, page = 1, limit = 50) {
		const quiz = await this.getQuizByIdAndOwner(quizId, userId);

		const skip = (page - 1) * limit;
		const [leads, total] = await Promise.all([
			this.prisma.quizLead.findMany({
				where: { quizId },
				orderBy: { createdAt: 'desc' },
				skip,
				take: limit
			}),
			this.prisma.quizLead.count({ where: { quizId } })
		]);

		return {
			leads: this.normalizeLeadResults(leads, quiz.config),
			total,
			page,
			limit
		};
	}

	async getLeadsStats(userId: string, quizId: string) {
		const quiz = await this.getQuizByIdAndOwner(quizId, userId);

		const sub = await this.subscriptionService.checkAndResetPeriod(userId);
		if (sub?.plan === Plan.EASY) {
			throw new ForbiddenException('Аналитика недоступна на тарифе Easy');
		}

		const grouped = await this.prisma.quizLead.groupBy({
			by: ['result'],
			where: { quizId },
			_count: { id: true },
			orderBy: { _count: { id: 'desc' } }
		});

		const total = grouped.reduce((sum, g) => sum + g._count.id, 0);
		const statsByResult = new Map<string, number>();

		for (const g of grouped) {
			const result =
				this.resolveResultTitle(g.result, quiz.config) || 'Без результата';
			statsByResult.set(
				result,
				(statsByResult.get(result) || 0) + g._count.id
			);
		}

		const stats = Array.from(statsByResult.entries())
			.map(([result, count]) => ({
				result,
				count,
				percent: total > 0 ? Math.round((count / total) * 100) : 0
			}))
			.sort((a, b) => b.count - a.count);

		return { stats, total };
	}

	async exportLeads(
		userId: string,
		quizId: string,
		format: 'csv' | 'xlsx'
	) {
		const quiz = await this.getQuizByIdAndOwner(quizId, userId);

		const sub = await this.subscriptionService.checkAndResetPeriod(userId);
		if (sub?.plan === Plan.EASY) {
			throw new ForbiddenException(
				'Экспорт заявок недоступен на тарифе Easy'
			);
		}

		const leads = await this.prisma.quizLead.findMany({
			where: { quizId },
			orderBy: { createdAt: 'asc' }
		});
		const normalizedLeads = this.normalizeLeadResults(leads, quiz.config);

		const safeName = quiz.name.replace(/[^\wЀ-ӿ\-]/g, '_');

		if (format === 'csv') {
			return {
				data: this.buildCsv(normalizedLeads),
				contentType: 'text/csv; charset=utf-8',
				filename: `quiz_leads_${safeName}.csv`
			};
		}

		const rows = normalizedLeads.map((lead: any, i: number) => ({
			'№': i + 1,
			Дата: new Date(lead.createdAt).toLocaleString('ru-RU'),
			Телефон: lead.phone || lead.contact || '',
			Email: lead.email || '',
			Результат: lead.result || '',
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
			filename: `quiz_leads_${safeName}.xlsx`
		};
	}

	async getPublicConfig(
		publicKey: string,
		ip?: string,
		requestDomain: string | null = null,
		directPageAccessAllowed = false
	): Promise<object | null> {
		const quiz = await this.prisma.quiz.findUnique({
			where: { publicKey },
			include: { user: { include: { subscription: true } } }
		});

		if (!quiz) return null;

		const config = quiz.config as any;
		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(quiz.installDomain, requestDomain)
		) {
			return { isActive: false };
		}

		const sub = quiz.user.subscription;
		const isActive = quiz.isActive && sub?.status === 'ACTIVE';

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

		if (!canAcceptLeads) return { isActive: false };

		let hasPlayedByIp = false;
		if (ip) {
			const cooldownDays = config.quizCooldownDays ?? 0;
			const resetToken = config.quizResetToken || '';
			const since =
				cooldownDays > 0
					? new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000)
					: null;
			const existing = await this.prisma.quizLead.findFirst({
				where: {
					quizId: quiz.id,
					ip,
					quizResetToken: resetToken,
					...(since ? { createdAt: { gte: since } } : {})
				}
			});
			hasPlayedByIp = !!existing;
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
			bubbleEnabled: config.bubbleEnabled !== false,
			bubbleText: config.bubbleText || 'Пройдите квиз!',
			autoOpenDelay: config.autoOpenDelay || null,
			title: config.title || 'Пройдите наш квиз!',
			subtitle: config.subtitle || '',
			buttonText: config.buttonText || 'Начать квиз',
			contactTitle:
				config.contactTitle || 'Оставьте контакт для получения результата',
			dataType: (config.dataType || 'PHONE').toUpperCase(),
			privacyUrl: config.privacyUrl || null,
			developInfoActive: config.developInfoActive !== false,
			alreadyPlayedTitle:
				config.alreadyPlayedTitle || '🎉 Вы уже проходили этот квиз!',
			alreadyPlayedSubtitle:
				config.alreadyPlayedSubtitle ||
				'Каждый посетитель может пройти квиз только один раз',
			hideIfPlayed: config.hideIfPlayed === true,
			quizCooldownDays: config.quizCooldownDays ?? 0,
			quizResetToken: config.quizResetToken || '',
			hasPlayedByIp,
			yandexMetrikaId: config?.integrations?.yandexMetrikaId || null,
			vkPixelId: config?.integrations?.vkPixelId || null,
			roistatEnabled: config?.integrations?.roistatEnabled === true,
			questions: config.questions || [],
			results: config.results || []
		};
	}

	async submitLead(
		dto: SubmitQuizLeadDto,
		ip?: string,
		requestDomain: string | null = null,
		directPageAccessAllowed = false
	) {
		const quiz = await this.prisma.quiz.findUnique({
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

		if (!quiz) throw new NotFoundException('Квиз не найден');

		const check = await this.subscriptionService.canSubmitQuizLead(
			quiz.id
		);
		if (!check.allowed) {
			throw new ForbiddenException(
				'Лимит заявок исчерпан или подписка неактивна'
			);
		}

		const config = quiz.config as any;
		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(quiz.installDomain, requestDomain)
		) {
			throw new ForbiddenException('Домен установки виджета не совпадает');
		}

		if (config?.filterDuplicates) {
			const resetToken = config.quizResetToken || '';
			const orConditions: object[] = [{ contact: dto.contact }];
			if (ip) orConditions.push({ ip });
			const existing = await this.prisma.quizLead.findFirst({
				where: {
					quizId: quiz.id,
					quizResetToken: resetToken,
					OR: orConditions
				}
			});
			if (existing) {
				throw new BadRequestException(
					'Заявка с таким контактом уже существует'
				);
			}
		}

		// Score answers to determine result
		const resultId = this.scoreAnswers(
			dto.answers,
			config.questions || [],
			config.results || []
		);
		const resultData =
			(config.results || []).find((r: any) => r.id === resultId) || null;
		const resultTitle = resultData?.title || resultId;

		const lead = await this.prisma.quizLead.create({
			data: {
				quizId: quiz.id,
				contact: dto.contact,
				phone: dto.phone,
				email: dto.email,
				answers: dto.answers as any,
				result: resultTitle,
				url: dto.url,
				ip: ip || null,
				quizResetToken: config.quizResetToken || ''
			}
		});

		await this.subscriptionService.incrementLeadCount(quiz.userId);

		const sub = quiz.user.subscription;
		if (sub) {
			const limits = PLAN_LIMITS[sub.plan as Plan];
			const newCount = sub.leadsThisPeriod + 1;
			if (!limits.unlimited && newCount === limits.maxLeadsPerPeriod) {
				this.sendLimitReachedNotifications(quiz, config, newCount).catch(
					() => {}
				);
			}
		}

		await this.sendNotifications(quiz, config, dto, resultData);

		return { success: true, lead, result: resultData };
	}

	private scoreAnswers(
		answers: { questionId: string; optionIds: string[] }[],
		questions: any[],
		results: any[]
	): string | null {
		if (!results.length) return null;

		const scores: Record<string, number> = {};
		for (const r of results) scores[r.id] = 0;

		for (const answer of answers) {
			const question = questions.find(
				(q: any) => q.id === answer.questionId
			);
			if (!question) continue;
			for (const optionId of answer.optionIds) {
				const option = question.options?.find(
					(o: any) => o.id === optionId
				);
				if (!option?.scores) continue;
				for (const [resultId, points] of Object.entries(
					option.scores as Record<string, number>
				)) {
					if (resultId in scores) scores[resultId] += points;
				}
			}
		}

		// Winner = result with max score; on tie, first in array
		let winner = results[0].id;
		let maxScore = -Infinity;
		for (const r of results) {
			if ((scores[r.id] ?? 0) > maxScore) {
				maxScore = scores[r.id] ?? 0;
				winner = r.id;
			}
		}
		return winner;
	}

	private async sendNotifications(
		quiz: any,
		config: any,
		dto: SubmitQuizLeadDto,
		resultData: any
	) {
		const resultTitle = resultData?.title || '';

		const notificationEmail = config?.integrations?.email;
		if (notificationEmail) {
			try {
				await this.emailService.sendLeadNotification(notificationEmail, {
					widgetName: quiz.name,
					phone: dto.phone,
					email: dto.email,
					bonus: resultTitle,
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
						name: quiz.name,
						lead: dto.contact,
						phone: dto.phone || null,
						email: dto.email || null,
						result: resultTitle,
						answers: dto.answers,
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
							text: this.buildTelegramMessage({
								quizName: quiz.name,
								phone: dto.phone,
								email: dto.email,
								result: resultTitle,
								url: dto.url,
								date: new Date()
							}),
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
					TITLE: `Заявка с квиза «${quiz.name}»${resultTitle ? ` — ${resultTitle}` : ''}`,
					SOURCE_ID: 'WEB',
					COMMENTS: [
						`Квиз: ${quiz.name}`,
						resultTitle ? `Результат: ${resultTitle}` : '',
						dto.url ? `Страница: ${dto.url}` : ''
					]
						.filter(Boolean)
						.join('\n')
				};
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

				const body: any = [
					{
						name: `Заявка с квиза «${quiz.name}»${resultTitle ? ` — ${resultTitle}` : ''}`,
						_embedded: {
							contacts: [
								{
									...(contactFields.length
										? { custom_fields_values: contactFields }
										: {})
								}
							]
						}
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
			} catch {}
		}
	}

	private async sendLimitReachedNotifications(
		quiz: any,
		config: any,
		limit: number
	) {
		const sentTo = new Set<string>();
		const accountEmail = quiz.user?.authIdentities?.[0]?.value as
			| string
			| undefined;
		const integrationEmail = config?.integrations?.email as
			| string
			| undefined;

		if (accountEmail) {
			try {
				await this.emailService.sendLimitReachedNotification(
					accountEmail,
					quiz.name,
					limit
				);
			} catch {}
			sentTo.add(accountEmail);
		}

		if (integrationEmail && !sentTo.has(integrationEmail)) {
			try {
				await this.emailService.sendLimitReachedNotification(
					integrationEmail,
					quiz.name,
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
								`Квиз <i>${quiz.name}</i> принял последнюю заявку (${limit} из ${limit}).`,
								``,
								`Квиз больше не будет принимать новые заявки.`,
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
		quizName: string;
		phone?: string;
		email?: string;
		result?: string;
		url?: string;
		date: Date;
	}): string {
		const dateStr = data.date.toLocaleString('ru-RU', {
			timeZone: 'Europe/Moscow'
		});
		const lines: string[] = [
			`🎯 <b>Новая заявка с квиза</b>`,
			`<i>${data.quizName}</i>`,
			``,
			`📅 <b>Дата:</b> ${dateStr}`
		];
		if (data.phone) lines.push(`📞 <b>Телефон:</b> ${data.phone}`);
		if (data.email) lines.push(`✉️ <b>Email:</b> ${data.email}`);
		if (data.result) lines.push(`🏆 <b>Результат:</b> ${data.result}`);
		if (data.url) lines.push(`🌐 <b>Страница:</b> ${data.url}`);
		return lines.join('\n');
	}

	private buildCsv(leads: any[]): Buffer {
		const headers = [
			'№',
			'Дата',
			'Телефон',
			'Email',
			'Результат',
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
			l.phone || l.contact || '',
			l.email || '',
			l.result || '',
			l.url || ''
		]);
		const csv = [headers, ...rows]
			.map(r => r.map(esc).join(','))
			.join('\r\n');
		return Buffer.from('﻿' + csv, 'utf-8');
	}

	private normalizeLeadResults<T extends { result: string | null }>(
		leads: T[],
		config: any
	): T[] {
		return leads.map(lead => ({
			...lead,
			result: this.resolveResultTitle(lead.result, config)
		}));
	}

	private resolveResultTitle(result: string | null, config: any) {
		if (!result) return null;

		const results = Array.isArray(config?.results) ? config.results : [];
		const matchedResult = results.find((item: any) => item?.id === result);

		return matchedResult?.title || result;
	}

	private async getQuizByIdAndOwner(quizId: string, userId: string) {
		const quiz = await this.prisma.quiz.findUnique({
			where: { id: quizId }
		});
		if (!quiz) throw new NotFoundException('Квиз не найден');
		if (quiz.userId !== userId)
			throw new ForbiddenException('Нет доступа');
		return quiz;
	}

	private generatePublicKey(): string {
		return randomBytes(6).toString('hex');
	}
}
