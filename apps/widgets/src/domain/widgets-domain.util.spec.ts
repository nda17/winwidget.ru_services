import type { Request } from 'express';
import { isAiDirectPageRequest } from './widgets-domain.util';

const request = (origin: string, referer: string) =>
	({ headers: { origin, referer } }) as unknown as Request;

describe('AI consultant direct preview boundary', () => {
	const key = 'abcdef123456';
	const path = 'page-ai-consultant';

	it('accepts only the exact platform hostname in production', () => {
		expect(
			isAiDirectPageRequest(
				request(
					'https://winwidget.ru',
					`https://winwidget.ru/${path}/${key}`
				),
				path,
				key,
				'production'
			)
		).toBe(true);
		expect(
			isAiDirectPageRequest(
				request(
					'https://www.winwidget.ru',
					`https://www.winwidget.ru/${path}/${key}`
				),
				path,
				key,
				'production'
			)
		).toBe(true);
	});

	it('rejects a forged platform Referer when Origin is another customer hostname', () => {
		expect(
			isAiDirectPageRequest(
				request(
					'https://other.example.test',
					`https://winwidget.ru/${path}/${key}`
				),
				path,
				key,
				'production'
			)
		).toBe(false);
	});

	it('permits localhost preview only outside production', () => {
		const local = request(
			'https://localhost:3000',
			`https://localhost:3000/${path}/${key}`
		);
		expect(isAiDirectPageRequest(local, path, key, 'test')).toBe(true);
		expect(isAiDirectPageRequest(local, path, key, 'production')).toBe(
			false
		);
	});
});
