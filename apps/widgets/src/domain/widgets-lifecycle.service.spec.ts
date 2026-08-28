import { BadRequestException } from '@nestjs/common';
import { WidgetsLifecycleService } from './widgets-lifecycle.service';
import {
	getWidgetDefinition,
	WidgetType,
	type WidgetEntity
} from './widgets-domain.types';

const candidate = (privacyUrl: string): WidgetEntity => ({
	id: 'ai-1',
	userId: 'owner-1',
	publicKey: 'abcdef123456',
	name: 'AI-консультант',
	isActive: true,
	installDomain: '',
	config: {},
	draftConfig: {
		...getWidgetDefinition(WidgetType.AI_CONSULTANT).defaultConfig(),
		instructionsPrompt: 'Товар стоит 1000 рублей.',
		privacyUrl
	},
	draftInstallDomain: '',
	draftRevision: 1,
	publishedVersion: 0,
	publishedFromDraftRevision: 0,
	publishedAt: null,
	createdAt: new Date('2026-08-28T00:00:00.000Z'),
	updatedAt: new Date('2026-08-28T00:00:00.000Z')
});

const service = () =>
	new WidgetsLifecycleService(
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never
	);

describe('WidgetsLifecycleService AI consultant readiness', () => {
	it.each([
		'',
		'javascript:alert(1)',
		'ftp://example.test/privacy',
		'not-a-url'
	])('blocks publish without an HTTP(S) privacy URL: %s', privacyUrl => {
		const lifecycle = service() as unknown as {
			assertPublishCandidate(
				type: WidgetType,
				widget: WidgetEntity,
				expectedDraftRevision: number
			): void;
		};

		expect(() =>
			lifecycle.assertPublishCandidate(
				WidgetType.AI_CONSULTANT,
				candidate(privacyUrl),
				1
			)
		).toThrow(BadRequestException);
		try {
			lifecycle.assertPublishCandidate(
				WidgetType.AI_CONSULTANT,
				candidate(privacyUrl),
				1
			);
		} catch (error) {
			expect(
				JSON.stringify((error as BadRequestException).getResponse())
			).toContain('PRIVACY_URL_REQUIRED');
		}
	});

	it.each(['http://example.test/privacy', 'https://example.test/privacy'])(
		'accepts an HTTP(S) privacy URL for publish: %s',
		privacyUrl => {
			const lifecycle = service() as unknown as {
				assertPublishCandidate(
					type: WidgetType,
					widget: WidgetEntity,
					expectedDraftRevision: number
				): void;
			};

			expect(() =>
				lifecycle.assertPublishCandidate(
					WidgetType.AI_CONSULTANT,
					candidate(privacyUrl),
					1
				)
			).not.toThrow();
		}
	);

	it.each([
		WidgetType.AI_CONSULTANT,
		WidgetType.STOP_OFFER,
		WidgetType.TIMER
	])('does not advertise a direct link without a domain for %s', type => {
		const lifecycle = service() as unknown as {
			readiness(
				type: WidgetType,
				widget: WidgetEntity
			): {
				warnings: Array<{ code: string; message: string }>;
			};
		};

		const readiness = lifecycle.readiness(
			type,
			candidate('https://example.test/privacy')
		);

		expect(readiness.warnings).toContainEqual({
			code: 'INSTALL_DOMAIN_REQUIRED',
			message: 'Домен не указан — виджет не появится на сайте'
		});
		expect(JSON.stringify(readiness.warnings)).not.toContain(
			'только по прямой ссылке'
		);
	});

	it('keeps the direct-link warning for widgets that expose the control', () => {
		const lifecycle = service() as unknown as {
			readiness(
				type: WidgetType,
				widget: WidgetEntity
			): {
				warnings: Array<{ code: string; message: string }>;
			};
		};

		const readiness = lifecycle.readiness(
			WidgetType.WHEEL,
			candidate('https://example.test/privacy')
		);

		expect(readiness.warnings).toContainEqual({
			code: 'INSTALL_DOMAIN_REQUIRED',
			message:
				'Домен не указан — виджет будет работать только по прямой ссылке'
		});
	});
});
