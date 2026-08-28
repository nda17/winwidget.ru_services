import { BadRequestException, Injectable } from '@nestjs/common';
import { asJsonObject, WidgetType } from './widgets-domain.types';
import type { WidgetLeadRecord } from './widgets-domain.repository';
import { calculatorWidgetAdapter } from './widgets-calculator.adapter';
import {
	assertContact,
	brandingPublicFields,
	buttonPublicFields,
	cooldownSince,
	dataType,
	DuplicateLeadRule,
	emptyStats,
	integrationPublicFields,
	normalizeEmail,
	normalizePhone,
	numberValue,
	PreparedWidgetLead,
	PublicDuplicateRule,
	stringValue,
	toInputJson,
	unchangedLead,
	WidgetExportSpec,
	WidgetLeadInput,
	WidgetPublicContext,
	WidgetTypeAdapter
} from './widgets-type-adapter';

const rawPhone = (value: unknown) =>
	typeof value === 'string' && value.trim()
		? value.trim().slice(0, 200)
		: undefined;

const contactInput = (
	input: WidgetLeadInput,
	config: Record<string, unknown>,
	phoneNormalizer: (value: unknown) => string | undefined = rawPhone,
	allowNone = false,
	allowNameFallback = true
) => {
	const phone = phoneNormalizer(input.phone);
	const email = normalizeEmail(input.email);
	const contactType = dataType(config);
	if (!(allowNone && contactType === 'NONE')) {
		assertContact(contactType, phone, email);
	}
	return {
		phone,
		email,
		contact:
			phone ||
			email ||
			(allowNameFallback ? input.name?.trim().slice(0, 200) : undefined) ||
			'unknown'
	};
};

const commonLeadExport = (
	filenamePrefix: string,
	headers: string[],
	leads: WidgetLeadRecord[],
	row: (lead: WidgetLeadRecord, index: number) => unknown[]
): WidgetExportSpec => ({
	filenamePrefix,
	headers,
	rows: leads.map(row)
});

const resolveQuizResultTitle = (
	result: string,
	config: Record<string, unknown>
): string => {
	const results = Array.isArray(config.results)
		? config.results.map(asJsonObject)
		: [];
	const match = results.find(item => item.id === result);
	return match?.title ? String(match.title) : result;
};

