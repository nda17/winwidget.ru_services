import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
	WidgetsAiGenerateInput,
	WidgetsAiProvider
} from './widgets-ai-provider';
import {
	WidgetsAiProviderResponseError,
	WidgetsAiProviderUnavailableError
} from './widgets-ai-provider';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com';

type FetchTransport = typeof fetch;

@Injectable()
export class WidgetsCloudflareAiProvider implements WidgetsAiProvider {
	private readonly logger = new Logger(WidgetsCloudflareAiProvider.name);
	private readonly accountId: string;
	private readonly apiToken: string;
	private readonly gatewayId: string;
	private readonly model: string;
	private readonly endpoint: string;
	private readonly timeoutMs: number;
	private readonly transport: FetchTransport = fetch;

	constructor(config: ConfigService) {
		this.accountId = this.required(
			config,
			'CLOUDFLARE_ACCOUNT_ID',
			/^[A-Za-z0-9_-]{8,64}$/
		);
		this.apiToken = this.required(config, 'CLOUDFLARE_API_TOKEN');
		this.gatewayId = this.required(
			config,
			'CLOUDFLARE_AI_GATEWAY_ID',
			/^[A-Za-z0-9_-]{1,64}$/
		);
		this.model = this.required(
			config,
			'CLOUDFLARE_AI_MODEL',
			/^@cf\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
		);
		this.timeoutMs = this.timeout(config);
		this.endpoint = `${this.apiOrigin(config)}/client/v4/accounts/${encodeURIComponent(this.accountId)}/ai/run`;
	}

	async generate(input: WidgetsAiGenerateInput): Promise<string> {
		const maxTokens = this.maxTokens(input.maxTokens);
		const messages = this.messages(input.messages, input.thinkingMode);
		let response: Response;
		try {
			response = await this.transport(this.endpoint, {
				method: 'POST',
				headers: {
					accept: 'application/json',
					authorization: `Bearer ${this.apiToken}`,
					'cache-control': 'no-store',
					'content-type': 'application/json',
					'cf-aig-gateway-id': this.gatewayId,
					'cf-aig-collect-log': 'false',
					'cf-aig-collect-log-payload': 'false',
					'cf-aig-skip-cache': 'true',
					'cf-aig-request-timeout': String(this.timeoutMs),
					'cf-aig-max-attempts': '1'
				},
				body: JSON.stringify({
					model: this.model,
					input: {
						messages,
						stream: false,
						max_tokens: maxTokens,
						temperature: 0.2,
						top_p: 0.8
					}
				}),
				signal: AbortSignal.timeout(this.timeoutMs),
				cache: 'no-store'
			});
		} catch (error) {
			this.logger.warn(
				`Cloudflare AI request failed code=${this.transportCode(error)}`
			);
			throw new WidgetsAiProviderUnavailableError(
				this.transportCode(error)
			);
		}

		let body: unknown;
		try {
			body = await this.readBoundedBody(response);
		} catch (error) {
			this.logger.warn(
				`Cloudflare AI response read failed status=${response.status}`
			);
			throw error instanceof Error &&
				error.message === 'AI_RESPONSE_TOO_LARGE'
				? new WidgetsAiProviderResponseError('RESPONSE_TOO_LARGE')
				: new WidgetsAiProviderUnavailableError('RESPONSE_READ_FAILED');
		}
		if (!response.ok) {
			this.logger.warn(
				`Cloudflare AI request failed status=${response.status}`
			);
			if (
				response.status === 408 ||
				response.status === 429 ||
				response.status >= 500
			) {
				throw new WidgetsAiProviderUnavailableError(
					`HTTP_${response.status}`
				);
			}
			throw new WidgetsAiProviderResponseError(`HTTP_${response.status}`);
		}

		const text = this.extractResponse(body);
		if (!text) {
			this.logger.warn('Cloudflare AI returned an invalid response shape');
			throw new WidgetsAiProviderResponseError('INVALID_RESPONSE_SHAPE');
		}
		return text;
	}

