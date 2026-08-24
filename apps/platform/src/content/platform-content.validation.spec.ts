import { BadRequestException } from '@nestjs/common';
import {
	sanitizeLegalHtml,
	validateAndSanitizeStructuredHomeContent,
	validateRawHomeContent
} from './platform-content.validation';

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
});