const wheelAdapter: WidgetTypeAdapter = {
	type: WidgetType.WHEEL,
	publicConfig(config, context: WidgetPublicContext) {
		const contactType = dataType(config);
		const subtitle =
			stringValue(config.subtitle) ||
			(contactType === 'EMAIL'
				? 'Введите свою почту, чтобы выиграть приз'
				: contactType === 'PHONE_AND_EMAIL'
					? 'Введите свой номер телефона и почту, чтобы выиграть приз'
					: contactType === 'NONE'
						? 'Крутите барабан, чтобы выиграть приз'
						: 'Введите свой номер телефона, чтобы выиграть приз');
		return {
			isActive: true,
			publishedVersion: context.publishedVersion,
			color: stringValue(config.color, '#4705fb'),
			bgColor: stringValue(config.bgColor) || null,
			glassEffect: config.glassEffect === true,
			wheelBorderColor: stringValue(config.wheelBorderColor),
			title: stringValue(config.title, 'Крутите колесо!'),
			subtitle,
			winMessage: stringValue(config.winMessage),
			buttonText: stringValue(config.buttonText, 'Крутить!'),
			autoOpenDelay: config.autoOpenDelay || null,
			privacyUrl: stringValue(config.privacyUrl) || null,
			dataType: contactType,
			spinDuration: numberValue(config.spinDuration, 5),
			buttonSide: stringValue(config.buttonSide, 'right'),
			buttonPulse: config.buttonPulse !== false,
			buttonBottom: numberValue(config.buttonBottom, 3),
			buttonOffset: numberValue(config.buttonOffset, 3),
			buttonSize: numberValue(config.buttonSize, 60),
			...brandingPublicFields(config, context.hardPlan),
			bubbleEnabled: config.bubbleEnabled !== false,
			bubbleText: stringValue(config.bubbleText, 'Испытайте удачу!'),
			alreadyPlayedTitle: stringValue(
				config.alreadyPlayedTitle,
				'🎉 Вы уже участвовали!'
			),
			alreadyPlayedSubtitle: stringValue(
				config.alreadyPlayedSubtitle,
				'Каждый посетитель может крутить колесо только один раз'
			),
			hideIfPlayed: config.hideIfPlayed === true,
			buttonColor: stringValue(config.buttonColor),
			textColor: stringValue(config.textColor),
			centerColor: stringValue(config.centerColor, '#ffffff'),
			arrowColor: stringValue(config.arrowColor, '#ffcc00'),
			spinCooldownDays: numberValue(config.spinCooldownDays, 0),
			spinResetToken: stringValue(config.spinResetToken),
			hasPlayedByIp: context.duplicateByIp,
			...integrationPublicFields(config),
			bonuses: Array.isArray(config.bonuses) ? config.bonuses : []
		};
	},
	prepareLead(input, config): PreparedWidgetLead {
		const contact = contactInput(input, config, rawPhone, true);
		return {
			data: {
				...contact,
				bonus: input.bonus?.slice(0, 200),
				url: input.url?.slice(0, 500),
				resetToken: stringValue(config.spinResetToken).slice(0, 255)
			}
		};
	},
	duplicateRules(prepared, config, ip): DuplicateLeadRule[] {
		if (config.filterDuplicates !== true) return [];
		return [
			{
				lookup: {
					contact: prepared.contact,
					ip: ip || undefined,
					resetToken: stringValue(config.spinResetToken)
				},
				message: 'Заявка с таким контактом уже существует'
			}
		];
	},
	publicDuplicateRule(config, ip): PublicDuplicateRule | null {
		return ip
			? {
					responseKey: 'hasPlayedByIp',
					lookup: {
						ip,
						resetToken: stringValue(config.spinResetToken),
						since: cooldownSince(config.spinCooldownDays)
					}
				}
			: null;
	},
	presentLead: unchangedLead,
	stats(aggregate) {
		if (aggregate.kind !== 'grouped') {
			throw new Error('Wheel stats aggregation kind is invalid');
		}
		return {
			stats: aggregate.groups.map(group => ({
				bonus: group.value || 'Без бонуса',
				count: group.count,
				percent: aggregate.total
					? Math.round((group.count / aggregate.total) * 100)
					: 0
			})),
			total: aggregate.total
		};
	},
	exportSpec(leads) {
		return commonLeadExport(
			'leads',
			['№', 'Дата', 'Телефон', 'Email', 'Бонус', 'Страница'],
			leads,
			(lead, index) => [
				index + 1,
				lead.createdAt.toLocaleString('ru-RU'),
				lead.phone || lead.contact || '',
				lead.email || '',
				lead.bonus || '',
				lead.url || ''
			]
		);
	}
};

