import {
	PIPELINE_STAGE_STATES,
	PipelineTemplateDefinition,
	PipelineTemplateStageDefinition
} from './pipeline-template.types';

const TEMPLATE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_TEMPLATES = 100;
const MAX_TEMPLATE_NAME_LENGTH = 200;
const MAX_TEMPLATE_DESCRIPTION_LENGTH = 2_000;
const MAX_INDUSTRY_TAGS = 50;
const MAX_KEY_LENGTH = 64;
const MAX_STAGES = 100;
const MAX_STAGE_NAME_LENGTH = 200;

const RAW_PIPELINE_TEMPLATES_V1: PipelineTemplateDefinition[] = [
	{
		key: 'universal-sales',
		version: 1,
		name: 'Универсальные продажи',
		description:
			'Базовая воронка для компаний с последовательным циклом продажи.',
		industryTags: ['sales', 'services', 'b2b', 'b2c'],
		isBlank: false,
		stages: [
			{ key: 'new-lead', name: 'Новая заявка', order: 1, state: 'OPEN' },
			{
				key: 'qualified',
				name: 'Квалифицирована',
				order: 2,
				state: 'OPEN'
			},
			{
				key: 'proposal',
				name: 'Предложение отправлено',
				order: 3,
				state: 'OPEN'
			},
			{
				key: 'negotiation',
				name: 'Переговоры',
				order: 4,
				state: 'OPEN'
			},
			{ key: 'won', name: 'Сделка выиграна', order: 5, state: 'WON' },
			{ key: 'lost', name: 'Сделка проиграна', order: 6, state: 'LOST' }
		]
	},
	{
		key: 'appointment-services',
		version: 1,
		name: 'Услуги по записи',
		description:
			'Запись клиентов, подтверждение визита и завершение оказанной услуги.',
		industryTags: ['appointments', 'beauty', 'healthcare', 'services'],
		isBlank: false,
		stages: [
			{
				key: 'new-request',
				name: 'Новая запись',
				order: 1,
				state: 'OPEN'
			},
			{
				key: 'contacted',
				name: 'Связались с клиентом',
				order: 2,
				state: 'OPEN'
			},
			{
				key: 'scheduled',
				name: 'Визит подтверждён',
				order: 3,
				state: 'OPEN'
			},
			{
				key: 'visited',
				name: 'Клиент пришёл',
				order: 4,
				state: 'OPEN'
			},
			{ key: 'served', name: 'Услуга оказана', order: 5, state: 'WON' },
			{
				key: 'cancelled',
				name: 'Запись отменена',
				order: 6,
				state: 'LOST'
			}
		]
	},
	{
		key: 'retail-orders',
		version: 1,
		name: 'Розничные заказы',
		description:
			'Обработка заказа от поступления до выдачи или доставки покупателю.',
		industryTags: ['retail', 'ecommerce', 'orders'],
		isBlank: false,
		stages: [
			{ key: 'new-order', name: 'Новый заказ', order: 1, state: 'OPEN' },
			{
				key: 'confirmed',
				name: 'Заказ подтверждён',
				order: 2,
				state: 'OPEN'
			},
			{
				key: 'assembling',
				name: 'Комплектуется',
				order: 3,
				state: 'OPEN'
			},
			{
				key: 'ready',
				name: 'Готов к выдаче',
				order: 4,
				state: 'OPEN'
			},
			{ key: 'completed', name: 'Заказ выполнен', order: 5, state: 'WON' },
			{ key: 'cancelled', name: 'Заказ отменён', order: 6, state: 'LOST' }
		]
	},
	{
		key: 'wholesale-manufacturing',
		version: 1,
		name: 'Оптовые продажи и производство',
		description:
			'Длинный цикл сделки от запроса и расчёта до производства и отгрузки.',
		industryTags: ['wholesale', 'manufacturing', 'b2b'],
		isBlank: false,
		stages: [
			{ key: 'inquiry', name: 'Входящий запрос', order: 1, state: 'OPEN' },
			{
				key: 'requirements',
				name: 'Требования уточнены',
				order: 2,
				state: 'OPEN'
			},
			{
				key: 'quotation',
				name: 'Расчёт отправлен',
				order: 3,
				state: 'OPEN'
			},
			{ key: 'contract', name: 'Договор', order: 4, state: 'OPEN' },
			{
				key: 'production',
				name: 'В производстве',
				order: 5,
				state: 'OPEN'
			},
			{ key: 'shipped', name: 'Отгружено', order: 6, state: 'WON' },
			{
				key: 'lost',
				name: 'Сделка не состоялась',
				order: 7,
				state: 'LOST'
			}
		]
	},
	{
		key: 'custom-projects',
		version: 1,
		name: 'Проектные услуги',
		description:
			'Продажа и выполнение индивидуальных проектов с оценкой и приёмкой.',
		industryTags: ['agency', 'consulting', 'it', 'projects'],
		isBlank: false,
		stages: [
			{
				key: 'new-request',
				name: 'Новый запрос',
				order: 1,
				state: 'OPEN'
			},
			{ key: 'briefing', name: 'Брифинг', order: 2, state: 'OPEN' },
			{
				key: 'estimate',
				name: 'Оценка согласуется',
				order: 3,
				state: 'OPEN'
			},
			{
				key: 'in-progress',
				name: 'Проект в работе',
				order: 4,
				state: 'OPEN'
			},
			{ key: 'acceptance', name: 'Приёмка', order: 5, state: 'OPEN' },
			{
				key: 'completed',
				name: 'Проект завершён',
				order: 6,
				state: 'WON'
			},
			{ key: 'rejected', name: 'Проект отклонён', order: 7, state: 'LOST' }
		]
	},
	{
		key: 'education-courses',
		version: 1,
		name: 'Образование и курсы',
		description:
			'Путь будущего ученика от обращения до оплаты и зачисления на курс.',
		industryTags: ['education', 'courses', 'schools'],
		isBlank: false,
		stages: [
			{ key: 'new-lead', name: 'Новый ученик', order: 1, state: 'OPEN' },
			{
				key: 'consultation',
				name: 'Консультация',
				order: 2,
				state: 'OPEN'
			},
			{
				key: 'trial-lesson',
				name: 'Пробное занятие',
				order: 3,
				state: 'OPEN'
			},
			{
				key: 'invoice',
				name: 'Ожидается оплата',
				order: 4,
				state: 'OPEN'
			},
			{ key: 'enrolled', name: 'Ученик зачислен', order: 5, state: 'WON' },
			{ key: 'lost', name: 'Обучение не выбрано', order: 6, state: 'LOST' }
		]
	},
	{
		key: 'memberships-fitness',
		version: 1,
		name: 'Абонементы и фитнес',
		description:
			'Продажа абонементов через консультацию и пробное посещение.',
		industryTags: ['fitness', 'memberships', 'wellness'],
		isBlank: false,
		stages: [
			{ key: 'new-lead', name: 'Новый интерес', order: 1, state: 'OPEN' },
			{
				key: 'contacted',
				name: 'Контакт установлен',
				order: 2,
				state: 'OPEN'
			},
			{
				key: 'trial-visit',
				name: 'Пробный визит',
				order: 3,
				state: 'OPEN'
			},
			{
				key: 'offer',
				name: 'Абонемент предложен',
				order: 4,
				state: 'OPEN'
			},
			{
				key: 'membership-sold',
				name: 'Абонемент продан',
				order: 5,
				state: 'WON'
			},
			{ key: 'refused', name: 'Клиент отказался', order: 6, state: 'LOST' }
		]
	},
	{
		key: 'construction-repair',
		version: 1,
		name: 'Строительство и ремонт',
		description:
			'Воронка от первичной заявки и замера до выполнения и приёмки работ.',
		industryTags: ['construction', 'repair', 'home-services'],
		isBlank: false,
		stages: [
			{
				key: 'new-request',
				name: 'Новая заявка',
				order: 1,
				state: 'OPEN'
			},
			{
				key: 'site-survey',
				name: 'Замер назначен',
				order: 2,
				state: 'OPEN'
			},
			{
				key: 'estimate',
				name: 'Смета подготовлена',
				order: 3,
				state: 'OPEN'
			},
			{
				key: 'agreement',
				name: 'Договор согласуется',
				order: 4,
				state: 'OPEN'
			},
			{
				key: 'in-progress',
				name: 'Работы выполняются',
				order: 5,
				state: 'OPEN'
			},
			{ key: 'accepted', name: 'Работы приняты', order: 6, state: 'WON' },
			{
				key: 'rejected',
				name: 'Заказ не состоялся',
				order: 7,
				state: 'LOST'
			}
		]
	},
	{
		key: 'logistics',
		version: 1,
		name: 'Логистика и перевозки',
		description:
			'Обработка перевозки от запроса стоимости до подтверждённой доставки.',
		industryTags: ['logistics', 'delivery', 'transportation'],
		isBlank: false,
		stages: [
			{
				key: 'new-request',
				name: 'Новый запрос',
				order: 1,
				state: 'OPEN'
			},
			{
				key: 'calculation',
				name: 'Расчёт маршрута',
				order: 2,
				state: 'OPEN'
			},
			{
				key: 'agreement',
				name: 'Условия согласованы',
				order: 3,
				state: 'OPEN'
			},
			{ key: 'in-transit', name: 'Груз в пути', order: 4, state: 'OPEN' },
			{ key: 'delivered', name: 'Груз доставлен', order: 5, state: 'WON' },
			{
				key: 'cancelled',
				name: 'Перевозка отменена',
				order: 6,
				state: 'LOST'
			}
		]
	},
	{
		key: 'blank',
		version: 1,
		name: 'Пустая воронка',
		description:
			'Минимальная структура для самостоятельной настройки процесса.',
		industryTags: [],
		isBlank: true,
		stages: [
			{ key: 'new', name: 'Новая сделка', order: 1, state: 'OPEN' },
			{ key: 'won', name: 'Успешно завершена', order: 2, state: 'WON' },
			{
				key: 'lost',
				name: 'Закрыта без результата',
				order: 3,
				state: 'LOST'
			}
		]
	}
];

