import {
	ForbiddenException,
	HttpException,
	ServiceUnavailableException
} from '@nestjs/common';
import type { CustomersAuthorization } from '../access/customers-authorization.client';
import { CompanyLookupService } from './company-lookup.service';
import { DadataCompanyLookupAdapter } from './dadata-company-lookup.adapter';
import { CompanyLookupProvider } from './company-lookup.provider';
import type { CompanyLookupResult } from './company-lookup.contract';

const inn = '7707083893';
const secondInn = '7719402047';
const ipInn = '784806113663';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const context = (
	patch: Partial<CustomersAuthorization> = {}
): CustomersAuthorization => ({
	schemaVersion: 1,
	workspaceId,
	subject: 'actor',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['customers:read', 'customers:write'],
	...patch
});
const empty = () =>
	new Response(JSON.stringify({ suggestions: [] }), {
		headers: { 'content-type': 'application/json' }
	});
const found = () =>
	new Response(
		JSON.stringify({
			suggestions: [
				{
					data: {
						inn,
						type: 'LEGAL',
						branch_type: 'MAIN',
						kpp: null,
						ogrn: null,
						address: null,
						name: {
							short_with_opf: 'Название',
							full_with_opf: 'Полное название'
						},
						state: { status: 'ACTIVE' }
					}
				}
			]
		}),
		{ headers: { 'content-type': 'application/json' } }
	);
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};

