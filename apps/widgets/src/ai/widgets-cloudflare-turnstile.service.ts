import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	Logger,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { normalizeExactInstallDomain } from '../domain/widgets-domain.util';
import { WidgetsDomainRepository } from '../domain/widgets-domain.repository';

const TURNSTILE_ACTION = 'ai-consultant-session';
const TURNSTILE_TOKEN_MAX_AGE_MS = 5 * 60_000;
const TURNSTILE_CLOCK_SKEW_MS = 30_000;
const TURNSTILE_HOSTNAME_LIMIT = 10;
const TURNSTILE_PLATFORM_HOSTNAME = 'winwidget.ru';
const TURNSTILE_MODES = new Set([
	'managed',
	'non-interactive',
	'invisible'
]);
const TURNSTILE_CLEARANCE_LEVELS = new Set([
	'no_clearance',
	'jschallenge',
	'managed',
	'interactive'
]);
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com';
const TURNSTILE_SITEVERIFY_ORIGIN = 'https://challenges.cloudflare.com';

interface TurnstileValidationInput {
	token: string;
	ip: string;
	expectedHostname: string;
	publicKey: string;
}

@Injectable()
export class WidgetsCloudflareTurnstileService {
	private readonly logger = new Logger(
		WidgetsCloudflareTurnstileService.name
	);
	private readonly accountId: string;
	private readonly apiToken: string;
	private readonly siteKeyValue: string;
	private readonly secretKey: string;
	private readonly timeoutMs: number;
	private readonly apiOrigin: string;
	private readonly siteverifyOrigin: string;
	private syncQueue: Promise<void> = Promise.resolve();

	constructor(
		config: ConfigService,
		private readonly repository: WidgetsDomainRepository
	) {
		this.accountId = this.required(
			config,
			'CLOUDFLARE_ACCOUNT_ID',
			/^[A-Za-z0-9_-]{8,64}$/
		);
		this.apiToken = this.required(config, 'CLOUDFLARE_API_TOKEN');
		this.siteKeyValue = this.required(
			config,
			'CLOUDFLARE_TURNSTILE_SITE_KEY',
			/^[A-Za-z0-9_-]{3,64}$/
		);
		this.secretKey = this.required(
			config,
			'CLOUDFLARE_TURNSTILE_SECRET_KEY'
		);
		this.timeoutMs = this.timeout(config);
		this.apiOrigin = this.origin(
			config,
			'CLOUDFLARE_AI_API_ORIGIN',
			CLOUDFLARE_API_ORIGIN
		);
		this.siteverifyOrigin = this.origin(
			config,
			'CLOUDFLARE_TURNSTILE_SITEVERIFY_ORIGIN',
			TURNSTILE_SITEVERIFY_ORIGIN
		);
	}

	siteKey(): string {
		return this.siteKeyValue;
	}

	action(): string {
		return TURNSTILE_ACTION;
	}

	async validate(input: TurnstileValidationInput): Promise<void> {
		let response: Response;
		try {
			response = await fetch(
				`${this.siteverifyOrigin}/turnstile/v0/siteverify`,
				{
					method: 'POST',
					headers: {
						accept: 'application/json',
						'cache-control': 'no-store',
						'content-type': 'application/json'
					},
					body: JSON.stringify({
						secret: this.secretKey,
						response: input.token,
						remoteip: input.ip,
						idempotency_key: randomUUID()
					}),
					signal: AbortSignal.timeout(this.timeoutMs),
					cache: 'no-store'
				}
			);
		} catch (error) {
			this.logger.warn(
				`Turnstile Siteverify failed code=${this.transportCode(error)}`
			);
			throw new ServiceUnavailableException(
				'Проверка посетителя временно недоступна'
			);
		}

		const body = await this.readJson(
			response,
			'siteverify',
			'Проверка посетителя временно недоступна'
		);
		if (!response.ok) {
			this.logger.warn(
				`Turnstile Siteverify failed status=${response.status}`
			);
			throw new ServiceUnavailableException(
				'Проверка посетителя временно недоступна'
			);
		}
		const value = this.record(body);
		const challengeAt = Date.parse(String(value?.challenge_ts || ''));
		let hostname = '';
		try {
			hostname = normalizeExactInstallDomain(value?.hostname);
		} catch {
			hostname = '';
		}
		const now = Date.now();
		if (
			value?.success !== true ||
			value.action !== TURNSTILE_ACTION ||
			value.cdata !== input.publicKey ||
			hostname !== input.expectedHostname ||
			!Number.isFinite(challengeAt) ||
			challengeAt > now + TURNSTILE_CLOCK_SKEW_MS ||
			now - challengeAt > TURNSTILE_TOKEN_MAX_AGE_MS
		) {
			throw new ForbiddenException('Проверка посетителя не пройдена');
		}
	}