const quizAdapter: WidgetTypeAdapter = {
	type: WidgetType.QUIZ,
	publicConfig(config, context) {
		return {
			isActive: true,
			publishedVersion: context.publishedVersion,
			color: stringValue(config.color, '#4705fb'),
			bgColor: stringValue(config.bgColor) || null,
			...buttonPublicFields(config, context.hardPlan),
			bubbleEnabled: config.bubbleEnabled !== false,
			bubbleText: stringValue(config.bubbleText, 'Пройдите квиз!'),
			autoOpenDelay: config.autoOpenDelay || null,
			title: stringValue(config.title, 'Пройдите наш квиз!'),
			subtitle: stringValue(config.subtitle),
			buttonText: stringValue(config.buttonText, 'Начать квиз'),
			contactTitle: stringValue(
				config.contactTitle,
				'Оставьте контакт для получения результата'
			),
			dataType: dataType(config),
			privacyUrl: stringValue(config.privacyUrl) || null,
			...brandingPublicFields(config, context.hardPlan),
			alreadyPlayedTitle: stringValue(
				config.alreadyPlayedTitle,
				'🎉 Вы уже проходили этот квиз!'
			),
			alreadyPlayedSubtitle: stringValue(
				config.alreadyPlayedSubtitle,
				'Каждый посетитель может пройти квиз только один раз'
			),
			hideIfPlayed: config.hideIfPlayed === true,
			quizCooldownDays: numberValue(config.quizCooldownDays, 0),
			quizResetToken: stringValue(config.quizResetToken),
			hasPlayedByIp: context.duplicateByIp,
			...integrationPublicFields(config),
			questions: Array.isArray(config.questions) ? config.questions : [],
			results: Array.isArray(config.results) ? config.results : []
		};
	},
	prepareLead(input, config) {
		const contact = contactInput(input, config, rawPhone, true, false);
		const answers = parseQuizAnswers(input.answers || [], config);
		const result = scoreQuiz(answers, config);
		return {
			data: {
				...contact,
				answers: toInputJson(answers),
				result: result.title,
				url: input.url?.slice(0, 500),
				resetToken: stringValue(config.quizResetToken).slice(0, 255)
			},
			response: { result: result.value }
		};
	},
	duplicateRules(prepared, config, ip) {
		if (config.filterDuplicates !== true) return [];
		return [
			{
				lookup: {
					contact: prepared.contact,
					ip: ip || undefined,
					resetToken: stringValue(config.quizResetToken)
				},
				message: 'Заявка с таким контактом уже существует'
			}
		];
	},
	publicDuplicateRule(config, ip) {
		return ip
			? {
					responseKey: 'hasPlayedByIp' as const,
					lookup: {
						ip,
						resetToken: stringValue(config.quizResetToken),
						since: cooldownSince(config.quizCooldownDays)
					}
				}
			: null;
	},
	presentLead(lead, config) {
		if (!lead.result) return lead;
		const result = resolveQuizResultTitle(lead.result, config);
		return result === lead.result ? lead : { ...lead, result };
	},
	stats(aggregate, config) {
		if (aggregate.kind !== 'grouped') {
			throw new Error('Quiz stats aggregation kind is invalid');
		}
		const counts = new Map<string, number>();
		for (const group of aggregate.groups) {
			const result = group.value
				? resolveQuizResultTitle(group.value, config)
				: 'Без результата';
			counts.set(result, (counts.get(result) || 0) + group.count);
		}
		return {
			stats: [...counts]
				.map(([result, count]) => ({
					result,
					count,
					percent: aggregate.total
						? Math.round((count / aggregate.total) * 100)
						: 0
				}))
				.sort((a, b) => b.count - a.count),
			total: aggregate.total
		};
	},
	exportSpec(leads, config) {
		const presented = leads.map(lead =>
			quizAdapter.presentLead(lead, config)
		);
		return commonLeadExport(
			'quiz_leads',
			['№', 'Дата', 'Телефон', 'Email', 'Результат', 'Страница'],
			presented,
			(lead, index) => [
				index + 1,
				lead.createdAt.toLocaleString('ru-RU'),
				lead.phone || lead.contact || '',
				lead.email || '',
				lead.result || '',
				lead.url || ''
			]
		);
	}
};

