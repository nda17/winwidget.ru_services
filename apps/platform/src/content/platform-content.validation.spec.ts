import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	sanitizeLegalHtml,
	validateAndSanitizeStructuredHomeContent,
	validateRawHomeContent
} from './platform-content.validation';

const legacyDemoWidgetCleanupMigration = readFileSync(
	resolve(
		__dirname,
		'../../prisma/migrations/20260825000000_remove_legacy_demo_widget_labels/migration.sql'
	),
	'utf8'
);

const aiConsultantContentMigration = readFileSync(
	resolve(
		__dirname,
		'../../prisma/migrations/20260827220000_replace_online_consultant_home_content/migration.sql'
	),
	'utf8'
);

const aiConsultantHomeCardMigration = readFileSync(
	resolve(
		__dirname,
		'../../prisma/migrations/20260828010000_publish_ai_consultant_home_card/migration.sql'
	),
	'utf8'
);

describe('Platform content validation', () => {
	it('removes executable legal markup and every dangerous URL form', () => {
		const sanitized = sanitizeLegalHtml(
			'<p onclick="alert(1)">Text</p>' +
				'<script>alert(1)</script><iframe src="https://attacker.test"></iframe>' +
				'<img src="x" onerror="alert(1)">' +
				'<a href="javascript:alert(1)">javascript</a>' +
				'<a href="data:text/html;base64,PHNjcmlwdD4=">data</a>' +
				'<a href="//attacker.test/path">protocol-relative</a>'
		);
		expect(sanitized).toBe(
			'<p>Text</p><a>javascript</a><a>data</a><a>protocol-relative</a>'
		);
	});

	it('preserves the explicit legal TipTap tag allowlist', () => {
		expect(
			sanitizeLegalHtml(
				'<h1>H1</h1><h2>H2</h2><h3>H3</h3><h4>H4</h4>' +
					'<p>Text<br><strong>strong</strong><em>em</em><u>u</u><s>s</s><code>code</code></p>' +
					'<ul><li>one</li></ul><ol><li>two</li></ol><blockquote>quote</blockquote>' +
					'<section data-winwidget-section="renewal" class="unsupported">section</section>'
			)
		).toBe(
			'<h1>H1</h1><h2>H2</h2><h3>H3</h3><h4>H4</h4>' +
				'<p>Text<br /><strong>strong</strong><em>em</em><u>u</u><s>s</s><code>code</code></p>' +
				'<ul><li>one</li></ul><ol><li>two</li></ol><blockquote>quote</blockquote>' +
				'<section data-winwidget-section="renewal">section</section>'
		);
	});

	it('canonicalizes target blank links and drops unsupported link attributes', () => {
		expect(
			sanitizeLegalHtml(
				'<a href="https://winwidget.ru/legal" target="_blank" rel="opener" onclick="alert(1)">safe</a>' +
					'<a href="mailto:support@winwidget.ru">mail</a><a href="tel:+79991234567">phone</a>'
			)
		).toBe(
			'<a href="https://winwidget.ru/legal" target="_blank" rel="noopener noreferrer">safe</a>' +
				'<a href="mailto:support@winwidget.ru">mail</a><a href="tel:+79991234567">phone</a>'
		);
	});

	it('preserves only the current TipTap heading and alignment output', () => {
		expect(
			sanitizeLegalHtml(
				'<h1 style="text-align: center">Title</h1><p style="text-align: right">Text</p>'
			)
		).toBe(
			'<h1 style="text-align:center">Title</h1><p style="text-align:right">Text</p>'
		);
	});

	it('strips hostile and unsupported inline styles', () => {
		expect(
			sanitizeLegalHtml(
				'<h2 style="text-align:justify;color:red;background:url(javascript:alert(1))">Title</h2><div style="text-align:center">Text</div>'
			)
		).toBe('<h2>Title</h2>Text');
	});

	it('accepts the exact raw-code contract', () => {
		expect(
			validateRawHomeContent({
				head: { enabled: true, html: '<meta name="x" content="y">' },
				body: { enabled: false, html: '' }
			})
		).toEqual({
			head: { enabled: true, html: '<meta name="x" content="y">' },
			body: { enabled: false, html: '' }
		});
	});

	it('rejects structured fields in the DEV raw-code contract', () => {
		expect(() =>
			validateRawHomeContent({
				head: { enabled: true, html: '' },
				body: { enabled: false, html: '' },
				hero: {}
			})
		).toThrow(BadRequestException);
	});

	it('rejects head/body in the ADMIN structured contract', () => {
		expect(() =>
			validateAndSanitizeStructuredHomeContent({
				head: { enabled: true, html: '<script>bad()</script>' }
			})
		).toThrow('Invalid structured field: content.head');
	});

	it('keeps the legacy demo widget cleanup forward-only, narrow and idempotent', () => {
		const imported = {
			seo: { title: 'untouched' },
			demoWidgets: {
				enabled: true,
				bubbleTexts: { wheel: 'untouched' },
				labels: { wheel: 'legacy label' }
			}
		};
		const canonical = structuredClone(imported);
		expect(() =>
			validateAndSanitizeStructuredHomeContent({
				seo: {
					title: '',
					description: '',
					keywords: [],
					ogTitle: '',
					ogDescription: ''
				},
				technicalSeo: {
					baseUrl: '',
					robotsDisallow: [],
					sitemapItems: []
				},
				demoWidgets: imported.demoWidgets
			})
		).toThrow('Invalid structured field: content.demoWidgets.labels');

		expect(Reflect.deleteProperty(canonical.demoWidgets, 'labels')).toBe(
			true
		);
		expect(canonical).toEqual({
			seo: { title: 'untouched' },
			demoWidgets: {
				enabled: true,
				bubbleTexts: { wheel: 'untouched' }
			}
		});
		const onceCanonical = structuredClone(canonical);
		expect(Reflect.deleteProperty(canonical.demoWidgets, 'labels')).toBe(
			true
		);
		expect(canonical).toEqual(onceCanonical);

		expect(legacyDemoWidgetCleanupMigration.trimStart()).toMatch(
			/^BEGIN;/
		);
		expect(legacyDemoWidgetCleanupMigration.trimEnd()).toMatch(/COMMIT;$/);
		expect(legacyDemoWidgetCleanupMigration).toContain(
			'SET "content" = "content" #- ARRAY[\'demoWidgets\', \'labels\']::TEXT[]'
		);
		expect(legacyDemoWidgetCleanupMigration).toContain(
			'WHERE "id" = \'singleton\''
		);
		expect(legacyDemoWidgetCleanupMigration).toContain(
			'pg_catalog.jsonb_typeof("content") = \'object\''
		);
		expect(legacyDemoWidgetCleanupMigration).toContain(
			"pg_catalog.jsonb_typeof(\"content\" -> 'demoWidgets') = 'object'"
		);
		expect(legacyDemoWidgetCleanupMigration).toContain(
			"(\"content\" -> 'demoWidgets') ? 'labels'"
		);
		expect(legacyDemoWidgetCleanupMigration).toContain(
			'IF updated_rows = 1 THEN'
		);
		expect(legacyDemoWidgetCleanupMigration).toContain(
			'"platform"."refresh_current_semantic_fingerprint"('
		);
		expect(legacyDemoWidgetCleanupMigration).toContain(
			'"platform"."current_semantic_fingerprint"()'
		);
		expect(legacyDemoWidgetCleanupMigration).not.toContain(
			'"content" - \'demoWidgets\''
		);
		expect(legacyDemoWidgetCleanupMigration).not.toContain(
			'"content" - \'labels\''
		);
	});

	it('migrates persisted AI consultant landing content without a runtime alias', () => {
		expect(aiConsultantContentMigration.trimStart()).toMatch(/^BEGIN;/);
		expect(aiConsultantContentMigration.trimEnd()).toMatch(/COMMIT;$/);
		expect(aiConsultantContentMigration).toContain(
			"nested_content - 'onlineConsultant'"
		);
		expect(aiConsultantContentMigration).toContain(
			"'aiConsultant',\n                    'Задайте вопрос AI-оператору'"
		);
		expect(aiConsultantContentMigration).toContain(
			'Winwidget — AI-консультант и виджеты для сайта'
		);
		expect(aiConsultantContentMigration).toContain(
			'Сервис требует подтверждать ответ фрагментом вашей инструкции.'
		);
		expect(aiConsultantContentMigration).toContain(
			'Покупатель быстро получает информацию из инструкции компании, а важные условия можно перепроверить.'
		);
		expect(aiConsultantContentMigration).toContain(
			'AI-оператор не обходит сайт и сообщает, что подтверждённых данных недостаточно.'
		);
		expect(aiConsultantContentMigration).not.toContain(
			'получает точную информацию'
		);
		expect(aiConsultantContentMigration).not.toContain(
			'не додумывает ответ'
		);
		expect(aiConsultantContentMigration).toContain('/ai-consultants/');
		expect(aiConsultantContentMigration).toContain('/page-ai-consultant/');
		expect(aiConsultantContentMigration).toContain(
			'"platform"."refresh_current_semantic_fingerprint"('
		);
	});

	it('publishes the persisted AI consultant home card', () => {
		expect(aiConsultantHomeCardMigration.trimStart()).toMatch(/^BEGIN;/);
		expect(aiConsultantHomeCardMigration.trimEnd()).toMatch(/COMMIT;$/);
		expect(aiConsultantHomeCardMigration).toContain(
			"item.value ->> 'previewType' = 'aiConsultant'"
		);
		expect(aiConsultantHomeCardMigration).toContain("'{comingSoon}'");
		expect(aiConsultantHomeCardMigration).toContain("'false'::JSONB");
		expect(aiConsultantHomeCardMigration).toContain(
			'ORDER BY item.ordinality'
		);
		expect(aiConsultantHomeCardMigration).toContain(
			"tools_content := pg_catalog.jsonb_set(\n        tools_content,\n        '{items}',\n        transformed_items,\n        false\n    );"
		);
		expect(aiConsultantHomeCardMigration).toContain(
			'AND "content" IS DISTINCT FROM current_content'
		);
		expect(aiConsultantHomeCardMigration).toContain(
			'IF ai_consultant_items = 0 THEN'
		);
		expect(aiConsultantHomeCardMigration).toContain(
			'Platform tools must not contain duplicate AI consultant cards'
		);
		expect(aiConsultantHomeCardMigration).toContain(
			'"platform"."refresh_current_semantic_fingerprint"('
		);
		expect(aiConsultantHomeCardMigration).toMatch(
			/IF updated_rows = 1 THEN\s+PERFORM "platform"\."refresh_current_semantic_fingerprint"/
		);
	});
});