	async withPublishedHostname<T>(
		widgetId: string,
		hostname: string,
		operation: () => Promise<T>
	): Promise<T> {
		let release: (() => void) | undefined;
		const previous = this.syncQueue;
		this.syncQueue = new Promise<void>(resolve => {
			release = resolve;
		});
		await previous;
		try {
			const transitionDomains = await this.transitionDomains(
				widgetId,
				hostname
			);
			await this.updateHostnames(transitionDomains);
			let result: T;
			try {
				result = await operation();
			} catch (error) {
				await this.reconcileCommittedHostnames('publish-rollback');
				throw error;
			}
			await this.reconcileCommittedHostnames('publish-commit');
			return result;
		} finally {
			release?.();
		}
	}

	private async transitionDomains(
		widgetId: string,
		hostname: string
	): Promise<string[]> {
		const normalized = normalizeExactInstallDomain(hostname);
		const published = await this.repository
			.client()
			.aiConsultant.findMany({
				where: { publishedAt: { not: null } },
				select: { id: true, installDomain: true }
			});
		const targetDomains = [
			...new Set([
				TURNSTILE_PLATFORM_HOSTNAME,
				...(normalized ? [normalized] : []),
				...published
					.filter(item => item.id !== widgetId)
					.map(item => item.installDomain)
					.filter(Boolean)
			])
		].sort();
		if (targetDomains.length > TURNSTILE_HOSTNAME_LIMIT - 1) {
			throw new BadRequestException(
				'Лимит доменов AI-консультанта исчерпан: доступно не более 8 клиентских доменов'
			);
		}
		const transitionDomains = [
			...new Set([
				...targetDomains,
				...published.map(item => item.installDomain).filter(Boolean)
			])
		].sort();
		if (transitionDomains.length > TURNSTILE_HOSTNAME_LIMIT) {
			throw new ServiceUnavailableException(
				'Не удалось безопасно подготовить домен AI-консультанта'
			);
		}
		return transitionDomains;
	}

	private async reconcileCommittedHostnames(
		reason: string
	): Promise<void> {
		try {
			const published = await this.repository
				.client()
				.aiConsultant.findMany({
					where: { publishedAt: { not: null } },
					select: { installDomain: true }
				});
			const domains = [
				...new Set([
					TURNSTILE_PLATFORM_HOSTNAME,
					...published.map(item => item.installDomain).filter(Boolean)
				])
			].sort();
			if (domains.length > TURNSTILE_HOSTNAME_LIMIT - 1) {
				throw new Error('TURNSTILE_COMMITTED_DOMAIN_LIMIT');
			}
			await this.updateHostnames(domains);
		} catch {
			this.logger.error(
				`Turnstile committed hostname reconciliation failed phase=${reason}`
			);
		}
	}

