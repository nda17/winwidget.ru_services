import { BadRequestException } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';

type Schema =
	| { kind: 'string'; maxLength: number; values?: readonly string[] }
	| { kind: 'boolean' }
	| { kind: 'number'; minimum: number; maximum: number }
	| { kind: 'array'; item: Schema; maximum: number }
	| {
			kind: 'object';
			fields: Record<string, { schema: Schema; optional?: boolean }>;
	  };

const string = (
	maxLength = 20_000,
	values?: readonly string[]
): Schema => ({ kind: 'string', maxLength, values });
const boolean = (): Schema => ({ kind: 'boolean' });
const number = (minimum: number, maximum: number): Schema => ({
	kind: 'number',
	minimum,
	maximum
});
const array = (item: Schema, maximum = 100): Schema => ({
	kind: 'array',
	item,
	maximum
});
const object = (
	fields: Record<string, { schema: Schema; optional?: boolean }>
): Schema => ({ kind: 'object', fields });
const required = (schema: Schema): { schema: Schema } => ({ schema });
const optional = (schema: Schema): { schema: Schema; optional: true } => ({
	schema,
	optional: true
});

const textCard = object({ text: required(string()) });
const featureCard = object({
	title: required(string()),
	text: required(string())
});
const sectionWithFeatureItems = object({
	enabled: required(boolean()),
	title: required(string()),
	subtitle: required(string()),
	items: required(array(featureCard))
});

