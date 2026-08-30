import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WidgetsCloudflareAiProvider } from './widgets-cloudflare-ai.provider';
import {
	WidgetsAiProviderResponseError,
	WidgetsAiProviderUnavailableError
} from './widgets-ai-provider';

const config = (overrides: Record<string, string> = {}) =>
	new ConfigService({
		CLOUDFLARE_ACCOUNT_ID: 'account_12345678',
		CLOUDFLARE_API_TOKEN: 'secret-token',
		CLOUDFLARE_AI_GATEWAY_ID: 'winwidget-ai',
		CLOUDFLARE_AI_MODEL: '@cf/qwen/qwen3-30b-a3b-fp8',
		CLOUDFLARE_AI_TIMEOUT_MS: '20000',
		...overrides
	});

describe('WidgetsCloudflareAiProvider', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		jest.restoreAllMocks();
	});

	it('uses the current AI Gateway REST contract without logging or cache', async () => {
		const fetchMock = jest.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					result: { response: '{"outcome":"ANSWER","reply":"OK"}' }
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			)
		);
		global.fetch = fetchMock as typeof fetch;
		const provider = new WidgetsCloudflareAiProvider(config());
		const messages = [
			{ role: 'system' as const, content: 'fixed rules' },
			{ role: 'user' as const, content: 'Секретный вопрос' }
		];

		await expect(
			provider.generate({ messages, thinkingMode: 'disabled' })
		).resolves.toBe('{"outcome":"ANSWER","reply":"OK"}');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, options] = fetchMock.mock.calls[0] as [
			string,
			RequestInit
		];
		expect(url).toBe(
			'https://api.cloudflare.com/client/v4/accounts/account_12345678/ai/run'
		);
		expect(options).toMatchObject({
			method: 'POST',
			cache: 'no-store',
			headers: expect.objectContaining({
				authorization: 'Bearer secret-token',
				'cache-control': 'no-store',
				'cf-aig-gateway-id': 'winwidget-ai',
				'cf-aig-collect-log': 'false',
				'cf-aig-collect-log-payload': 'false',
				'cf-aig-skip-cache': 'true',
				'cf-aig-max-attempts': '1'
			})
		});
		const request = JSON.parse(String(options.body));
		expect(request).toEqual({
			model: '@cf/qwen/qwen3-30b-a3b-fp8',
			input: {
				messages: [
					messages[0],
					{ ...messages[1], content: 'Секретный вопрос\n/no_think' }
				],
				stream: false,
				max_tokens: 700,
				temperature: 0.2,
				top_p: 0.8
			}
		});
		expect(
			request.input.messages.at(-1).content.endsWith('/no_think')
		).toBe(true);
	});

	it('uses a separately bounded completion budget for verifier calls', async () => {
		const fetchMock = jest.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					result: { response: '{"supported":true}' }
				}),
				{ status: 200 }
			)
		);
		global.fetch = fetchMock as typeof fetch;
		const provider = new WidgetsCloudflareAiProvider(config());

		await provider.generate({
			messages: [
				{ role: 'system', content: 'GROUNDING_VERIFIER_V1' },
				{ role: 'user', content: 'candidate payload' }
			],
			maxTokens: 32,
			thinkingMode: 'disabled'
		});

		const options = fetchMock.mock.calls[0][1] as RequestInit;
		const request = JSON.parse(String(options.body));
		expect(request.input.max_tokens).toBe(32);
		expect(request.input.messages.at(-1).content).toBe(
			'candidate payload\n/no_think'
		);
	});

	it('logs only safe transport metadata when Cloudflare rejects a request', async () => {
		global.fetch = jest
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ errors: [{ message: 'Секретный prompt' }] }),
					{ status: 429 }
				)
			) as typeof fetch;
		const warning = jest
			.spyOn(Logger.prototype, 'warn')
			.mockImplementation();
		const provider = new WidgetsCloudflareAiProvider(config());

		await expect(
			provider.generate({
				messages: [{ role: 'user', content: 'Секретный prompt' }],
				thinkingMode: 'disabled'
			})
		).rejects.toBeInstanceOf(WidgetsAiProviderUnavailableError);
		expect(warning).toHaveBeenCalledWith(
			'Cloudflare AI request failed status=429'
		);
		expect(JSON.stringify(warning.mock.calls)).not.toContain(
			'Секретный prompt'
		);
	});

	it('fails closed when mandatory Cloudflare configuration is absent', () => {
		expect(
			() =>
				new WidgetsCloudflareAiProvider(
					config({ CLOUDFLARE_API_TOKEN: '' })
				)
		).toThrow('CLOUDFLARE_API_TOKEN is required and must be valid');
	});

	it('keeps two sequential provider calls inside the public Gateway deadline', () => {
		expect(
			() =>
				new WidgetsCloudflareAiProvider(
					config({ CLOUDFLARE_AI_TIMEOUT_MS: '20001' })
				)
		).toThrow('CLOUDFLARE_AI_TIMEOUT_MS must be between 1000 and 20000');
	});

	it('cancels a response stream as soon as it exceeds the byte limit', async () => {
		global.fetch = jest
			.fn()
			.mockResolvedValue(
				new Response('x'.repeat(65 * 1024), { status: 200 })
			) as typeof fetch;
		const warning = jest
			.spyOn(Logger.prototype, 'warn')
			.mockImplementation();
		const provider = new WidgetsCloudflareAiProvider(config());

		await expect(
			provider.generate({
				messages: [{ role: 'user', content: 'bounded request' }],
				thinkingMode: 'disabled'
			})
		).rejects.toBeInstanceOf(WidgetsAiProviderResponseError);
		expect(warning).toHaveBeenCalledWith(
			'Cloudflare AI response read failed status=200'
		);
	});

	it('classifies tenant and model request errors separately from availability failures', async () => {
		global.fetch = jest
			.fn()
			.mockResolvedValue(
				new Response('{}', { status: 400 })
			) as typeof fetch;
		const provider = new WidgetsCloudflareAiProvider(config());

		await expect(
			provider.generate({
				messages: [{ role: 'user', content: 'bounded request' }],
				thinkingMode: 'disabled'
			})
		).rejects.toBeInstanceOf(WidgetsAiProviderResponseError);
	});
});
