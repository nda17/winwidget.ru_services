import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/widgets-client';

export enum WidgetType {
	WHEEL = 'WHEEL',
	QUIZ = 'QUIZ',
	CALLBACK = 'CALLBACK',
	TIMER = 'TIMER',
	STOP_OFFER = 'STOP_OFFER',
	AI_CONSULTANT = 'AI_CONSULTANT',
	CALCULATOR = 'CALCULATOR'
}

export type WidgetTypeSlug =
	| 'wheel'
	| 'quiz'
	| 'callback'
	| 'timer'
	| 'stop-offer'
	| 'ai-consultant'
	| 'calculator';

export interface WidgetEntity {
	id: string;
	userId: string;
	publicKey: string;
	name: string;
	isActive: boolean;
	installDomain: string;
	config: Prisma.JsonValue;
	draftConfig: Prisma.JsonValue | null;
	draftInstallDomain: string | null;
	draftRevision: number;
	publishedVersion: number;
	publishedFromDraftRevision: number;
	publishedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface WidgetDefinition {
	type: WidgetType;
	slug: WidgetTypeSlug;
	collection: string;
	responseCollection: string;
	publicApi: string;
	pagePath: string;
	asset: string;
	autoOpenVariable: string;
	label: string;
	defaultName: string;
	defaultConfig: () => Prisma.InputJsonObject;
}

const INTEGRATIONS = {
	email: '',
	webhookUrl: '',
	telegramChatId: '',
	yandexMetrikaId: '',
	vkPixelId: '',
	bitrix24WebhookUrl: '',
	roistatEnabled: false,
	amoCrmDomain: '',
	amoCrmToken: ''
} satisfies Prisma.InputJsonObject;

const BUTTON = {
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
	autoOpenDelay: null
} satisfies Prisma.InputJsonObject;

const PRIVACY_URL =
	'https://winwidget.ru/legal-documentation/consent-processing';

const definitions: WidgetDefinition[] = [
	{
		type: WidgetType.WHEEL,
		slug: 'wheel',
		collection: 'widgets',
		responseCollection: 'widgets',
		publicApi: 'widget',
		pagePath: 'page-wheel',
		asset: 'wheel.js',
		autoOpenVariable: 'winwidgetAutoOpen',
		label: 'Колесо фортуны',
		defaultName: 'Виджет',
		defaultConfig: () => ({
			...BUTTON,
			glassEffect: false,
			wheelBorderColor: '',
			spinDuration: 5,
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
			privacyUrl: PRIVACY_URL,
			developInfoActive: true,
			buttonText: 'Крутить!',
			filterDuplicates: false,
			textColor: '',
			centerColor: '#ffffff',
			arrowColor: '#ffcc00',
			spinCooldownDays: 0,
			spinResetToken: '',
			actionButton: null,
			bonuses: Array.from({ length: 8 }, (_, index) => ({
				name: `Бонус #${index + 1}`,
				wheelLabel: `Бонус #${index + 1}`,
				active: true,
				probability: 1
			})),
			integrations: { ...INTEGRATIONS }
		})
	},
	{
		type: WidgetType.QUIZ,
		slug: 'quiz',
		collection: 'quizzes',
		responseCollection: 'quizzes',
		publicApi: 'quiz',
		pagePath: 'page-quiz',
		asset: 'quiz.js',
		autoOpenVariable: 'winquizAutoOpen',
		label: 'Квиз',
		defaultName: 'Квиз',
		defaultConfig: () => ({
			...BUTTON,
			bubbleEnabled: true,
			bubbleText: 'Пройдите квиз!',
			title: 'Пройдите наш квиз!',
			subtitle:
				'Ответьте на несколько вопросов и получите персональную рекомендацию',
			buttonText: 'Начать квиз',
			contactTitle: 'Оставьте контакт для получения результата',
			dataType: 'PHONE',
			privacyUrl: PRIVACY_URL,
			developInfoActive: true,
			filterDuplicates: false,
			alreadyPlayedTitle: '🎉 Вы уже проходили этот квиз!',
			alreadyPlayedSubtitle:
				'Каждый посетитель может пройти квиз только один раз',
			hideIfPlayed: false,
			quizCooldownDays: 0,
			quizResetToken: '',
			questions: Array.from({ length: 4 }, (_, index) => ({
				id: `q${index + 1}`,
				text: `Вопрос ${index + 1}`,
				type: 'radio',
				options: [
					{
						id: `q${index + 1}o1`,
						text: 'Вариант А',
						scores: { r1: 1, r2: 0 }
					},
					{
						id: `q${index + 1}o2`,
						text: 'Вариант Б',
						scores: { r1: 0, r2: 1 }
					}
				]
			})),
			results: [
				{
					id: 'r1',
					title: 'Результат A',
					description:
						'Опишите здесь что получит клиент с таким профилем.',
					promoCode: '',
					buttonText: '',
					buttonUrl: ''
				},
				{
					id: 'r2',
					title: 'Результат B',
					description:
						'Опишите здесь что получит клиент с таким профилем.',
					promoCode: '',
					buttonText: '',
					buttonUrl: ''
				}
			],
			integrations: { ...INTEGRATIONS }
		})
	},
	{
		type: WidgetType.CALLBACK,
		slug: 'callback',
		collection: 'callbacks',
		responseCollection: 'callbacks',
		publicApi: 'callback',
		pagePath: 'page-callback',
		asset: 'callback.js',
		autoOpenVariable: 'wincallbackAutoOpen',
		label: 'Обратный звонок',
		defaultName: 'Обратный звонок',
		defaultConfig: () => ({
			...BUTTON,
			verificationMode: 'OFF',
			launcherEnabled: true,
			bubbleEnabled: true,
			bubbleText: 'Перезвоним!',
			title: 'Заказать звонок',
			subtitle: 'Оставьте номер телефона — мы перезвоним в удобное время',
			submitButtonText: 'Заказать звонок',
			successTitle: 'Спасибо! Мы перезвоним',
			successSubtitle: 'Ожидайте звонка в выбранное время',
			privacyUrl: PRIVACY_URL,
			developInfoActive: true,
			filterDuplicates: false,
			timeSlots: [
				'9:00–11:00',
				'11:00–13:00',
				'13:00–15:00',
				'15:00–17:00',
				'17:00–19:00'
			],
			integrations: { ...INTEGRATIONS }
		})
	},
	{
		type: WidgetType.TIMER,
		slug: 'timer',
		collection: 'countdown-timers',
		responseCollection: 'countdownTimers',
		publicApi: 'countdown-timer',
		pagePath: 'page-timer',
		asset: 'timer.js',
		autoOpenVariable: 'wintimerAutoOpen',
		label: 'Таймер',
		defaultName: 'Таймер',
		defaultConfig: () => ({
			...BUTTON,
			bubbleText: 'Акция',
			title: 'Скидка ограничена по времени',
			subtitle:
				'Успейте воспользоваться предложением до окончания таймера',
			timerMode: 'EVERGREEN',
			deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
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
			privacyUrl: PRIVACY_URL,
			developInfoActive: true,
			filterDuplicates: false,
			submissionCooldownDays: 0,
			timerResetToken: '',
			integrations: { ...INTEGRATIONS }
		})
	},
	{
		type: WidgetType.STOP_OFFER,
		slug: 'stop-offer',
		collection: 'stop-offers',
		responseCollection: 'stopOffers',
		publicApi: 'stop-offer',
		pagePath: 'page-stop-offer',
		asset: 'stop-offer.js',
		autoOpenVariable: 'winstopofferAutoOpen',
		label: 'Стоп-оффер',
		defaultName: 'Стоп-оффер',
		defaultConfig: () => ({
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
			subtitle:
				'Оставьте контакт или перейдите к предложению прямо сейчас',
			offerText: 'Скидка 10%',
			dataType: 'PHONE',
			contactTitle: 'Куда отправить скидку?',
			submitButtonText: 'Забрать скидку',
			successTitle: 'Спасибо! Скидка закреплена',
			successSubtitle: 'Мы скоро свяжемся с вами',
			actionButtonEnabled: false,
			actionButtonText: 'Перейти к акции',
			actionButtonUrl: '',
			privacyUrl: PRIVACY_URL,
			developInfoActive: true,
			filterDuplicates: true,
			submissionCooldownDays: 0,
			submissionResetToken: '',
			integrations: { ...INTEGRATIONS }
		})
	},
	{
		type: WidgetType.AI_CONSULTANT,
		slug: 'ai-consultant',
		collection: 'ai-consultants',
		responseCollection: 'aiConsultants',
		publicApi: 'ai-consultant',
		pagePath: 'page-ai-consultant',
		asset: 'ai-consultant.js',
		autoOpenVariable: 'winAiConsultantAutoOpen',
		label: 'AI-консультант',
		defaultName: 'AI-консультант',
		defaultConfig: () => ({
			...BUTTON,
			color: '#4705fb',
			bgColor: '#ffffff',
			textColor: '#1f2937',
			bubbleEnabled: false,
			bubbleText: '',
			operatorName: 'Alex',
			greeting:
				'Здравствуйте! Я Alex, AI-оператор.\nГотов помочь и ответить на ваши вопросы о товарах, услугах и условиях компании.',
			instructionsPrompt: '',
			privacyUrl: PRIVACY_URL,
			inactivityTimeoutMinutes: 10,
			farewellMessage:
				'Я не дождался ответа. Если у вас появятся вопросы, напишите снова — я обязательно помогу.',
			inputPlaceholder: 'Задайте вопрос...',
			developInfoActive: true,
			buttonPulse: true
		})
	},
	{
		type: WidgetType.CALCULATOR,
		slug: 'calculator',
		collection: 'calculators',
		responseCollection: 'calculators',
		publicApi: 'calculator',
		pagePath: 'page-calculator',
		asset: 'calculator.js',
		autoOpenVariable: 'wincalculatorAutoOpen',
		label: 'Калькулятор',
		defaultName: 'Калькулятор',
		defaultConfig: () => ({
			...BUTTON,
			glassEffect: false,
			textColor: '',
			bubbleEnabled: true,
			bubbleText: 'Рассчитайте стоимость!',
			title: 'Калькулятор стоимости',
			subtitle: 'Выберите параметры и узнайте ориентировочную стоимость',
			calculateButtonText: 'Рассчитать',
			contactTitle: 'Оставьте контакт для получения расчёта',
			resultTitle: 'Ориентировочная стоимость',
			dataType: 'NONE',
			privacyUrl: PRIVACY_URL,
			developInfoActive: true,
			filterDuplicates: false,
			basePrice: 1000,
			currency: 'RUB',
			roundingStep: 1,
			fields: [
				{
					id: 'service',
					label: 'Тип услуги',
					type: 'select',
					required: true,
					options: [
						{ id: 'standard', label: 'Стандарт', add: 0, multiplier: 1 },
						{ id: 'premium', label: 'Премиум', add: 1000, multiplier: 1 }
					]
				},
				{
					id: 'quantity',
					label: 'Количество',
					type: 'number',
					required: true,
					min: 1,
					max: 1000,
					step: 1,
					defaultValue: 1,
					unit: 'шт.',
					unitPrice: 100
				},
				{
					id: 'extras',
					label: 'Дополнительные услуги',
					type: 'checkbox',
					required: false,
					options: [
						{ id: 'delivery', label: 'Доставка', add: 500, multiplier: 1 }
					]
				}
			],
			integrations: { ...INTEGRATIONS }
		})
	}
];

export const WIDGET_DEFINITIONS =
	definitions as readonly WidgetDefinition[];

export const getWidgetDefinition = (
	type: WidgetType
): WidgetDefinition => {
	const definition = definitions.find(item => item.type === type);
	if (!definition)
		throw new BadRequestException('Некорректный тип виджета');
	return definition;
};

export const parseWidgetType = (value: string): WidgetType => {
	const normalized = value.trim().toLowerCase();
	const definition = definitions.find(
		item =>
			item.slug === normalized ||
			item.collection === normalized ||
			item.publicApi === normalized ||
			item.type.toLowerCase() === normalized ||
			(normalized === 'countdown_timer' &&
				item.type === WidgetType.TIMER) ||
			(normalized === 'countdown-timer' && item.type === WidgetType.TIMER)
	);
	if (!definition)
		throw new BadRequestException('Некорректный тип виджета');
	return definition.type;
};

export const parsePublicWidgetApiType = (value: string): WidgetType => {
	const normalized = value.trim().toLowerCase();
	const definition = definitions.find(
		item =>
			(item.type === WidgetType.WHEEL ? item.slug : item.publicApi) ===
			normalized
	);
	if (!definition)
		throw new BadRequestException('Некорректный тип виджета');
	return definition.type;
};

export const getDraftConfig = (entity: WidgetEntity): Prisma.JsonValue =>
	entity.draftConfig ?? entity.config;

export const getDraftInstallDomain = (entity: WidgetEntity): string =>
	entity.draftInstallDomain ?? entity.installDomain;

export const hasUnpublishedChanges = (entity: WidgetEntity): boolean =>
	entity.publishedVersion === 0 ||
	entity.draftRevision !== entity.publishedFromDraftRevision;

export const lifecycleStatus = (entity: WidgetEntity) => {
	if (entity.publishedVersion === 0) return 'DRAFT_ONLY' as const;
	if (hasUnpublishedChanges(entity)) return 'CHANGES_PENDING' as const;
	if (!entity.isActive) return 'INACTIVE' as const;
	return 'PUBLISHED' as const;
};

export const projectWidgetDraft = (entity: WidgetEntity) => {
	const rest: Partial<WidgetEntity> = { ...entity };
	delete rest.draftConfig;
	delete rest.draftInstallDomain;
	return {
		...rest,
		config: getDraftConfig(entity),
		installDomain: getDraftInstallDomain(entity),
		status: lifecycleStatus(entity),
		hasUnpublishedChanges: hasUnpublishedChanges(entity)
	};
};

export const assertExpectedDraftRevision = (
	entity: WidgetEntity,
	expected: number | undefined
): void => {
	if (expected === undefined || entity.draftRevision !== expected) {
		throw new ConflictException(
			'Настройки уже изменены в другой сессии. Обновите страницу'
		);
	}
};

export const asJsonObject = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

export const toInputJson = (value: unknown): Prisma.InputJsonObject =>
	JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