const STRUCTURED_HOME_CONTENT_SCHEMA = object({
	seo: required(
		object({
			title: required(string(500)),
			description: required(string(2_000)),
			keywords: required(array(string(200), 50)),
			ogTitle: required(string(500)),
			ogDescription: required(string(2_000))
		})
	),
	technicalSeo: required(
		object({
			baseUrl: required(string(2_000)),
			robotsDisallow: required(array(string(2_000), 100)),
			sitemapItems: required(
				array(
					object({
						path: required(string(2_000)),
						changeFrequency: required(
							string(20, [
								'always',
								'hourly',
								'daily',
								'weekly',
								'monthly',
								'yearly',
								'never'
							])
						),
						priority: required(number(0, 1)),
						enabled: required(boolean())
					}),
					100
				)
			)
		})
	),
	demoWidgets: required(
		object({
			enabled: required(boolean()),
			bubbleTexts: required(
				object({
					wheel: required(string(500)),
					quiz: required(string(500)),
					callback: required(string(500)),
					countdown: required(string(500)),
					aiConsultant: required(string(500)),
					stopOffer: required(string(500)),
					calculator: required(string(500))
				})
			)
		})
	),
	hero: required(
		object({
			titleBeforeAccent: required(string()),
			accentText: required(string()),
			titleAfterAccent: required(string()),
			subtitle: required(string()),
			primaryButtonText: required(string()),
			faqButtonLabel: required(string()),
			benefits: required(array(textCard))
		})
	),
	analysis: required(
		object({
			enabled: required(boolean()),
			title: required(string()),
			subtitle: required(string()),
			cards: required(array(textCard))
		})
	),
	integrations: required(
		object({
			enabled: required(boolean()),
			title: required(string()),
			items: required(
				array(
					object({
						title: required(string()),
						tag: required(string()),
						description: required(string()),
						iconKey: required(
							string(40, [
								'email',
								'telegram',
								'webhook',
								'bitrix',
								'amocrm',
								'metrika',
								'vk',
								'roistat'
							])
						)
					})
				)
			)
		})
	),
	tools: required(
		object({
			enabled: required(boolean()),
			title: required(string()),
			ctaText: required(string()),
			items: required(
				array(
					object({
						title: required(string()),
						description: required(string()),
						comingSoon: required(boolean()),
						previewType: required(
							string(40, [
								'wheel',
								'quiz',
								'callback',
								'timer',
								'aiConsultant',
								'stopOffer',
								'calculator',
								'none'
							])
						)
					})
				)
			)
		})
	),
	audiences: required(sectionWithFeatureItems),
	caseStudies: required(
		object({
			enabled: required(boolean()),
			title: required(string()),
			subtitle: required(string()),
			items: required(
				array(
					object({
						title: required(string()),
						text: required(string()),
						result: required(string())
					})
				)
			)
		})
	),
	leadFlow: required(sectionWithFeatureItems),
	whyWidgets: required(
		object({
			enabled: required(boolean()),
			title: required(string()),
			subtitle: required(string()),
			formTitle: required(string()),
			widgetTitle: required(string()),
			formItems: required(array(textCard)),
			widgetItems: required(array(textCard))
		})
	),
	steps: required(
		object({
			enabled: required(boolean()),
			title: required(string()),
			resultText: required(string()),
			items: required(array(textCard))
		})
	),
	customization: required(
		object({
			enabled: required(boolean()),
			title: required(string()),
			subtitle: required(string()),
			cards: required(array(featureCard)),
			features: required(array(textCard)),
			bottomText: required(string())
		})
	),
	dashboardPreview: required(
		object({
			enabled: required(boolean()),
			title: required(string()),
			subtitle: required(string()),
			cards: required(array(featureCard)),
			metrics: required(array(featureCard))
		})
	),
	directLink: required(sectionWithFeatureItems),
	security: required(sectionWithFeatureItems),
	subscriptionBundle: required(
		object({
			enabled: required(boolean()),
			title: required(string()),
			subtitle: required(string()),
			cardTitle: required(string()),
			items: required(array(textCard))
		})
	),
	tariffComparison: required(
		object({
			enabled: required(boolean()),
			title: required(string()),
			subtitle: required(string()),
			rows: required(
				array(
					object({
						feature: required(string()),
						easy: required(string()),
						hard: required(string())
					})
				)
			)
		})
	),
	pricing: required(
		object({
			enabled: required(boolean()),
			title: required(string()),
			monthlyToggleText: required(string()),
			yearlyToggleText: required(string()),
			discountText: required(string()),
			buttonText: required(string()),
			plans: required(
				array(
					object({
						key: required(string(100)),
						badge: required(string()),
						title: required(string()),
						subtitle: required(string()),
						features: required(array(string(), 100)),
						monthly: required(
							object({
								price: required(string()),
								priceNote: required(string()),
								yearlyTotal: optional(string())
							})
						),
						yearly: required(
							object({
								price: required(string()),
								priceNote: required(string()),
								yearlyTotal: optional(string())
							})
						),
						star: required(boolean()),
						popular: required(boolean())
					})
				)
			)
		})
	),
	microCta: required(
		object({
			enabled: required(boolean()),
			afterIntegrationsText: required(string()),
			afterIntegrationsButtonText: required(string()),
			afterStepsText: required(string()),
			afterStepsButtonText: required(string())
		})
	),
	seoText: required(
		object({
			enabled: required(boolean()),
			title: required(string()),
			text: required(string(100_000))
		})
	),
	payment: required(
		object({
			seoTitle: required(string(500)),
			seoDescription: required(string(2_000))
		})
	),
	faq: required(
		object({
			enabled: required(boolean()),
			title: required(string()),
			items: required(
				array(
					object({
						question: required(string()),
						answerHtml: required(string(100_000))
					})
				)
			)
		})
	),
	cta: required(
		object({
			enabled: required(boolean()),
			text: required(string()),
			buttonText: required(string()),
			benefits: required(array(textCard))
		})
	),
	footer: required(
		object({
			aboutTitle: required(string()),
			infoLines: required(array(string(), 100)),
			email: required(string(500)),
			ybsUrl: required(string(2_000)),
			vkUrl: required(string(2_000)),
			telegramUrl: required(string(2_000)),
			vkAriaLabel: required(string(500)),
			telegramAriaLabel: required(string(500)),
			legalDisclaimer: required(string(20_000))
		})
	)
});

const RAW_HOME_CONTENT_SCHEMA = object({
	head: required(
		object({
			enabled: required(boolean()),
			html: required(string(256 * 1024))
		})
	),
	body: required(
		object({
			enabled: required(boolean()),
			html: required(string(256 * 1024))
		})
	)
});