const callbackAdapter: WidgetTypeAdapter = {
	type: WidgetType.CALLBACK,
	publicConfig(config, context) {
		return {
			isActive: true,
			publishedVersion: context.publishedVersion,
			color: stringValue(config.color, '#4705fb'),
			bgColor: stringValue(config.bgColor) || null,
			...buttonPublicFields(config, context.hardPlan),
			autoOpenDelay: config.autoOpenDelay || null,
			bubbleEnabled: config.bubbleEnabled !== false,
			bubbleText:
				stringValue(config.bubbleText) ||
				stringValue(config.title, 'Перезвоним!'),
			title: stringValue(config.title, 'Заказать звонок'),
			subtitle: stringValue(config.subtitle),
			submitButtonText: stringValue(
				config.submitButtonText,
				'Заказать звонок'
			),
			successTitle: stringValue(
				config.successTitle,
				'Спасибо! Мы перезвоним'
			),
			successSubtitle: stringValue(config.successSubtitle),
			privacyUrl: stringValue(config.privacyUrl) || null,
			...brandingPublicFields(config, context.hardPlan),
			filterDuplicates: config.filterDuplicates === true,
			timeSlots: Array.isArray(config.timeSlots) ? config.timeSlots : [],
			hasSubmittedByIp: context.duplicateByIp,
			...integrationPublicFields(config)
		};
	},
	prepareLead(input, config) {
		const phone = normalizePhone(input.phone);
		if (!phone)
			throw new BadRequestException('Укажите корректный телефон');
		const timeSlot = input.timeSlot?.trim().slice(0, 100) || '';
		const slots = Array.isArray(config.timeSlots)
			? config.timeSlots.map(String)
			: [];
		if (timeSlot && !slots.includes(timeSlot))
			throw new BadRequestException('Выбран некорректный интервал звонка');
		const timezone = input.timezone?.trim().slice(0, 100) || '';
		if (timezone) {
			try {
				new Intl.DateTimeFormat('ru-RU', { timeZone: timezone }).format();
			} catch {
				throw new BadRequestException('Укажите корректный часовой пояс');
			}
		}
		return {
			data: { phone, timeSlot, timezone, url: input.url?.slice(0, 500) }
		};
	},
	duplicateRules(prepared, config, ip) {
		const rules: DuplicateLeadRule[] = [
			{
				lookup: {
					phone: prepared.phone,
					since: new Date(Date.now() - 30 * 60 * 1000)
				},
				message: 'Заявка уже отправлена, мы скоро вам перезвоним'
			}
		];
		if (config.filterDuplicates === true && ip)
			rules.push({
				lookup: { ip },
				message: 'Заявка с этого устройства уже существует'
			});
		return rules;
	},
	publicDuplicateRule(config, ip) {
		return ip && config.filterDuplicates === true
			? { responseKey: 'hasSubmittedByIp', lookup: { ip } }
			: null;
	},
	presentLead: unchangedLead,
	stats: emptyStats,
	exportSpec(leads) {
		return {
			...commonLeadExport(
				'callback_leads',
				[
					'№',
					'Дата',
					'Телефон',
					'Время звонка',
					'Часовой пояс',
					'Страница'
				],
				leads,
				(lead, index) => [
					index + 1,
					lead.createdAt.toLocaleString('ru-RU'),
					lead.phone || '',
					lead.timeSlot || '',
					lead.timezone || '',
					lead.url || ''
				]
			),
			xlsxHeaders: [
				'№',
				'Дата',
				'Телефон',
				'Время',
				'Часовой пояс',
				'Страница'
			]
		};
	}
};

