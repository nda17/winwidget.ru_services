import { FileService } from '@/file/file.service';
import { PrismaService } from '@/prisma.service';
import { SubscriptionService } from '@/subscription/subscription.service';
import { cleanupUnreferencedWidgetButtonImage } from '@/widget-domain/widget-button-image-lifecycle';
import {
	assertExpectedDraftRevision,
	getWidgetDraftConfig,
	getWidgetDraftInstallDomain,
	hasWidgetUnpublishedChanges,
	projectWidgetDraft,
	WidgetLifecycleEntity,
	WidgetType,
	widgetTypeToSlug
} from '@/widget-domain/widget-lifecycle';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';

export interface WidgetReadinessItem {
	code: string;
	message: string;
}

export interface WidgetReadiness {
	ready: boolean;
	blockers: WidgetReadinessItem[];
	warnings: WidgetReadinessItem[];
}

interface WidgetUpdateResult {
	count: number;
}

type WidgetPersistenceClient = Pick<
	Prisma.TransactionClient,
	| 'widget'
	| 'quiz'
	| 'callback'
	| 'countdownTimer'
	| 'stopOffer'
	| 'onlineConsultant'
	| 'calculator'
	| 'widgetConfigRevision'
>;

const WIDGET_TRANSACTION_OPTIONS = {
	isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
	maxWait: 5000,
	timeout: 10000
} as const;