export function validatePipelineTemplateCatalog(
	templates: readonly PipelineTemplateDefinition[]
): void {
	if (templates.length === 0 || templates.length > MAX_TEMPLATES) {
		throw new Error('Pipeline template catalog size is invalid');
	}
	const templateVersions = new Set<string>();

	for (const template of templates) {
		if (
			template.key.length > MAX_KEY_LENGTH ||
			!TEMPLATE_KEY_PATTERN.test(template.key)
		) {
			throw new Error(`Invalid template key: ${template.key}`);
		}
		if (!Number.isSafeInteger(template.version) || template.version < 1) {
			throw new Error(`Invalid template version: ${template.key}`);
		}
		const versionId = pipelineTemplateVersionId(
			template.key,
			template.version
		);
		if (templateVersions.has(versionId)) {
			throw new Error(`Duplicate template version: ${versionId}`);
		}
		templateVersions.add(versionId);
		if (
			!template.name.trim() ||
			template.name.length > MAX_TEMPLATE_NAME_LENGTH ||
			!template.description.trim() ||
			template.description.length > MAX_TEMPLATE_DESCRIPTION_LENGTH
		) {
			throw new Error(`Template text is required: ${template.key}`);
		}
		if (
			template.industryTags.length > MAX_INDUSTRY_TAGS ||
			new Set(template.industryTags).size !==
				template.industryTags.length ||
			template.industryTags.some(
				tag =>
					tag.length > MAX_KEY_LENGTH || !TEMPLATE_KEY_PATTERN.test(tag)
			)
		) {
			throw new Error(`Invalid industry tags: ${template.key}`);
		}
		validateStages(template.key, template.stages);
	}
}