const timerAdapter: WidgetTypeAdapter = {
	type: WidgetType.TIMER,
	publicConfig(config, context) {
		return {
			isActive: true,
			publishedVersion: context.publishedVersion,
			color: stringValue(config.color, '#4705fb'),
			bgColor: stringValue(config.bgColor) || null,
			...buttonPublicFields(config, context.hardPlan),
			autoOpenDelay: config.autoOpenDelay || null,
			bubbleText: stringValue(config.bubbleText, 'Акция'),
			title: stringValue(config.title, 'Скидка ограничена по времени'),
			subtitle: stringValue(config.subtitle),
			timerMode: stringValue(config.timerMode, 'EVERGREEN'),
			deadlineAt: stringValue(config.deadlineAt) || null,
			evergreenDurationMinutes: numberValue(
				config.evergreenDurationMinutes,
				15
			),
			expiredBehavior: stringValue(config.expiredBehavior, 'showExpired'),
			expiredTitle: stringValue(config.expiredTitle, 'Акция завершена'),
			expiredSubtitle: stringValue(config.expiredSubtitle),
			dataType: dataType(config, 'NONE'),
			contactTitle: stringValue(
				config.contactTitle,
				'Оставьте контакт, чтобы получить предложение'
			),
			submitButtonText: stringValue(
				config.submitButtonText,
				'Получить предложение'
			),
			successTitle: stringValue(
				config.successTitle,
				'Спасибо! Заявка отправлена'
			),
			successSubtitle: stringValue(config.successSubtitle),
			actionButtonText: stringValue(
				config.actionButtonText,
				'Перейти к акции'
			),
			actionButtonUrl: stringValue(config.actionButtonUrl),
			privacyUrl: stringValue(config.privacyUrl) || null,
			...brandingPublicFields(config, context.hardPlan),
			filterDuplicates: config.filterDuplicates === true,
			submissionCooldownDays: numberValue(
				config.submissionCooldownDays,
				0
			),
			timerResetToken: stringValue(config.timerResetToken),
			hasSubmittedByIp: context.duplicateByIp,
			...integrationPublicFields(config)
		};
	},
	prepareLead(input, config) {
		const contact = contactInput(input, config);
		return {
			data: {
				phone: contact.phone,
				email: contact.email,
				url: input.url?.slice(0, 500),
				resetToken: stringValue(config.timerResetToken)
			}
		};
	},
	duplicateRules(prepared, config, ip) {
		return standardSubmissionRules(
			prepared,
			config,
			ip,
			'timerResetToken'
		);
	},
	publicDuplicateRule(config, ip) {
		return standardPublicSubmissionRule(
			config,
			ip,
			'timerResetToken',
			config.filterDuplicates === true &&
				dataType(config, 'NONE') !== 'NONE'
		);
	},
	presentLead: unchangedLead,
	stats: emptyStats,
	exportSpec(leads) {
		return commonLeadExport(
			'timer_leads',
			['№', 'Дата', 'Телефон', 'Email', 'Страница'],
			leads,
			(lead, index) => [
				index + 1,
				lead.createdAt.toLocaleString('ru-RU'),
				lead.phone || '',
				lead.email || '',
				lead.url || ''
			]
		);
	}
};