@Injectable()
export class WidgetSettingsService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly subscriptionService: SubscriptionService,
		private readonly fileService: FileService
	) {}

	async getState(type: WidgetType, widgetId: string, userId: string) {
		const entity = await this.getOwnedEntity(
			this.prisma,
			type,
			widgetId,
			userId
		);
		return this.serializeState(type, entity);
	}

	async publish(
		type: WidgetType,
		widgetId: string,
		userId: string,
		expectedDraftRevision: number
	) {
		await this.runLifecycleTransaction(async transaction => {
			const entity = await this.getOwnedEntity(
				transaction,
				type,
				widgetId,
				userId
			);
			assertExpectedDraftRevision(entity, expectedDraftRevision);
			if (!hasWidgetUnpublishedChanges(entity)) {
				throw new BadRequestException(
					'В черновике нет изменений для публикации'
				);
			}

			const readiness = this.getReadiness(type, entity);
			if (!readiness.ready) {
				throw new BadRequestException({
					message: 'Виджет пока не готов к публикации',
					readiness
				});
			}

			const nextVersion = (entity.publishedVersion ?? 0) + 1;
			await transaction.widgetConfigRevision.create({
				data: {
					widgetType: type,
					widgetId,
					version: nextVersion,
					config: this.toInputJson(getWidgetDraftConfig(entity)),
					installDomain: getWidgetDraftInstallDomain(entity)
				}
			});

			const result = await this.updateMany(
				transaction,
				type,
				{
					id: widgetId,
					userId,
					draftRevision: expectedDraftRevision,
					publishedVersion: entity.publishedVersion ?? 0
				},
				{
					config: this.toInputJson(getWidgetDraftConfig(entity)),
					installDomain: getWidgetDraftInstallDomain(entity),
					publishedVersion: nextVersion,
					publishedFromDraftRevision: expectedDraftRevision,
					publishedAt: new Date()
				}
			);
			this.assertSingleUpdate(result);
		});

		return this.getState(type, widgetId, userId);
	}

	async getVersions(
		type: WidgetType,
		widgetId: string,
		userId: string,
		page = 1,
		limit = 20
	) {
		await this.getOwnedEntity(this.prisma, type, widgetId, userId);
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const where = { widgetType: type, widgetId };
		const [items, total] = await this.prisma.$transaction([
			this.prisma.widgetConfigRevision.findMany({
				where,
				orderBy: { version: 'desc' },
				skip: (normalizedPage - 1) * normalizedLimit,
				take: normalizedLimit,
				select: {
					version: true,
					sourceVersion: true,
					createdAt: true
				}
			}),
			this.prisma.widgetConfigRevision.count({ where })
		]);

		return {
			items,
			page: normalizedPage,
			limit: normalizedLimit,
			total,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async restoreVersion(
		type: WidgetType,
		widgetId: string,
		version: number,
		userId: string,
		expectedDraftRevision: number
	) {
		let previousDraftImageUrl: unknown;
		await this.runLifecycleTransaction(async transaction => {
			const entity = await this.getOwnedEntity(
				transaction,
				type,
				widgetId,
				userId
			);
			assertExpectedDraftRevision(entity, expectedDraftRevision);
			previousDraftImageUrl = this.getButtonImageUrl(
				getWidgetDraftConfig(entity)
			);

			const revision = await transaction.widgetConfigRevision.findUnique({
				where: {
					widgetType_widgetId_version: {
						widgetType: type,
						widgetId,
						version
					}
				}
			});
			if (!revision) {
				throw new NotFoundException('Версия виджета не найдена');
			}

			const result = await this.updateMany(
				transaction,
				type,
				{
					id: widgetId,
					userId,
					draftRevision: expectedDraftRevision
				},
				{
					draftConfig: revision.config,
					draftInstallDomain: revision.installDomain,
					draftRevision: { increment: 1 }
				}
			);
			this.assertSingleUpdate(result);
		});
		await cleanupUnreferencedWidgetButtonImage(
			this.prisma,
			this.fileService,
			type,
			widgetId,
			previousDraftImageUrl
		);

		return this.getState(type, widgetId, userId);
	}

	async discardDraft(
		type: WidgetType,
		widgetId: string,
		userId: string,
		expectedDraftRevision: number
	) {
		let previousDraftImageUrl: unknown;
		await this.runLifecycleTransaction(async transaction => {
			const entity = await this.getOwnedEntity(
				transaction,
				type,
				widgetId,
				userId
			);
			assertExpectedDraftRevision(entity, expectedDraftRevision);
			previousDraftImageUrl = this.getButtonImageUrl(
				getWidgetDraftConfig(entity)
			);
			const nextDraftRevision = expectedDraftRevision + 1;

			const result = await this.updateMany(
				transaction,
				type,
				{
					id: widgetId,
					userId,
					draftRevision: expectedDraftRevision
				},
				{
					draftConfig: this.toInputJson(entity.config),
					draftInstallDomain: entity.installDomain,
					draftRevision: nextDraftRevision,
					...(entity.publishedVersion
						? { publishedFromDraftRevision: nextDraftRevision }
						: {})
				}
			);
			this.assertSingleUpdate(result);
		});
		await cleanupUnreferencedWidgetButtonImage(
			this.prisma,
			this.fileService,
			type,
			widgetId,
			previousDraftImageUrl
		);

		return this.getState(type, widgetId, userId);
	}

	async clone(
		type: WidgetType,
		widgetId: string,
		userId: string,
		requestedName?: string
	) {
		const source = await this.getOwnedEntity(
			this.prisma,
			type,
			widgetId,
			userId
		);
		const { config: clonedConfig, buttonImageRemoved } =
			this.prepareCloneConfig(getWidgetDraftConfig(source));
		const name = this.getCloneName(source.name, requestedName);
		const installDomain = getWidgetDraftInstallDomain(source);

		const cloned = await this.subscriptionService.createWidgetWithinLimit(
			userId,
			transaction =>
				this.createWidget(transaction, type, {
					userId,
					publicKey: this.generatePublicKey(),
					name,
					isActive: false,
					config: clonedConfig,
					installDomain: '',
					draftConfig: clonedConfig,
					draftInstallDomain: installDomain,
					draftRevision: 1,
					publishedVersion: 0,
					publishedFromDraftRevision: 0,
					publishedAt: null
				})
		);

		return {
			id: cloned.id,
			type: widgetTypeToSlug(type),
			name: cloned.name,
			...(buttonImageRemoved && {
				warning:
					'Пользовательское изображение кнопки не скопировано. Загрузите его заново'
			})
		};
	}

	private serializeState(type: WidgetType, entity: WidgetLifecycleEntity) {
		const projected = projectWidgetDraft(entity);

		return {
			type: widgetTypeToSlug(type),
			id: projected.id,
			name: projected.name,
			isActive: projected.isActive,
			publicKey: projected.publicKey,
			installDomain: projected.installDomain,
			config: projected.config,
			createdAt: projected.createdAt,
			updatedAt: projected.updatedAt,
			draftRevision: projected.draftRevision,
			publishedVersion: projected.publishedVersion,
			publishedFromDraftRevision: projected.publishedFromDraftRevision,
			publishedAt: projected.publishedAt,
			status: projected.status,
			hasUnpublishedChanges: projected.hasUnpublishedChanges,
			readiness: this.getReadiness(type, entity)
		};
	}

	private getReadiness(
		type: WidgetType,
		entity: WidgetLifecycleEntity
	): WidgetReadiness {
		const blockers: WidgetReadinessItem[] = [];
		const warnings: WidgetReadinessItem[] = [];
		const config = getWidgetDraftConfig(entity);
		const installDomain = getWidgetDraftInstallDomain(entity).trim();
		const configRecord =
			config && typeof config === 'object' && !Array.isArray(config)
				? (config as Record<string, unknown>)
				: null;

		if (!configRecord) {
			blockers.push({
				code: 'CONFIG_REQUIRED',
				message: 'Заполните настройки виджета'
			});
		} else {
			this.appendConfigurationReadiness(type, configRecord, blockers);
		}
		if (!installDomain) {
			warnings.push({
				code: 'INSTALL_DOMAIN_REQUIRED',
				message:
					'Домен не указан — виджет будет работать только по прямой ссылке'
			});
		}
		if ((entity.publishedVersion ?? 0) === 0) {
			warnings.push({
				code: 'NOT_PUBLISHED',
				message: 'Виджет ещё не опубликован'
			});
		}
		if (!entity.isActive) {
			warnings.push({
				code: 'INACTIVE',
				message: 'Виджет выключен'
			});
		}

		return {
			ready: blockers.length === 0,
			blockers,
			warnings
		};
	}

	private appendConfigurationReadiness(
		type: WidgetType,
		config: Record<string, unknown>,
		blockers: WidgetReadinessItem[]
	) {
		if (type === WidgetType.QUIZ) {
			this.appendQuizReadiness(config, blockers);
		}

		const rawDataType =
			typeof config.dataType === 'string'
				? config.dataType.trim().toUpperCase()
				: '';
		const allowedDataTypes = new Set([
			'PHONE',
			'EMAIL',
			'PHONE_AND_EMAIL',
			'NONE'
		]);
		const dataType = type === WidgetType.CALLBACK ? 'PHONE' : rawDataType;

		if (type !== WidgetType.CALLBACK && !allowedDataTypes.has(dataType)) {
			blockers.push({
				code: 'CONTACT_METHOD_REQUIRED',
				message: 'Выберите способ связи с клиентом'
			});
		}

		const collectsContacts =
			type === WidgetType.CALLBACK ||
			(allowedDataTypes.has(dataType) && dataType !== 'NONE');
		if (
			collectsContacts &&
			type !== WidgetType.QUIZ &&
			!this.hasSuccessMessage(type, config)
		) {
			blockers.push({
				code: 'SUCCESS_MESSAGE_REQUIRED',
				message: 'Заполните сообщение после отправки формы'
			});
		}
		if (collectsContacts && !this.isHttpUrl(config.privacyUrl)) {
			blockers.push({
				code: 'CONSENT_REQUIRED',
				message: 'Укажите ссылку на согласие на обработку данных'
			});
		}

		if (
			type === WidgetType.STOP_OFFER &&
			config.desktopExitIntent !== true &&
			!this.isPositiveNumber(config.mobileAutoOpenDelay) &&
			!this.isPositiveNumber(config.scrollPercent)
		) {
			blockers.push({
				code: 'DISPLAY_SCENARIO_REQUIRED',
				message: 'Выберите хотя бы один сценарий показа виджета'
			});
		}
	}

	private appendQuizReadiness(
		config: Record<string, unknown>,
		blockers: WidgetReadinessItem[]
	) {
		const questions = config.questions;
		const results = config.results;

		if (!Array.isArray(questions) || questions.length === 0) {
			blockers.push({
				code: 'QUIZ_QUESTIONS_REQUIRED',
				message: 'Добавьте хотя бы один вопрос'
			});
		}

		const resultIds = this.getValidQuizResultIds(results, blockers);
		if (!Array.isArray(questions) || questions.length === 0) return;

		const questionIds = new Set<string>();
		questions.forEach((question, questionIndex) => {
			const questionNumber = questionIndex + 1;
			if (!this.isRecord(question)) {
				blockers.push({
					code: 'QUIZ_QUESTION_INVALID',
					message: `Вопрос ${questionNumber}: заполните настройки вопроса`
				});
				return;
			}

			const questionId = this.getUniqueQuizId(question.id, questionIds);
			if (!questionId) {
				blockers.push({
					code: 'QUIZ_QUESTION_INVALID',
					message: `Вопрос ${questionNumber}: пересоздайте вопрос`
				});
			}
			if (!this.hasText(question.text)) {
				blockers.push({
					code: 'QUIZ_QUESTION_TEXT_REQUIRED',
					message: `Вопрос ${questionNumber}: заполните текст вопроса`
				});
			}

			const options = question.options;
			if (!Array.isArray(options) || options.length < 2) {
				blockers.push({
					code: 'QUIZ_OPTIONS_REQUIRED',
					message: `Вопрос ${questionNumber}: добавьте минимум два варианта ответа`
				});
				return;
			}

			const optionIds = new Set<string>();
			options.forEach((option, optionIndex) => {
				const optionNumber = optionIndex + 1;
				if (!this.isRecord(option)) {
					blockers.push({
						code: 'QUIZ_OPTION_INVALID',
						message: `Вопрос ${questionNumber}, вариант ${optionNumber}: заполните настройки варианта`
					});
					return;
				}

				if (!this.getUniqueQuizId(option.id, optionIds)) {
					blockers.push({
						code: 'QUIZ_OPTION_INVALID',
						message: `Вопрос ${questionNumber}, вариант ${optionNumber}: пересоздайте вариант`
					});
				}
				if (!this.hasText(option.text)) {
					blockers.push({
						code: 'QUIZ_OPTION_TEXT_REQUIRED',
						message: `Вопрос ${questionNumber}, вариант ${optionNumber}: заполните текст`
					});
				}

				if (
					resultIds &&
					!this.hasValidQuizScores(option.scores, resultIds)
				) {
					blockers.push({
						code: 'QUIZ_RESULT_LINKS_INVALID',
						message: `Вопрос ${questionNumber}, вариант ${optionNumber}: проверьте связи с результатами`
					});
				}
			});
		});
	}

	private getValidQuizResultIds(
		value: unknown,
		blockers: WidgetReadinessItem[]
	): Set<string> | null {
		if (!Array.isArray(value) || value.length < 2) {
			blockers.push({
				code: 'QUIZ_RESULTS_REQUIRED',
				message: 'Добавьте минимум два результата'
			});
			return null;
		}

		const resultIds = new Set<string>();
		let structurallyValid = true;
		value.forEach((result, resultIndex) => {
			const resultNumber = resultIndex + 1;
			if (!this.isRecord(result)) {
				structurallyValid = false;
				blockers.push({
					code: 'QUIZ_RESULT_INVALID',
					message: `Результат ${resultNumber}: заполните настройки результата`
				});
				return;
			}

			if (!this.getUniqueQuizId(result.id, resultIds)) {
				structurallyValid = false;
				blockers.push({
					code: 'QUIZ_RESULT_INVALID',
					message: `Результат ${resultNumber}: пересоздайте результат`
				});
			}
			if (!this.hasText(result.title)) {
				structurallyValid = false;
				blockers.push({
					code: 'QUIZ_RESULT_TITLE_REQUIRED',
					message: `Результат ${resultNumber}: заполните заголовок`
				});
			}
		});

		return structurallyValid ? resultIds : null;
	}

	private getUniqueQuizId(value: unknown, seenIds: Set<string>) {
		if (!this.hasText(value)) return null;

		const id = (value as string).trim();
		if (seenIds.has(id)) return null;
		seenIds.add(id);
		return id;
	}

	private hasValidQuizScores(value: unknown, resultIds: Set<string>) {
		if (!this.isRecord(value)) return false;

		const scoreKeys = Object.keys(value);
		if (scoreKeys.some(resultId => !resultIds.has(resultId))) return false;

		return [...resultIds].every(
			resultId =>
				Object.prototype.hasOwnProperty.call(value, resultId) &&
				Number.isFinite(Number(value[resultId]))
		);
	}

	private hasSuccessMessage(
		type: WidgetType,
		config: Record<string, unknown>
	) {
		switch (type) {
			case WidgetType.WHEEL:
				return this.hasText(config.winMessage);
			case WidgetType.QUIZ:
				return Array.isArray(config.results) && config.results.length > 0;
			case WidgetType.CALCULATOR:
				return this.hasText(config.resultTitle);
			case WidgetType.CALLBACK:
			case WidgetType.TIMER:
			case WidgetType.STOP_OFFER:
			case WidgetType.ONLINE_CONSULTANT:
				return this.hasText(config.successTitle);
		}

		return false;
	}

	private hasText(value: unknown) {
		return typeof value === 'string' && value.trim().length > 0;
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return (
			Boolean(value) && typeof value === 'object' && !Array.isArray(value)
		);
	}

	private isPositiveNumber(value: unknown) {
		return Number.isFinite(Number(value)) && Number(value) > 0;
	}

	private isHttpUrl(value: unknown) {
		if (!this.hasText(value)) return false;

		try {
			const url = new URL(value as string);
			return url.protocol === 'http:' || url.protocol === 'https:';
		} catch {
			return false;
		}
	}

	private async getOwnedEntity(
		client: WidgetPersistenceClient,
		type: WidgetType,
		widgetId: string,
		userId: string
	): Promise<WidgetLifecycleEntity> {
		const entity = await this.findWidget(client, type, {
			id: widgetId,
			userId
		});
		if (!entity) throw new NotFoundException('Виджет не найден');
		return entity;
	}

	private findWidget(
		client: WidgetPersistenceClient,
		type: WidgetType,
		where: { id: string; userId: string }
	): Promise<WidgetLifecycleEntity | null> {
		switch (type) {
			case WidgetType.WHEEL:
				return client.widget.findFirst({
					where
				}) as unknown as Promise<WidgetLifecycleEntity | null>;
			case WidgetType.QUIZ:
				return client.quiz.findFirst({
					where
				}) as unknown as Promise<WidgetLifecycleEntity | null>;
			case WidgetType.CALLBACK:
				return client.callback.findFirst({
					where
				}) as unknown as Promise<WidgetLifecycleEntity | null>;
			case WidgetType.TIMER:
				return client.countdownTimer.findFirst({
					where
				}) as unknown as Promise<WidgetLifecycleEntity | null>;
			case WidgetType.STOP_OFFER:
				return client.stopOffer.findFirst({
					where
				}) as unknown as Promise<WidgetLifecycleEntity | null>;
			case WidgetType.ONLINE_CONSULTANT:
				return client.onlineConsultant.findFirst({
					where
				}) as unknown as Promise<WidgetLifecycleEntity | null>;
			case WidgetType.CALCULATOR:
				return client.calculator.findFirst({
					where
				}) as unknown as Promise<WidgetLifecycleEntity | null>;
		}
	}

	private updateMany(
		client: WidgetPersistenceClient,
		type: WidgetType,
		where: Record<string, unknown>,
		data: Record<string, unknown>
	): Promise<WidgetUpdateResult> {
		switch (type) {
			case WidgetType.WHEEL:
				return client.widget.updateMany({
					where,
					data
				} as Prisma.WidgetUpdateManyArgs);
			case WidgetType.QUIZ:
				return client.quiz.updateMany({
					where,
					data
				} as Prisma.QuizUpdateManyArgs);
			case WidgetType.CALLBACK:
				return client.callback.updateMany({
					where,
					data
				} as Prisma.CallbackUpdateManyArgs);
			case WidgetType.TIMER:
				return client.countdownTimer.updateMany({
					where,
					data
				} as Prisma.CountdownTimerUpdateManyArgs);
			case WidgetType.STOP_OFFER:
				return client.stopOffer.updateMany({
					where,
					data
				} as Prisma.StopOfferUpdateManyArgs);
			case WidgetType.ONLINE_CONSULTANT:
				return client.onlineConsultant.updateMany({
					where,
					data
				} as Prisma.OnlineConsultantUpdateManyArgs);
			case WidgetType.CALCULATOR:
				return client.calculator.updateMany({
					where,
					data
				} as Prisma.CalculatorUpdateManyArgs);
		}
	}

	private createWidget(
		client: Prisma.TransactionClient,
		type: WidgetType,
		data: {
			userId: string;
			publicKey: string;
			name: string;
			isActive: boolean;
			config: Prisma.InputJsonValue;
			installDomain: string;
			draftConfig: Prisma.InputJsonValue;
			draftInstallDomain: string;
			draftRevision: number;
			publishedVersion: number;
			publishedFromDraftRevision: number;
			publishedAt: null;
		}
	): Promise<WidgetLifecycleEntity> {
		switch (type) {
			case WidgetType.WHEEL:
				return client.widget.create({
					data
				}) as unknown as Promise<WidgetLifecycleEntity>;
			case WidgetType.QUIZ:
				return client.quiz.create({
					data
				}) as unknown as Promise<WidgetLifecycleEntity>;
			case WidgetType.CALLBACK:
				return client.callback.create({
					data
				}) as unknown as Promise<WidgetLifecycleEntity>;
			case WidgetType.TIMER:
				return client.countdownTimer.create({
					data
				}) as unknown as Promise<WidgetLifecycleEntity>;
			case WidgetType.STOP_OFFER:
				return client.stopOffer.create({
					data
				}) as unknown as Promise<WidgetLifecycleEntity>;
			case WidgetType.ONLINE_CONSULTANT:
				return client.onlineConsultant.create({
					data
				}) as unknown as Promise<WidgetLifecycleEntity>;
			case WidgetType.CALCULATOR:
				return client.calculator.create({
					data
				}) as unknown as Promise<WidgetLifecycleEntity>;
		}
	}

	private assertSingleUpdate(result: WidgetUpdateResult) {
		if (result.count !== 1) {
			throw new ConflictException(
				'Настройки уже изменены в другой сессии. Обновите страницу'
			);
		}
	}

	private prepareCloneConfig(value: unknown) {
		const config = this.cloneJson(value);
		const buttonImageRemoved =
			typeof config.buttonImageUrl === 'string' &&
			config.buttonImageUrl.trim().length > 0;

		if (buttonImageRemoved) config.buttonImageUrl = '';

		return {
			config: this.toInputJson(config),
			buttonImageRemoved
		};
	}

	private cloneJson(value: unknown): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return {};
		}
		return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
	}

	private getButtonImageUrl(config: unknown) {
		if (!config || typeof config !== 'object' || Array.isArray(config)) {
			return '';
		}
		return (config as Record<string, unknown>).buttonImageUrl;
	}

	private toInputJson(value: unknown): Prisma.InputJsonValue {
		return this.cloneJson(value) as Prisma.InputJsonValue;
	}

	private getCloneName(sourceName: string, requestedName?: string) {
		const normalizedName = requestedName?.trim();
		if (normalizedName) return normalizedName;

		const suffix = ' — копия';
		return `${sourceName.slice(0, 50 - suffix.length)}${suffix}`;
	}

	private generatePublicKey() {
		return randomBytes(6).toString('hex');
	}

	private async runLifecycleTransaction(
		operation: (transaction: Prisma.TransactionClient) => Promise<void>
	) {
		try {
			await this.prisma.$transaction(
				transaction => operation(transaction),
				WIDGET_TRANSACTION_OPTIONS
			);
		} catch (error) {
			if (
				error instanceof Prisma.PrismaClientKnownRequestError &&
				(error.code === 'P2002' || error.code === 'P2034')
			) {
				throw new ConflictException(
					'Настройки уже изменены в другой сессии. Обновите страницу'
				);
			}
			throw error;
		}
	}
}