	private async updateHostnames(domains: string[]): Promise<void> {
		const endpoint = `${this.apiOrigin}/client/v4/accounts/${encodeURIComponent(this.accountId)}/challenges/widgets/${encodeURIComponent(this.siteKeyValue)}`;
		let currentResponse: Response;
		try {
			currentResponse = await fetch(endpoint, {
				method: 'GET',
				headers: {
					accept: 'application/json',
					authorization: `Bearer ${this.apiToken}`,
					'cache-control': 'no-store'
				},
				signal: AbortSignal.timeout(this.timeoutMs),
				cache: 'no-store'
			});
		} catch (error) {
			this.logger.warn(
				`Turnstile hostname read failed code=${this.transportCode(error)}`
			);
			throw new ServiceUnavailableException(
				'Не удалось подготовить домен AI-консультанта'
			);
		}
		const currentBody = await this.readJson(
			currentResponse,
			'hostname-read',
			'Не удалось подготовить домен AI-консультанта'
		);
		const currentRoot = this.record(currentBody);
		const current = this.record(currentRoot?.result);
		const name =
			typeof current?.name === 'string' ? current.name.trim() : '';
		const mode = typeof current?.mode === 'string' ? current.mode : '';
		const clearanceLevel =
			typeof current?.clearance_level === 'string'
				? current.clearance_level
				: '';
		if (
			!currentResponse.ok ||
			currentRoot?.success !== true ||
			!name ||
			!TURNSTILE_MODES.has(mode) ||
			!TURNSTILE_CLEARANCE_LEVELS.has(clearanceLevel)
		) {
			this.logger.warn(
				`Turnstile hostname read failed status=${currentResponse.status}`
			);
			throw new ServiceUnavailableException(
				'Не удалось подготовить домен AI-консультанта'
			);
		}

		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: 'PUT',
				headers: {
					accept: 'application/json',
					authorization: `Bearer ${this.apiToken}`,
					'cache-control': 'no-store',
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					domains,
					mode,
					name,
					clearance_level: clearanceLevel
				}),
				signal: AbortSignal.timeout(this.timeoutMs),
				cache: 'no-store'
			});
		} catch (error) {
			this.logger.warn(
				`Turnstile hostname sync failed code=${this.transportCode(error)}`
			);
			throw new ServiceUnavailableException(
				'Не удалось подготовить домен AI-консультанта'
			);
		}
		const body = await this.readJson(
			response,
			'hostname-sync',
			'Не удалось подготовить домен AI-консультанта'
		);
		const root = this.record(body);
		const result = this.record(root?.result);
		const returnedDomains = Array.isArray(result?.domains)
			? result.domains.filter(
					(value): value is string => typeof value === 'string'
				)
			: [];
		if (
			!response.ok ||
			root?.success !== true ||
			returnedDomains.length !== domains.length ||
			!domains.every(domain => returnedDomains.includes(domain))
		) {
			this.logger.warn(
				`Turnstile hostname sync failed status=${response.status}`
			);
			throw new ServiceUnavailableException(
				'Не удалось подготовить домен AI-консультанта'
			);
		}
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
		const raw = config
			.get<string>('CLOUDFLARE_TURNSTILE_TIMEOUT_MS')
			?.trim();
		if (!raw) return DEFAULT_TIMEOUT_MS;
		const value = Number(raw);
		if (!Number.isInteger(value) || value < 1_000 || value > 30_000) {
			throw new Error(
				'CLOUDFLARE_TURNSTILE_TIMEOUT_MS must be between 1000 and 30000'
			);
		}
		return value;
	}

	private origin(
		config: ConfigService,
		key: string,
		fallback: string
	): string {
		const override = config.get<string>(key)?.trim();
		if (!override) return fallback;
		if (config.get<string>('NODE_ENV') !== 'test') {
			throw new Error(`${key} is allowed only in tests`);
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
			throw new Error(`${key} must be a loopback HTTP origin in tests`);
		}
		return parsed.origin;
	}

	private async readJson(
		response: Response,
		operation: string,
		publicMessage: string
	): Promise<unknown> {
		try {
			const declaredLength = Number(
				response.headers.get('content-length') || '0'
			);
			if (
				Number.isFinite(declaredLength) &&
				declaredLength > MAX_RESPONSE_BYTES
			) {
				await response.body?.cancel();
				throw new Error('RESPONSE_TOO_LARGE');
			}
			if (!response.body) throw new Error('EMPTY_RESPONSE');
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
						throw new Error('RESPONSE_TOO_LARGE');
					}
					chunks.push(Buffer.from(next.value));
				}
			} finally {
				reader.releaseLock();
			}
			return JSON.parse(
				Buffer.concat(chunks, total).toString('utf8')
			) as unknown;
		} catch {
			this.logger.warn(`Turnstile ${operation} response was invalid`);
			throw new ServiceUnavailableException(publicMessage);
		}
	}

	private record(value: unknown): Record<string, unknown> | null {
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	}

	private transportCode(error: unknown): string {
		return error instanceof Error && error.name === 'TimeoutError'
			? 'TIMEOUT'
			: 'TRANSPORT_ERROR';
	}
}