const SAFE_HTML_OPTIONS: sanitizeHtml.IOptions = {
	allowedTags: [
		'p',
		'br',
		'strong',
		'em',
		'u',
		's',
		'ul',
		'ol',
		'li',
		'a',
		'h1',
		'h2',
		'h3',
		'h4',
		'blockquote',
		'code',
		'section'
	],
	allowedAttributes: {
		a: ['href', 'target', 'rel'],
		p: ['style'],
		h1: ['style'],
		h2: ['style'],
		h3: ['style'],
		section: ['data-winwidget-section']
	},
	allowedStyles: {
		p: {
			'text-align': [/^(?:left|center|right)$/]
		},
		h1: {
			'text-align': [/^(?:left|center|right)$/]
		},
		h2: {
			'text-align': [/^(?:left|center|right)$/]
		},
		h3: {
			'text-align': [/^(?:left|center|right)$/]
		}
	},
	allowedSchemes: ['http', 'https', 'mailto', 'tel'],
	allowProtocolRelative: false,
	allowedSchemesAppliedToAttributes: ['href'],
	transformTags: {
		a: (_tagName, attributes) => {
			const attribs: Record<string, string> = {};
			if (attributes.href) attribs.href = attributes.href;
			if (attributes.target === '_blank') {
				attribs.target = '_blank';
				attribs.rel = 'noopener noreferrer';
			}
			return { tagName: 'a', attribs };
		}
	}
};

export function sanitizeLegalHtml(value: string): string {
	if (Buffer.byteLength(value, 'utf8') > 1024 * 1024) {
		throw new BadRequestException('Legal page content is too large');
	}
	return sanitizeHtml(value, SAFE_HTML_OPTIONS);
}

export function validateAndSanitizeStructuredHomeContent(
	value: unknown
): Record<string, unknown> {
	assertJsonSize(value, 1024 * 1024);
	validate(value, STRUCTURED_HOME_CONTENT_SCHEMA, 'content');
	const content = structuredClone(value) as Record<string, unknown>;
	const faq = content.faq as {
		items: Array<{ question: string; answerHtml: string }>;
	};
	faq.items = faq.items.map(item => ({
		...item,
		answerHtml: sanitizeHtml(item.answerHtml, SAFE_HTML_OPTIONS)
	}));
	return content;
}

export function validateRawHomeContent(
	value: unknown
): Record<'head' | 'body', { enabled: boolean; html: string }> {
	assertJsonSize(value, 600 * 1024);
	validate(value, RAW_HOME_CONTENT_SCHEMA, 'content');
	return value as Record<
		'head' | 'body',
		{ enabled: boolean; html: string }
	>;
}

function assertJsonSize(value: unknown, maximum: number): void {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new BadRequestException('content must be valid JSON');
	}
	if (Buffer.byteLength(serialized, 'utf8') > maximum) {
		throw new BadRequestException('content is too large');
	}
}

function validate(value: unknown, schema: Schema, path: string): void {
	if (schema.kind === 'string') {
		if (typeof value !== 'string' || value.length > schema.maxLength) {
			throw invalid(path);
		}
		if (schema.values && !schema.values.includes(value)) {
			throw invalid(path);
		}
		return;
	}
	if (schema.kind === 'boolean') {
		if (typeof value !== 'boolean') throw invalid(path);
		return;
	}
	if (schema.kind === 'number') {
		if (
			typeof value !== 'number' ||
			!Number.isFinite(value) ||
			value < schema.minimum ||
			value > schema.maximum
		) {
			throw invalid(path);
		}
		return;
	}
	if (schema.kind === 'array') {
		if (!Array.isArray(value) || value.length > schema.maximum) {
			throw invalid(path);
		}
		value.forEach((item, index) =>
			validate(item, schema.item, `${path}[${index}]`)
		);
		return;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw invalid(path);
	}
	const candidate = value as Record<string, unknown>;
	const allowed = Object.keys(schema.fields);
	const unknown = Object.keys(candidate).find(
		key => !allowed.includes(key)
	);
	if (unknown) throw invalid(`${path}.${unknown}`);
	for (const [key, field] of Object.entries(schema.fields)) {
		if (!(key in candidate)) {
			if (field.optional) continue;
			throw invalid(`${path}.${key}`);
		}
		validate(candidate[key], field.schema, `${path}.${key}`);
	}
}

function invalid(path: string): BadRequestException {
	return new BadRequestException(`Invalid structured field: ${path}`);
}
