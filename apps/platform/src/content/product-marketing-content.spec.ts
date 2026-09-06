import { PlatformHomePageContentService } from '../home-page-content/home-page-content.service';
import { validateAndSanitizeStructuredHomeContent as validate } from './platform-content.validation';

const seo = () => ({
	title: '',
	description: '',
	keywords: [],
	ogTitle: '',
	ogDescription: ''
});
const section = () => ({
	enabled: true,
	title: '',
	subtitle: '',
	items: []
});
const integration = () => ({ ...section(), note: '' });
const faq = () => ({
	enabled: true,
	title: '',
	items: [{ question: 'Question', answer: 'Answer' }]
});
const hero = () => ({ eyebrow: '', title: 'Title', subtitle: '' });
const cta = () => ({ enabled: true, title: '', text: '' });
const buttons = () => ({
	widgetsButtonText: 'Widgets',
	crmButtonText: 'CRM'
});
const product = () => ({
	description: '',
	features: ['Feature'],
	buttonText: 'Open'
});
const pages = () => ({
	ecosystem: {
		seo: seo(),
		hero: hero(),
		products: {
			title: '',
			subtitle: '',
			widgets: product(),
			crm: product()
		},
		integration: integration(),
		plans: {
			enabled: true,
			title: '',
			subtitle: '',
			...buttons(),
			note: ''
		},
		faq: faq(),
		cta: { ...cta(), ...buttons() }
	},
	crmProduct: {
		seo: seo(),
		hero: { ...hero(), buttonText: 'Open CRM' },
		features: section(),
		workflow: section(),
		integration: integration(),
		faq: faq(),
		cta: { ...cta(), buttonText: 'Open CRM' }
	}
});

const legacy = () => ({
	seo: seo(),
	technicalSeo: { baseUrl: '', robotsDisallow: [], sitemapItems: [] },
	demoWidgets: {
		enabled: true,
		bubbleTexts: {
			wheel: '',
			quiz: '',
			callback: '',
			countdown: '',
			aiConsultant: '',
			stopOffer: '',
			calculator: ''
		}
	},
	hero: {
		titleBeforeAccent: '',
		accentText: '',
		titleAfterAccent: '',
		subtitle: '',
		primaryButtonText: '',
		faqButtonLabel: '',
		benefits: []
	},
	analysis: { enabled: true, title: '', subtitle: '', cards: [] },
	integrations: { enabled: true, title: '', items: [] },
	tools: { enabled: true, title: '', ctaText: '', items: [] },
	audiences: section(),
	caseStudies: section(),
	leadFlow: section(),
	whyWidgets: {
		enabled: true,
		title: '',
		subtitle: '',
		formTitle: '',
		widgetTitle: '',
		formItems: [],
		widgetItems: []
	},
	steps: { enabled: true, title: '', resultText: '', items: [] },
	customization: {
		enabled: true,
		title: '',
		subtitle: '',
		cards: [],
		features: [],
		bottomText: ''
	},
	dashboardPreview: {
		enabled: true,
		title: '',
		subtitle: '',
		cards: [],
		metrics: []
	},
	directLink: section(),
	security: section(),
	subscriptionBundle: { ...section(), cardTitle: '' },
	tariffComparison: { enabled: true, title: '', subtitle: '', rows: [] },
	pricing: {
		enabled: true,
		title: '',
		monthlyToggleText: '',
		yearlyToggleText: '',
		discountText: '',
		buttonText: '',
		plans: []
	},
	microCta: {
		enabled: true,
		afterIntegrationsText: '',
		afterIntegrationsButtonText: '',
		afterStepsText: '',
		afterStepsButtonText: ''
	},
	seoText: { enabled: true, title: '', text: '' },
	payment: { seoTitle: '', seoDescription: '' },
	faq: { enabled: true, title: '', items: [] },
	cta: { enabled: true, text: '', buttonText: '', benefits: [] },
	footer: {
		aboutTitle: '',
		infoLines: [],
		email: '',
		ybsUrl: '',
		vkUrl: '',
		telegramUrl: '',
		vkAriaLabel: '',
		telegramAriaLabel: '',
		legalDisclaimer: ''
	}
});