function validateStages(
	templateKey: string,
	stages: readonly PipelineTemplateStageDefinition[]
): void {
	if (stages.length < 3 || stages.length > MAX_STAGES) {
		throw new Error(`Template stages are incomplete: ${templateKey}`);
	}

	const stageKeys = new Set<string>();
	const counts = { OPEN: 0, WON: 0, LOST: 0 };
	let terminalStarted = false;

	stages.forEach((stage, index) => {
		if (
			stage.key.length > MAX_KEY_LENGTH ||
			!TEMPLATE_KEY_PATTERN.test(stage.key)
		) {
			throw new Error(`Invalid stage key: ${templateKey}/${stage.key}`);
		}
		if (stageKeys.has(stage.key)) {
			throw new Error(`Duplicate stage key: ${templateKey}/${stage.key}`);
		}
		stageKeys.add(stage.key);
		if (stage.order !== index + 1) {
			throw new Error(`Invalid stage order: ${templateKey}/${stage.key}`);
		}
		if (
			!stage.name.trim() ||
			stage.name.length > MAX_STAGE_NAME_LENGTH ||
			!PIPELINE_STAGE_STATES.includes(stage.state)
		) {
			throw new Error(`Invalid stage: ${templateKey}/${stage.key}`);
		}

		counts[stage.state] += 1;
		if (stage.state !== 'OPEN') terminalStarted = true;
		if (terminalStarted && stage.state === 'OPEN') {
			throw new Error(
				`OPEN stage follows a terminal stage: ${templateKey}/${stage.key}`
			);
		}
	});

	if (counts.OPEN < 1 || counts.WON !== 1 || counts.LOST !== 1) {
		throw new Error(`Invalid OPEN/WON/LOST structure: ${templateKey}`);
	}
	const terminalStates = stages.slice(-2).map(stage => stage.state);
	if (terminalStates[0] !== 'WON' || terminalStates[1] !== 'LOST') {
		throw new Error(`Invalid terminal stage order: ${templateKey}`);
	}
}

