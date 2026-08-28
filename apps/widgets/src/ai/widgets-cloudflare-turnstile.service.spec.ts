import {
	BadRequestException,
	ForbiddenException,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WidgetsCloudflareTurnstileService } from './widgets-cloudflare-turnstile.service';

const config = () =>
	new ConfigService({
		NODE_ENV: 'test',
		CLOUDFLARE_ACCOUNT_ID: 'account_12345678',
		CLOUDFLARE_API_TOKEN: 'cloudflare-secret-token',
		CLOUDFLARE_TURNSTILE_SITE_KEY: 'turnstile-site-key',
		CLOUDFLARE_TURNSTILE_SECRET_KEY: 'turnstile-secret-key',
		CLOUDFLARE_TURNSTILE_TIMEOUT_MS: '2000',
		CLOUDFLARE_AI_API_ORIGIN: 'http://127.0.0.1:8787',
		CLOUDFLARE_TURNSTILE_SITEVERIFY_ORIGIN: 'http://127.0.0.1:8788'
	});

const repository = (domains: string[] = []) => ({
	client: () => ({
		aiConsultant: {
			findMany: jest
				.fn()
				.mockResolvedValue(
					domains.map(installDomain => ({ installDomain }))
				)
		}
	})
});

const widgetSettingsResponse = () =>
	new Response(
		JSON.stringify({
			success: true,
			result: {
				name: 'WinWidget AI',
				mode: 'managed',
				clearance_level: 'no_clearance'
			}
		}),
		{ status: 200 }
	);

const hostnameUpdateResponse = (domains: string[]) =>
	new Response(JSON.stringify({ success: true, result: { domains } }), {
		status: 200
	});