const stopOfferAdapter: WidgetTypeAdapter = {
	type: WidgetType.STOP_OFFER,
	publicConfig(config, context) {
		return {
			isActive: true,
			publishedVersion: context.publishedVersion,
			color: stringValue(config.color, '#4705fb'),
			bgColor: stringValue(config.bgColor),
			buttonColor: stringValue(config.buttonColor),
			hideBranding: context.hardPlan,
			autoOpenDelay: config.autoOpenDelay || null,
			desktopExitIntent: config.desktopExitIntent !== false,
			mobileAutoOpenDelay: numberValue(config.mobileAutoOpenDelay, 8),
			scrollPercent: numberValue(config.scrollPercent, 70),
			showOnce: config.showOnce !== false,
			displayCooldownDays: numberValue(config.displayCooldownDays, 7),
			displayResetToken: stringValue(config.displayResetToken),
			hideIfSubmitted: config.hideIfSubmitted !== false,
			badgeText: stringValue(config.badgeText, 'Подождите'),
			title: stringValue(config.title, 'Персональное предложение'),
			subtitle: stringValue(config.subtitle),
			offerText: stringValue(config.offerText, 'Скидка 10%'),
			dataType: dataType(config, 'NONE'),
			contactTitle: stringValue(
				config.contactTitle,
				'Куда отправить скидку?'
			),
			submitButtonText: stringValue(
				config.submitButtonText,
				'Забрать скидку'
			),
			successTitle: stringValue(
				config.successTitle,
				'Спасибо! Скидка закреплена'
			),
			successSubtitle: stringValue(config.successSubtitle),
			actionButtonEnabled: config.actionButtonEnabled === true,
			actionButtonText: stringValue(
				config.actionButtonText,
				'Перейти к акции'
			),
			actionButtonUrl: stringValue(config.actionButtonUrl),
			privacyUrl: stringValue(config.privacyUrl) || null,
			developInfoActive:
				config.developInfoActive !== false && !context.hardPlan,
			filterDuplicates: config.filterDuplicates === true,
			submissionCooldownDays: numberValue(
				config.submissionCooldownDays,
				0
			),
			submissionResetToken: stringValue(config.submissionResetToken),
			hasSubmittedByIp: context.duplicateByIp,
			...integrationPublicFields(config)
		};
	},
	prepareLead(input, config) {
		const contact = contactInput(input, config);
		return {
			data: {
				phone: contact.phone,
				email: contact.email,
				url: input.url?.slice(0, 500),
				resetToken: stringValue(config.submissionResetToken)
			}
		};
	},
	duplicateRules(prepared, config, ip) {
		return standardSubmissionRules(
			prepared,
			config,
			ip,
			'submissionResetToken'
		);
	},
	publicDuplicateRule(config, ip) {
		return standardPublicSubmissionRule(
			config,
			ip,
			'submissionResetToken',
			(config.filterDuplicates === true ||
				config.hideIfSubmitted !== false) &&
				dataType(config, 'NONE') !== 'NONE'
		);
	},
	presentLead: unchangedLead,
	stats: emptyStats,
	exportSpec(leads) {
		return commonLeadExport(
			'stop_offer_leads',
			['№', 'Дата', 'Телефон', 'Email', 'Страница'],
			leads,
			(lead, index) => [
				index + 1,
				lead.createdAt.toLocaleString('ru-RU'),
				lead.phone || '',
				lead.email || '',
				lead.url || ''
			]
		);
	}
};

const aiConsultantAdapter: WidgetTypeAdapter = {
	type: WidgetType.AI_CONSULTANT,
	publicConfig(config, context) {
		return {
			isActive: true,
			publishedVersion: context.publishedVersion,
			color: stringValue(config.color, '#4705fb'),
			bgColor: stringValue(config.bgColor, '#ffffff'),
			textColor: stringValue(config.textColor, '#1f2937'),
			...buttonPublicFields(config, context.hardPlan),
			autoOpenDelay: config.autoOpenDelay || null,
			operatorName: stringValue(config.operatorName, 'Alex'),
			greeting: stringValue(config.greeting),
			privacyUrl: stringValue(config.privacyUrl),
			inactivityTimeoutMinutes: numberValue(
				config.inactivityTimeoutMinutes,
				10
			),
			farewellMessage: stringValue(config.farewellMessage),
			inputPlaceholder: stringValue(
				config.inputPlaceholder,
				'Задайте вопрос...'
			)
		};
	},
	prepareLead() {
		throw new BadRequestException('AI-консультант не создаёт заявки');
	},
	duplicateRules() {
		return [];
	},
	publicDuplicateRule() {
		return null;
	},
	presentLead: unchangedLead,
	stats: emptyStats,
	exportSpec() {
		return { filenamePrefix: 'ai_consultant', headers: [], rows: [] };
	}
};

const ADAPTERS: readonly WidgetTypeAdapter[] = [
	wheelAdapter,
	quizAdapter,
	callbackAdapter,
	timerAdapter,
	stopOfferAdapter,
	aiConsultantAdapter,
	calculatorWidgetAdapter
];

@Injectable()
export class WidgetsTypeRegistryService {
	private readonly adapters = new Map(
		ADAPTERS.map(adapter => [adapter.type, adapter])
	);

	for(type: WidgetType): WidgetTypeAdapter {
		const adapter = this.adapters.get(type);
		if (!adapter)
			throw new BadRequestException('Некорректный тип виджета');
		return adapter;
	}
}

