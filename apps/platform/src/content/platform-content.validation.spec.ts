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

describe('Platform content validation', () => {
	it('removes executable legal markup and dangerous URL schemes', () => {
		const sanitized = sanitizeLegalHtml(
			'<p onclick="alert(1)">Text</p><script>alert(1)</script><a href="javascript:alert(1)">link</a>'
		);
		expect(sanitized).toBe('<p>Text</p><a>link</a>');
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
});