describe('Product marketing content compatibility', () => {
	it('accepts legacy documents without introducing implicit marketing pages', () => {
		expect(validate(legacy())).toEqual(legacy());
	});
	it('accepts the complete two-page editorial contract and copies input', () => {
		const input = { ...legacy(), ...pages() };
		expect(validate(input)).toEqual(input);
		expect(validate(input)).not.toBe(input);
	});
	it.each([
		'enabled',
		'appUrl',
		'apiEnabled',
		'monthlyPrice',
		'html',
		'__proto__'
	])('rejects %s as a page control supplied through CMS', key => {
		const input = { ...legacy(), ...pages() };
		Object.defineProperty(input.crmProduct, key, {
			value: true,
			enumerable: true
		});
		expect(() => validate(input)).toThrow(`content.crmProduct.${key}`);
	});
	it('rejects incomplete supplied pages, null pages, and wrong leaf types', () => {
		expect(() => validate({ ...legacy(), ecosystem: null })).toThrow(
			'content.ecosystem'
		);
		expect(() => validate({ ...legacy(), crmProduct: {} })).toThrow(
			'content.crmProduct.seo'
		);
		const input = { ...legacy(), ...pages() };
		Object.assign(input.ecosystem.hero, { title: { html: 'not text' } });
		expect(() => validate(input)).toThrow('content.ecosystem.hero.title');
	});
	it('rejects oversized strings and card lists without truncating saved text', () => {
		const input = { ...legacy(), ...pages() };
		input.crmProduct.hero.title = 'a'.repeat(501);
		expect(() => validate(input)).toThrow('content.crmProduct.hero.title');
		input.crmProduct.hero.title = 'Valid';
		input.ecosystem.products.widgets.features = Array(51).fill('Feature');
		expect(() => validate(input)).toThrow(
			'content.ecosystem.products.widgets.features'
		);
	});
	it('keeps literal text literal; new pages never allow answerHtml', () => {
		const input = { ...legacy(), ...pages() };
		input.crmProduct.faq.items[0].answer = '<strong>literal</strong>';
		expect(validate(input)).toEqual(input);
		Object.assign(input.crmProduct.faq.items[0], {
			answerHtml: '<b>bad contract</b>'
		});
		expect(() => validate(input)).toThrow(
			'content.crmProduct.faq.items[0].answerHtml'
		);
	});

	it.each([false, true])(
		'preserves stored pages for old clients, replaces explicitly supplied pages: newClient=%s',
		async newClient => {
			const current = {
				...legacy(),
				...pages(),
				head: { enabled: true, html: '<meta name="trusted">' },
				body: { enabled: false, html: '' }
			};
			current.ecosystem.hero.title = 'Previously saved ecosystem';
			current.crmProduct.hero.title = 'Previously saved CRM';
			const patch = newClient ? { ...legacy(), ...pages() } : legacy();
			let stored: unknown;
			const tx = {
				$queryRaw: jest
					.fn()
					.mockResolvedValue([{ fingerprint: 'a'.repeat(64) }]),
				homePageContent: {
					findUnique: jest
						.fn()
						.mockResolvedValue({ id: 'singleton', content: current }),
					update: jest
						.fn()
						.mockImplementation(
							({ data }: { data: { content: unknown } }) => {
								stored = data.content;
								return {
									id: 'singleton',
									content: data.content,
									updatedAt: new Date('2026-09-06T00:00:00Z')
								};
							}
						)
				},
				platformSourceSequence: {
					upsert: jest.fn().mockResolvedValue({ nextValue: 13n })
				},
				outboxEvent: { create: jest.fn().mockResolvedValue({}) }
			};
			const prisma = {
				$transaction: jest
					.fn()
					.mockImplementation((work: (transaction: unknown) => unknown) =>
						work(tx)
					)
			};
			await new PlatformHomePageContentService(
				prisma as never
			).updateStructured(
				{ content: patch },
				{
					actor: {
						active: true,
						subject: 'admin-fixture',
						sessionId: 'session-fixture',
						roles: ['ADMIN']
					}
				}
			);
			expect(stored).toEqual({ ...current, ...patch });
			expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
			expect(tx.outboxEvent.create.mock.calls[0][0]).toEqual(
				expect.objectContaining({
					data: expect.objectContaining({
						eventType: 'admin.audit.event.v1',
						routingKey: 'admin.audit.platform.v1',
						payload: expect.objectContaining({
							action: 'PLATFORM_HOME_PAGE_CONTENT_UPDATE',
							metadata: expect.objectContaining({ actorRole: 'ADMIN' })
						})
					})
				})
			);
			expect(prisma.$transaction).toHaveBeenCalledWith(
				expect.any(Function),
				{ isolationLevel: 'Serializable' }
			);
		}
	);
});