	private messages(
		messages: WidgetsAiGenerateInput['messages'],
		thinkingMode: WidgetsAiGenerateInput['thinkingMode']
	): WidgetsAiGenerateInput['messages'] {
		const normalized = messages.map(message => ({ ...message }));
		if (
			thinkingMode !== 'disabled' ||
			!/^@cf\/qwen\/qwen3(?:-|$)/i.test(this.model)
		) {
			return normalized;
		}
		const last = normalized.at(-1);
		if (!last) {
			throw new WidgetsAiProviderResponseError('MESSAGES_REQUIRED');
		}
		last.content = `${last.content.trimEnd()}\n/no_think`;
		return normalized;
	}

	private maxTokens(value: number | undefined): number {
		if (value === undefined) return 700;
		if (!Number.isInteger(value) || value < 16 || value > 700) {
			throw new WidgetsAiProviderResponseError('INVALID_MAX_TOKENS');
		}
		return value;
	}

	private required(
		config: ConfigService,
		key: string,
		pattern?: RegExp
	): string {
		const value = config.get<string>(key)?.trim() || '';
		if (!value || (pattern && !pattern.test(value))) {
			throw new Error(`${key} is required and must be valid`);
		}
		return value;
	}

	private timeout(config: ConfigService): number {
		const raw = config.get<string>('CLOUDFLARE_AI_TIMEOUT_MS')?.trim();
		if (!raw) return DEFAULT_TIMEOUT_MS;
		const value = Number(raw);
		if (
			!Number.isInteger(value) ||
			value < 1_000 ||
			value > MAX_TIMEOUT_MS
		) {
			throw new Error(
				`CLOUDFLARE_AI_TIMEOUT_MS must be between 1000 and ${MAX_TIMEOUT_MS}`
			);
		}
		return value;
	}

	private apiOrigin(config: ConfigService): string {
		const override = config
			.get<string>('CLOUDFLARE_AI_API_ORIGIN')
			?.trim();
		if (!override) return CLOUDFLARE_API_ORIGIN;
		if (config.get<string>('NODE_ENV') !== 'test') {
			throw new Error('CLOUDFLARE_AI_API_ORIGIN is allowed only in tests');
		}
		const parsed = new URL(override);
		if (
			parsed.protocol !== 'http:' ||
			!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) ||
			parsed.username ||
			parsed.password ||
			parsed.pathname !== '/' ||
			parsed.search ||
			parsed.hash
		) {
			throw new Error(
				'CLOUDFLARE_AI_API_ORIGIN must be a loopback HTTP origin in tests'
			);
		}
		return parsed.origin;
	}

	private async readBoundedBody(response: Response): Promise<unknown> {
		const declaredLength = Number(
			response.headers.get('content-length') || '0'
		);
		if (
			Number.isFinite(declaredLength) &&
			declaredLength > MAX_RESPONSE_BYTES
		) {
			await response.body?.cancel();
			throw new Error('AI_RESPONSE_TOO_LARGE');
		}
		if (!response.body) return null;
		const reader = response.body.getReader();
		const chunks: Buffer[] = [];
		let total = 0;
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				if (!next.value?.byteLength) continue;
				total += next.value.byteLength;
				if (total > MAX_RESPONSE_BYTES) {
					await reader.cancel();
					throw new Error('AI_RESPONSE_TOO_LARGE');
				}
				chunks.push(Buffer.from(next.value));
			}
		} finally {
			reader.releaseLock();
		}
		const raw = Buffer.concat(chunks, total).toString('utf8');
		try {
			return JSON.parse(raw) as unknown;
		} catch {
			return null;
		}
	}

	private extractResponse(value: unknown): string {
		const root = this.record(value);
		if (!root || root.success === false) return '';
		const result = this.record(root.result);
		if (!result) return '';
		if (typeof result.response === 'string') return result.response.trim();
		return this.choiceContent(result.choices);
	}

	private choiceContent(value: unknown): string {
		if (!Array.isArray(value) || !value.length) return '';
		const choice = this.record(value[0]);
		const message = this.record(choice?.message);
		return typeof message?.content === 'string'
			? message.content.trim()
			: '';
	}

	private record(value: unknown): Record<string, unknown> | null {
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	}

	private transportCode(error: unknown): string {
		if (error instanceof Error && error.name === 'TimeoutError') {
			return 'TIMEOUT';
		}
		return 'TRANSPORT_ERROR';
	}
}
