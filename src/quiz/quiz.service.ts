import { FileService } from '@/file/file.service';
import { enqueueLeadIntegrationEvents } from '@/messaging/lead-integration-event';
import { enqueueEntityLimitReachedEvent } from '@/messaging/limit-reached-event';
import { PrismaService } from '@/prisma.service';
import { SafeOutboundHttpService } from '@/safe-outbound-http/safe-outbound-http.service';
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

const normalizeQuestions = (value: unknown) => {
	const source = Array.isArray(value) ? value : DEFAULT_CONFIG.questions;

	return source.map(question => {
		const item = toPlainObject(question);
		const options = Array.isArray(item.options)
			? item.options.map(option => {
					const optionItem = toPlainObject(option);
					const scores = toPlainObject(optionItem.scores);

					return {
						...optionItem,
						scores: Object.fromEntries(
							Object.entries(scores).map(([resultId, score]) => [
								resultId,
								clampNumber(score, 0, 10, 0)
							])
						)
					};
				})
			: item.options;

		return { ...item, options };
	});
};

const normalizeQuizConfig = (rawConfig: unknown) => {
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
		quizCooldownDays: clampNumber(
			raw.quizCooldownDays,
			0,
			365,
			DEFAULT_CONFIG.quizCooldownDays
		),
		questions: normalizeQuestions(raw.questions),
		results: Array.isArray(raw.results)
			? raw.results
			: DEFAULT_CONFIG.results,
		integrations: {
			...DEFAULT_CONFIG.integrations,
			...toPlainObject(raw.integrations)
		}
	};
};

@Injectable()
export class QuizService {
	constructor(
		private prisma: PrismaService,
		private subscriptionService: SubscriptionService,
		private fileService: FileService,
		private safeOutboundHttpService: SafeOutboundHttpService
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
		const publicKey = this.generatePublicKey();

		return this.subscriptionService.createWidgetWithinLimit(
			userId,
			transaction =>
				transaction.quiz.create({
					data: {
						userId,
						publicKey,
						name: dto.name || 'Квиз',
						config: DEFAULT_CONFIG
					}
				})
		);
	}

	async updateQuiz(userId: string, quizId: string, dto: UpdateQuizDto) {
		const quiz = await this.getQuizByIdAndOwner(quizId, userId);
		const currentConfig = quiz.config as Record<string, any>;
		const configPatch =
			dto.config !== undefined
				? this.prepareButtonImageConfigPatch(currentConfig, dto.config)
				: undefined;
		const nextConfig =
			configPatch !== undefined
				? normalizeQuizConfig({
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

		const updated = await this.prisma.quiz.update({
			where: { id: quiz.id },
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

	async deleteQuiz(userId: string, quizId: string) {
		const quiz = await this.getQuizByIdAndOwner(quizId, userId);
		await this.fileService.deleteWidgetButtonImage(
			(quiz.config as Record<string, any>).buttonImageUrl
		);
		return this.prisma.quiz.delete({ where: { id: quiz.id } });
	}

	async uploadButtonImage(
		userId: string,
		quizId: string,
		file: Express.Multer.File | undefined
	) {
		const quiz = await this.getQuizByIdAndOwner(quizId, userId);
		await this.assertCanUseButtonImage(userId);

		const currentConfig = quiz.config as Record<string, any>;
		let uploadedUrl = '';

		try {
			const uploadedFile = await this.fileService.saveWidgetButtonImage(
				file,
				'quiz',
				quiz.id
			);
			uploadedUrl = uploadedFile.url;

			const updated = await this.prisma.quiz.update({
				where: { id: quiz.id },
				data: {
					config: normalizeQuizConfig({
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

	async getLeads(userId: string, quizId: string, page = 1, limit = 50) {
		const quiz = await this.getQuizByIdAndOwner(quizId, userId);

		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? limit : 50;
		const skip = (normalizedPage - 1) * normalizedLimit;
		const [leads, total] = await Promise.all([
			this.prisma.quizLead.findMany({
				where: { quizId },
				orderBy: { createdAt: 'desc' },
				skip,
				take: normalizedLimit
			}),
			this.prisma.quizLead.count({ where: { quizId } })
		]);

		return {
			leads: this.normalizeLeadResults(leads, quiz.config),
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
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

		const config = normalizeQuizConfig(quiz.config);
		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(quiz.installDomain, requestDomain)
		) {
			return { isActive: false };
		}

		const sub = await this.subscriptionService.checkAndResetPeriod(
			quiz.userId
		);
		const isActive = quiz.isActive && sub?.status === 'ACTIVE';
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
			buttonImageUrl: this.fileService.getWidgetButtonImageUrl(
				config.buttonImageUrl,
				hasActiveHardSubscription
			),
			hideBranding: hasActiveHardSubscription,
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
			developInfoActive:
				config.developInfoActive !== false && !hasActiveHardSubscription,
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

		if (!quiz.isActive) {
			throw new ForbiddenException(
				'Лимит заявок исчерпан или подписка неактивна'
			);
		}

		const config = normalizeQuizConfig(quiz.config);
		if (
			!directPageAccessAllowed &&
			!isWidgetDomainAllowed(quiz.installDomain, requestDomain)
		) {
			throw new ForbiddenException('Домен установки виджета не совпадает');
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

		const { lead } = await this.subscriptionService.createLeadWithinLimit(
			quiz.userId,
			async transaction => {
				if (config?.filterDuplicates) {
					const resetToken = config.quizResetToken || '';
					const orConditions: object[] = [{ contact: dto.contact }];
					if (ip) orConditions.push({ ip });
					const existing = await transaction.quizLead.findFirst({
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

				const createdLead = await transaction.quizLead.create({
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
				await enqueueLeadIntegrationEvents(transaction, {
					source: 'quiz',
					entity: { id: quiz.id, name: quiz.name },
					lead: {
						id: createdLead.id,
						contact: dto.contact,
						phone: dto.phone,
						email: dto.email,
						answers: dto.answers,
						result: resultTitle,
						url: dto.url,
						createdAt: createdLead.createdAt
					},
					integrations: config.integrations
				});
				return createdLead;
			},
			(transaction, limit) =>
				enqueueEntityLimitReachedEvent(transaction, {
					entity: { id: quiz.id, name: quiz.name, type: 'quiz' },
					limit,
					accountEmail: quiz.user?.authIdentities?.[0]?.value,
					integrationEmail: config?.integrations?.email,
					telegramChatId: config?.integrations?.telegramChatId
				})
		);

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