describe('WidgetsCloudflareTurnstileService', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		jest.restoreAllMocks();
	});

	it('validates single-use challenge metadata against action, cdata, hostname and remote IP', async () => {
		const fetchMock = jest.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					action: 'ai-consultant-session',
					cdata: 'abcdef123456',
					hostname: 'shop.example.test',
					challenge_ts: new Date().toISOString()
				}),
				{ status: 200 }
			)
		);
		global.fetch = fetchMock as typeof fetch;
		const turnstile = new WidgetsCloudflareTurnstileService(
			config(),
			repository() as never
		);

		await turnstile.validate({
			token: 'one-time-token',
			ip: '203.0.113.7',
			expectedHostname: 'shop.example.test',
			publicKey: 'abcdef123456'
		});
		const [url, options] = fetchMock.mock.calls[0] as [
			string,
			RequestInit
		];
		expect(url).toBe('http://127.0.0.1:8788/turnstile/v0/siteverify');
		expect(JSON.parse(String(options.body))).toEqual({
			secret: 'turnstile-secret-key',
			response: 'one-time-token',
			remoteip: '203.0.113.7',
			idempotency_key: expect.any(String)
		});
	});

	it.each([
		{ action: 'wrong-action' },
		{ cdata: '000000000000' },
		{ hostname: 'other.example.test' },
		{ challenge_ts: new Date(Date.now() - 6 * 60_000).toISOString() }
	])(
		'fails closed for mismatched or stale challenge metadata',
		async override => {
			global.fetch = jest.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						success: true,
						action: 'ai-consultant-session',
						cdata: 'abcdef123456',
						hostname: 'shop.example.test',
						challenge_ts: new Date().toISOString(),
						...override
					}),
					{ status: 200 }
				)
			) as typeof fetch;
			const turnstile = new WidgetsCloudflareTurnstileService(
				config(),
				repository() as never
			);

			await expect(
				turnstile.validate({
					token: 'one-time-token',
					ip: '203.0.113.7',
					expectedHostname: 'shop.example.test',
					publicKey: 'abcdef123456'
				})
			).rejects.toBeInstanceOf(ForbiddenException);
		}
	);

	it('preserves required widget settings in deterministic hostname updates before publish', async () => {
		let rows: Array<{ id: string; installDomain: string }> = [];
		const findMany = jest.fn(async () => rows);
		const domains = ['shop.example.test', 'winwidget.ru'];
		const fetchMock = jest
			.fn()
			.mockResolvedValueOnce(widgetSettingsResponse())
			.mockResolvedValueOnce(hostnameUpdateResponse(domains))
			.mockResolvedValueOnce(widgetSettingsResponse())
			.mockResolvedValueOnce(hostnameUpdateResponse(domains));
		global.fetch = fetchMock as typeof fetch;
		const operation = jest.fn(async () => {
			rows = [{ id: 'widget-1', installDomain: 'shop.example.test' }];
			return 'published';
		});
		const turnstile = new WidgetsCloudflareTurnstileService(config(), {
			client: () => ({ aiConsultant: { findMany } })
		} as never);

		await expect(
			turnstile.withPublishedHostname(
				'widget-1',
				'shop.example.test',
				operation
			)
		).resolves.toBe('published');
		expect(fetchMock).toHaveBeenCalledTimes(4);
		const [, getOptions] = fetchMock.mock.calls[0] as [
			string,
			RequestInit
		];
		const [url, putOptions] = fetchMock.mock.calls[1] as [
			string,
			RequestInit
		];
		expect(getOptions.method).toBe('GET');
		expect(url).toBe(
			'http://127.0.0.1:8787/client/v4/accounts/account_12345678/challenges/widgets/turnstile-site-key'
		);
		expect(putOptions.method).toBe('PUT');
		expect(JSON.parse(String(putOptions.body))).toEqual({
			domains,
			mode: 'managed',
			name: 'WinWidget AI',
			clearance_level: 'no_clearance'
		});
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it('reserves a transition slot and rejects the ninth customer domain before publication', async () => {
		const existing = Array.from(
			{ length: 8 },
			(_, index) => `customer-${index + 1}.example.test`
		);
		const fetchMock = jest.fn();
		global.fetch = fetchMock as typeof fetch;
		const operation = jest.fn();
		const turnstile = new WidgetsCloudflareTurnstileService(
			config(),
			repository(existing) as never
		);

		await expect(
			turnstile.withPublishedHostname(
				'widget-1',
				'customer-9.example.test',
				operation
			)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(operation).not.toHaveBeenCalled();
	});

	it('allows direct-page publication without an external install domain', async () => {
		const domains = ['winwidget.ru'];
		const fetchMock = jest
			.fn()
			.mockResolvedValueOnce(widgetSettingsResponse())
			.mockResolvedValueOnce(hostnameUpdateResponse(domains))
			.mockResolvedValueOnce(widgetSettingsResponse())
			.mockResolvedValueOnce(hostnameUpdateResponse(domains));
		global.fetch = fetchMock as typeof fetch;
		const turnstile = new WidgetsCloudflareTurnstileService(
			config(),
			repository() as never
		);

		await expect(
			turnstile.withPublishedHostname(
				'widget-1',
				'',
				async () => 'published'
			)
		).resolves.toBe('published');
		for (const callIndex of [1, 3]) {
			const [, options] = fetchMock.mock.calls[callIndex] as [
				string,
				RequestInit
			];
			expect(JSON.parse(String(options.body)).domains).toEqual(domains);
		}
	});

	it('keeps the old live hostname before commit and removes it immediately after commit', async () => {
		const otherDomains = Array.from(
			{ length: 7 },
			(_, index) => `customer-${index + 1}.example.test`
		);
		let rows = [
			{ id: 'current-widget', installDomain: 'old.example.test' },
			...otherDomains.map((installDomain, index) => ({
				id: `other-${index}`,
				installDomain
			}))
		];
		const findMany = jest.fn().mockImplementation(async () => rows);
		const transitionDomains = [
			'new.example.test',
			'old.example.test',
			...otherDomains,
			'winwidget.ru'
		].sort();
		const committedDomains = transitionDomains.filter(
			domain => domain !== 'old.example.test'
		);
		const fetchMock = jest
			.fn()
			.mockResolvedValueOnce(widgetSettingsResponse())
			.mockResolvedValueOnce(hostnameUpdateResponse(transitionDomains))
			.mockResolvedValueOnce(widgetSettingsResponse())
			.mockResolvedValueOnce(hostnameUpdateResponse(committedDomains));
		global.fetch = fetchMock as typeof fetch;
		const turnstile = new WidgetsCloudflareTurnstileService(config(), {
			client: () => ({ aiConsultant: { findMany } })
		} as never);

		await turnstile.withPublishedHostname(
			'current-widget',
			'new.example.test',
			async () => {
				rows = rows.map(item =>
					item.id === 'current-widget'
						? { ...item, installDomain: 'new.example.test' }
						: item
				);
			}
		);
		expect(findMany).toHaveBeenCalledWith({
			where: { publishedAt: { not: null } },
			select: { id: true, installDomain: true }
		});
		const [, transitionPut] = fetchMock.mock.calls[1] as [
			string,
			RequestInit
		];
		const [, committedPut] = fetchMock.mock.calls[3] as [
			string,
			RequestInit
		];
		expect(JSON.parse(String(transitionPut.body)).domains).toEqual(
			transitionDomains
		);
		expect(JSON.parse(String(committedPut.body)).domains).toEqual(
			committedDomains
		);
	});

	it('restores the exact committed allowlist after a database publish failure', async () => {
		const rows = [
			{ id: 'current-widget', installDomain: 'old.example.test' }
		];
		const transition = [
			'new.example.test',
			'old.example.test',
			'winwidget.ru'
		];
		const committed = ['old.example.test', 'winwidget.ru'];
		const fetchMock = jest
			.fn()
			.mockResolvedValueOnce(widgetSettingsResponse())
			.mockResolvedValueOnce(hostnameUpdateResponse(transition))
			.mockResolvedValueOnce(widgetSettingsResponse())
			.mockResolvedValueOnce(hostnameUpdateResponse(committed));
		global.fetch = fetchMock as typeof fetch;
		const original = new Error('DB_PUBLISH_FAILED');
		const operation = jest.fn().mockRejectedValue(original);
		const turnstile = new WidgetsCloudflareTurnstileService(config(), {
			client: () => ({
				aiConsultant: { findMany: jest.fn().mockResolvedValue(rows) }
			})
		} as never);

		await expect(
			turnstile.withPublishedHostname(
				'current-widget',
				'new.example.test',
				operation
			)
		).rejects.toBe(original);
		const [, rollbackPut] = fetchMock.mock.calls[3] as [
			string,
			RequestInit
		];
		expect(JSON.parse(String(rollbackPut.body)).domains).toEqual(
			committed
		);
	});

	it('never publishes when the allowlist update is unavailable', async () => {
		global.fetch = jest
			.fn()
			.mockResolvedValue(
				new Response('{}', { status: 503 })
			) as typeof fetch;
		const operation = jest.fn();
		const turnstile = new WidgetsCloudflareTurnstileService(
			config(),
			repository() as never
		);

		await expect(
			turnstile.withPublishedHostname(
				'widget-1',
				'shop.example.test',
				operation
			)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(operation).not.toHaveBeenCalled();
	});
});