function freezeTemplate(
	template: PipelineTemplateDefinition
): PipelineTemplateDefinition {
	const stages = Object.freeze(
		template.stages.map(stage => Object.freeze({ ...stage }))
	);
	const industryTags = Object.freeze([...template.industryTags]);
	return Object.freeze({ ...template, stages, industryTags });
}

validatePipelineTemplateCatalog(RAW_PIPELINE_TEMPLATES_V1);

export const PIPELINE_TEMPLATES_V1 = Object.freeze(
	RAW_PIPELINE_TEMPLATES_V1.map(freezeTemplate)
);

export function pipelineTemplateVersionId(
	key: string,
	version: number
): string {
	return `${key}@${version}`;
}

export const PIPELINE_TEMPLATE_VERSIONS: Readonly<
	Record<string, PipelineTemplateDefinition>
> = buildPipelineTemplateVersionIndex(PIPELINE_TEMPLATES_V1);

export function buildPipelineTemplateVersionIndex(
	templates: readonly PipelineTemplateDefinition[]
): Readonly<Record<string, PipelineTemplateDefinition>> {
	validatePipelineTemplateCatalog(templates);
	return Object.freeze(
		Object.fromEntries(
			templates.map(template => [
				pipelineTemplateVersionId(template.key, template.version),
				template
			])
		)
	);
}

export function getPipelineTemplateFromIndex(
	index: Readonly<Record<string, PipelineTemplateDefinition>>,
	key: string,
	version: number
): PipelineTemplateDefinition | undefined {
	return index[pipelineTemplateVersionId(key, version)];
}

export function getPipelineTemplate(
	key: string,
	version: number
): PipelineTemplateDefinition | undefined {
	return getPipelineTemplateFromIndex(
		PIPELINE_TEMPLATE_VERSIONS,
		key,
		version
	);
}