describe('CompanyLookupService guarded provider lookup', () => {
	const originalKey = process.env.CRM_CUSTOMERS_DADATA_API_KEY;
	let transport: jest.SpyInstance;
	let service: CompanyLookupService;
	beforeEach(() => {
		process.env.CRM_CUSTOMERS_DADATA_API_KEY =
			'unit-test-placeholder-key-not-a-credential';
		transport = jest
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => empty());
		service = new CompanyLookupService(new DadataCompanyLookupAdapter());
	});
	it('accepts a replacement provider without DaData configuration or transport', async () => {
		delete process.env.CRM_CUSTOMERS_DADATA_API_KEY;
		const snapshot: CompanyLookupResult = Object.freeze({
			schemaVersion: 1,
			provider: 'OTHER_PROVIDER',
			queriedAt: '2026-09-07T09:00:00.000Z',
			inn,
			items: Object.freeze([])
		});
		class AlternativeProvider extends CompanyLookupProvider {
			assertConfigured = jest.fn();
			lookup = jest.fn(async () => snapshot);
		}
		const provider = new AlternativeProvider();
		const replacement = new CompanyLookupService(provider);
		await expect(replacement.lookup(context(), inn)).resolves.toBe(
			snapshot
		);
		await expect(replacement.lookup(context(), inn)).resolves.toBe(
			snapshot
		);
		expect(provider.lookup).toHaveBeenCalledTimes(1);
		expect(provider.assertConfigured).toHaveBeenCalledTimes(2);
		await expect(
			replacement.lookup(context({ state: 'READ_ONLY' }), inn)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(provider.lookup).toHaveBeenCalledTimes(1);
		expect(transport).not.toHaveBeenCalled();
	});
	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
		if (originalKey === undefined)
			delete process.env.CRM_CUSTOMERS_DADATA_API_KEY;
		else process.env.CRM_CUSTOMERS_DADATA_API_KEY = originalKey;
	});
	it.each([inn, ipInn])(
		'uses only fixed HTTPS POST with exact provider restrictions %#',
		async value => {
			await service.lookup(context(), value);
			expect(transport).toHaveBeenCalledTimes(1);
			expect(transport).toHaveBeenCalledWith(
				'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party',
				{
					method: 'POST',
					redirect: 'error',
					signal: expect.any(AbortSignal),
					headers: {
						'content-type': 'application/json',
						accept: 'application/json',
						authorization:
							'Token unit-test-placeholder-key-not-a-credential'
					},
					body: JSON.stringify({
						query: value,
						branch_type: 'MAIN',
						type: value.length === 10 ? 'LEGAL' : 'INDIVIDUAL',
						count: 5
					})
				}
			);
		}
	);
	it.each([
		{ state: 'READ_ONLY' as const },
		{ permissions: ['customers:read'] },
		{ permissions: ['customers:write'] },
		{ permissions: [] }
	])(
		'checks read/write/current state before cache or transport %#',
		async patch => {
			await service.lookup(context(), inn);
			transport.mockClear();
			await expect(
				service.lookup(context(patch), inn)
			).rejects.toBeInstanceOf(ForbiddenException);
			expect(transport).not.toHaveBeenCalled();
		}
	);
	it.each([
		undefined,
		'',
		' ',
		'bad\r\nHeader',
		'placeholder-key',
		'x'.repeat(513)
	])(
		'does not fail boot for absent/invalid optional key but makes no provider call %#',
		async key => {
			if (key === undefined)
				delete process.env.CRM_CUSTOMERS_DADATA_API_KEY;
			else process.env.CRM_CUSTOMERS_DADATA_API_KEY = key;
			expect(
				() => new CompanyLookupService(new DadataCompanyLookupAdapter())
			).not.toThrow();
			await expect(service.lookup(context(), inn)).rejects.toMatchObject({
				response: { code: 'crm_company_lookup_unavailable' },
				status: 503
			});
			expect(transport).not.toHaveBeenCalled();
		}
	);
	it('rejects invalid checksum without a provider call or retry', async () => {
		await expect(
			service.lookup(context(), '7707083894')
		).rejects.toMatchObject({ status: 400 });
		expect(transport).not.toHaveBeenCalled();
	});
	it('shares one provider request across concurrent authorized lookups', async () => {
		const response = deferred<Response>();
		transport.mockReturnValue(response.promise);
		const first = service.lookup(context(), inn);
		const second = service.lookup(context({ subject: 'another' }), inn);
		expect(transport).toHaveBeenCalledTimes(1);
		response.resolve(found());
		const [a, b] = await Promise.all([first, second]);
		expect(a).toBe(b);
		expect(Object.isFrozen(a)).toBe(true);
	});
	it('limits provider concurrency to two without queueing, then releases slots', async () => {
		const response = deferred<Response>();
		const secondResponse = deferred<Response>();
		transport
			.mockReturnValueOnce(response.promise)
			.mockReturnValueOnce(secondResponse.promise);
		const first = service.lookup(context(), inn);
		const second = service.lookup(context(), secondInn);
		await expect(service.lookup(context(), ipInn)).rejects.toMatchObject({
			status: 429,
			response: { retryAfterSeconds: 5 }
		});
		expect(transport).toHaveBeenCalledTimes(2);
		// Each fetch must own its body stream.
		response.resolve(empty());
		secondResponse.resolve(empty());
		await expect(Promise.all([first, second])).resolves.toMatchObject([
			{ items: [] },
			{ items: [] }
		]);
		transport.mockImplementation(async () => empty());
		await expect(service.lookup(context(), ipInn)).resolves.toMatchObject({
			items: []
		});
		expect(transport).toHaveBeenCalledTimes(3);
	});
	it('caches positive snapshots for fifteen minutes without changing queriedAt', async () => {
		jest.useFakeTimers({ now: Date.UTC(2026, 8, 7) });
		transport.mockImplementation(async () => found());
		const first = await service.lookup(context(), inn);
		jest.setSystemTime(Date.now() + 14 * 60_000 + 59_999);
		expect(await service.lookup(context(), inn)).toBe(first);
		expect(transport).toHaveBeenCalledTimes(1);
		jest.setSystemTime(Date.now() + 1);
		const next = await service.lookup(context(), inn);
		expect(next.queriedAt).not.toBe(first.queriedAt);
		expect(transport).toHaveBeenCalledTimes(2);
	});
	it('caches valid not-found only for thirty seconds', async () => {
		jest.useFakeTimers({ now: Date.UTC(2026, 8, 7) });
		const first = await service.lookup(context(), inn);
		jest.setSystemTime(Date.now() + 29_999);
		expect(await service.lookup(context(), inn)).toBe(first);
		jest.setSystemTime(Date.now() + 1);
		await service.lookup(context(), inn);
		expect(transport).toHaveBeenCalledTimes(2);
	});
	it('bounds the cache at 1000 and evicts the oldest untouched entry', async () => {
		const result = await service.lookup(context(), inn);
		const cache = service['cache'];
		cache.clear();
		for (let index = 0; index < 1000; index++)
			cache.set(`fixture-${index}`, {
				expiresAt: Date.now() + 60_000,
				result
			});
		await service.lookup(context(), secondInn);
		expect(cache.size).toBe(1000);
		expect(cache.has('fixture-0')).toBe(false);
		expect(cache.has('fixture-1')).toBe(true);
	});
	it('applies actor, workspace and global minute limits including cache hits', async () => {
		jest.useFakeTimers({ now: Date.UTC(2026, 8, 7) });
		for (let count = 0; count < 10; count++)
			await service.lookup(context(), inn);
		await expect(service.lookup(context(), inn)).rejects.toMatchObject({
			status: 429,
			response: { retryAfterSeconds: 60 }
		});
		for (let count = 0; count < 10; count++)
			await service.lookup(context({ subject: 'second' }), inn);
		await expect(
			service.lookup(context({ subject: 'third' }), inn)
		).rejects.toMatchObject({ status: 429 });
		for (let count = 0; count < 10; count++)
			await service.lookup(
				context({ workspaceId: '22222222-2222-4222-8222-222222222222' }),
				inn
			);
		await expect(
			service.lookup(
				context({ workspaceId: '33333333-3333-4333-8333-333333333333' }),
				inn
			)
		).rejects.toMatchObject({ status: 429 });
		expect(transport).toHaveBeenCalledTimes(1);
		expect(service['requests']).toHaveLength(30);
		jest.setSystemTime(Date.now() + 59_001);
		await expect(service.lookup(context(), inn)).rejects.toMatchObject({
			response: { retryAfterSeconds: 1 }
		});
		jest.setSystemTime(Date.now() + 999);
		await expect(service.lookup(context(), inn)).resolves.toMatchObject({
			items: []
		});
		expect(service['requests']).toHaveLength(1);
	});
	it.each([301, 302, 400, 401, 403, 429, 500, 503])(
		'does not expose provider status %s as client auth or not-found',
		async status => {
			transport.mockImplementation(
				async () => new Response('PRIVATE_UPSTREAM_DETAIL', { status })
			);
			await expect(service.lookup(context(), inn)).rejects.toMatchObject({
				status: 503,
				response: { code: 'crm_company_lookup_unavailable' }
			});
			expect(transport).toHaveBeenCalledTimes(1);
		}
	);
	it('does not cache provider failures or log their secret-bearing errors', async () => {
		const log = jest
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		transport
			.mockRejectedValueOnce(new Error('PRIVATE_KEY_HEADERS_AND_URL'))
			.mockImplementation(async () => empty());
		let caught: unknown;
		try {
			await service.lookup(context(), inn);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ServiceUnavailableException);
		expect(String(caught)).not.toContain('PRIVATE_');
		expect(log).not.toHaveBeenCalled();
		await service.lookup(context(), inn);
		expect(transport).toHaveBeenCalledTimes(2);
	});
	it.each([
		{ body: '<html>private</html>', type: 'text/html' },
		{ body: '{invalid', type: 'application/json' },
		{ body: '{}', type: 'application/json' },
		{ body: '{"suggestions":null}', type: 'application/json' }
	])(
		'rejects invalid provider body %# instead of negative caching',
		async ({ body, type }) => {
			transport.mockImplementation(
				async () =>
					new Response(body, { headers: { 'content-type': type } })
			);
			for (let attempt = 0; attempt < 2; attempt++)
				await expect(
					service.lookup(context(), inn)
				).rejects.toBeInstanceOf(ServiceUnavailableException);
			expect(transport).toHaveBeenCalledTimes(2);
		}
	);
	it('cancels an oversized declared body without reading it', async () => {
		const cancelled = jest.fn();
		const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
		transport.mockResolvedValue(
			new Response(body, {
				headers: {
					'content-type': 'application/json',
					'content-length': String(2 * 1024 * 1024 + 1)
				}
			})
		);
		await expect(service.lookup(context(), inn)).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
		expect(cancelled).toHaveBeenCalledTimes(1);
	});
	it('caps streamed bytes even without content length and cancels the reader', async () => {
		const cancelled = jest.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(2 * 1024 * 1024));
				controller.enqueue(new Uint8Array(1));
			},
			cancel: cancelled
		});
		transport.mockResolvedValue(
			new Response(body, {
				headers: { 'content-type': 'application/json' }
			})
		);
		await expect(service.lookup(context(), inn)).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
		expect(cancelled).toHaveBeenCalledTimes(1);
	});
	it('rejects malformed UTF-8 without replacement-character coercion', async () => {
		transport.mockResolvedValue(
			new Response(new Uint8Array([0xc3, 0x28]), {
				headers: { 'content-type': 'application/json' }
			})
		);
		await expect(service.lookup(context(), inn)).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
	});
	it('times out before headers even when a transport promise ignores abort', async () => {
		jest.useFakeTimers();
		transport.mockReturnValue(new Promise(() => undefined));
		const pending = service.lookup(context(), inn);
		const expectation = expect(pending).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
		await jest.advanceTimersByTimeAsync(5000);
		await expectation;
		expect(
			(transport.mock.calls[0][1] as RequestInit).signal?.aborted
		).toBe(true);
		expect(service['pending'].size).toBe(0);
		expect(transport).toHaveBeenCalledTimes(1);
	});
	it('times out and cancels a stalled response stream, releasing the single-flight slot', async () => {
		jest.useFakeTimers();
		const cancelled = jest.fn();
		transport.mockResolvedValue(
			new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), {
				headers: { 'content-type': 'application/json' }
			})
		);
		const pending = service.lookup(context(), inn);
		const expectation =
			expect(pending).rejects.toBeInstanceOf(HttpException);
		await jest.advanceTimersByTimeAsync(5000);
		await expectation;
		expect(cancelled).toHaveBeenCalledTimes(1);
		expect(service['pending'].size).toBe(0);
	});
});