function standardSubmissionRules(
	prepared: { phone?: string; email?: string },
	config: Record<string, unknown>,
	ip: string,
	resetKey: string
): DuplicateLeadRule[] {
	if (config.filterDuplicates !== true) return [];
	return [
		{
			lookup: {
				phone: prepared.phone,
				email: prepared.email,
				ip: ip || undefined,
				resetToken: stringValue(config[resetKey]),
				since: cooldownSince(config.submissionCooldownDays)
			},
			message: 'Заявка с таким контактом уже существует'
		}
	];
}

function standardPublicSubmissionRule(
	config: Record<string, unknown>,
	ip: string,
	resetKey: string,
	enabled: boolean
): PublicDuplicateRule | null {
	return enabled && ip
		? {
				responseKey: 'hasSubmittedByIp',
				lookup: {
					ip,
					resetToken: stringValue(config[resetKey]),
					since: cooldownSince(config.submissionCooldownDays)
				}
			}
		: null;
}

function parseQuizAnswers(
	value: unknown[],
	config: Record<string, unknown>
) {
	const questions = Array.isArray(config.questions)
		? config.questions.map(asJsonObject)
		: [];
	const seen = new Set<string>();
	return value.map(item => {
		const answer = asJsonObject(item);
		if (
			Object.keys(answer).sort().join(',') !== 'optionIds,questionId' ||
			typeof answer.questionId !== 'string' ||
			!Array.isArray(answer.optionIds)
		) {
			throw new BadRequestException('Некорректный ответ квиза');
		}
		const questionId = answer.questionId;
		if (!questionId || questionId.length > 64 || seen.has(questionId)) {
			throw new BadRequestException('Некорректный ответ квиза');
		}
		seen.add(questionId);
		const question = questions.find(
			candidate => candidate.id === questionId
		);
		if (!question)
			throw new BadRequestException('Передан неизвестный вопрос');
		const optionIds = answer.optionIds;
		if (
			optionIds.length > 20 ||
			optionIds.some(id => typeof id !== 'string') ||
			new Set(optionIds).size !== optionIds.length
		) {
			throw new BadRequestException('Некорректный ответ квиза');
		}
		const configuredOptions = Array.isArray(question.options)
			? question.options.map(asJsonObject)
			: [];
		if (
			optionIds.some(
				id => !configuredOptions.some(option => option.id === id)
			)
		) {
			throw new BadRequestException('Передан неизвестный вариант ответа');
		}
		return { questionId, optionIds };
	});
}

function scoreQuiz(
	answers: Array<{ questionId: string; optionIds: unknown[] }>,
	config: Record<string, unknown>
) {
	const questions = Array.isArray(config.questions)
		? config.questions.map(asJsonObject)
		: [];
	const results = Array.isArray(config.results)
		? config.results.map(asJsonObject)
		: [];
	if (!results.length) return { title: undefined, value: null };
	const scores = new Map(results.map(result => [String(result.id), 0]));
	for (const answer of answers) {
		const question = questions.find(item => item.id === answer.questionId);
		const options = Array.isArray(question?.options)
			? question.options.map(asJsonObject)
			: [];
		for (const optionId of answer.optionIds) {
			const option = options.find(item => item.id === optionId);
			for (const [resultId, points] of Object.entries(
				asJsonObject(option?.scores)
			)) {
				if (scores.has(resultId) && Number.isFinite(Number(points))) {
					scores.set(
						resultId,
						(scores.get(resultId) || 0) + Number(points)
					);
				}
			}
		}
	}
	let winner = results[0];
	for (const result of results.slice(1)) {
		if (
			(scores.get(String(result.id)) || 0) >
			(scores.get(String(winner.id)) || 0)
		)
			winner = result;
	}
	return {
		title: stringValue(winner.title) || stringValue(winner.id),
		value: winner
	};
}
