import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { lookup } from 'dns/promises';
import * as ipaddr from 'ipaddr.js';
import { isIP } from 'net';
import { Agent, request } from 'undici';

export type OutboundHttpPolicy = 'webhook' | 'bitrix24' | 'amo-crm';

interface PostJsonOptions {
	policy: OutboundHttpPolicy;
	headers?: Record<string, string>;
}

interface ResolvedTarget {
	url: URL;
	address: string;
	family: 4 | 6;
}

interface IntegrationConfig {
	webhookUrl?: unknown;
	bitrix24WebhookUrl?: unknown;
	amoCrmDomain?: unknown;
}

const REQUEST_TIMEOUT_MS = 5000;
const MAX_RESPONSE_SIZE_BYTES = 64 * 1024;
const MAX_REDIRECTS = 2;
const PUBLIC_HTTP_PORTS = new Set([80, 443, 8080, 8443]);
const AMO_CRM_HOST_SUFFIXES = ['.amocrm.ru', '.amocrm.com', '.kommo.com'];
const NON_PUBLIC_IPV4_RANGES = [
	'0.0.0.0/8',
	'10.0.0.0/8',
	'100.64.0.0/10',
	'127.0.0.0/8',
	'169.254.0.0/16',
	'172.16.0.0/12',
	'192.0.0.0/24',
	'192.0.2.0/24',
	'192.88.99.0/24',
	'192.168.0.0/16',
	'198.18.0.0/15',
	'198.51.100.0/24',
	'203.0.113.0/24',
	'224.0.0.0/4',
	'240.0.0.0/4'
].map(value => ipaddr.IPv4.parseCIDR(value));
const NON_PUBLIC_IPV6_RANGES = [
	'::/128',
	'::1/128',
	'::ffff:0:0/96',
	'64:ff9b:1::/48',
	'100::/64',
	'2001::/23',
	'2001:db8::/32',
	'2002::/16',
	'3fff::/20',
	'3ffe::/16',
	'5f00::/16',
	'fc00::/7',
	'fe80::/10',
	'fec0::/10',
	'ff00::/8'
].map(value => ipaddr.IPv6.parseCIDR(value));
const PUBLIC_IPV6_RANGE = ipaddr.IPv6.parseCIDR('2000::/3');

@Injectable()
export class SafeOutboundHttpService {
	private readonly logger = new Logger(SafeOutboundHttpService.name);

	async validateIntegrationConfig(value: unknown): Promise<void> {
		const integrations = this.toIntegrationConfig(value);
		const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const webhookUrl = this.optionalString(
			integrations.webhookUrl,
			'Webhook URL'
		);
		const bitrix24WebhookUrl = this.optionalString(
			integrations.bitrix24WebhookUrl,
			'Bitrix24 webhook URL'
		);
		const amoCrmDomain = this.optionalString(
			integrations.amoCrmDomain,
			'Домен amoCRM'
		);

		if (webhookUrl) {
			await this.resolveTarget(webhookUrl, 'webhook', signal);
		}
		if (bitrix24WebhookUrl) {
			const base = bitrix24WebhookUrl.replace(/\/$/, '');
			await this.resolveTarget(
				`${base}/crm.lead.add.json`,
				'bitrix24',
				signal
			);
		}
		if (amoCrmDomain) {
			await this.resolveTarget(
				this.getAmoCrmApiUrl(amoCrmDomain),
				'amo-crm',
				signal
			);
		}
	}

	getAmoCrmApiUrl(value: string): string {
		const normalized = value.trim();
		if (!normalized) {
			throw new BadRequestException('Укажите домен amoCRM');
		}

		const candidate = /^[a-z][a-z\d+\-.]*:\/\//i.test(normalized)
			? normalized
			: `https://${normalized.includes('.') ? normalized : `${normalized}.amocrm.ru`}`;
		let parsed: URL;
		try {
			parsed = new URL(candidate);
		} catch {
			throw new BadRequestException('Укажите корректный домен amoCRM');
		}

		if (
			!['http:', 'https:'].includes(parsed.protocol) ||
			parsed.username ||
			parsed.password ||
			parsed.port ||
			(parsed.pathname !== '/' && parsed.pathname !== '') ||
			parsed.search ||
			parsed.hash ||
			!this.isAmoCrmHost(parsed.hostname)
		) {
			throw new BadRequestException(
				'Разрешены только официальные домены amoCRM и Kommo'
			);
		}

		return `https://${parsed.hostname}/api/v4/leads/complex`;
	}

	async postJson(
		url: string,
		payload: unknown,
		options: PostJsonOptions
	): Promise<void> {
		const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const headers = this.normalizeHeaders(options.headers);
		const body = Buffer.from(JSON.stringify(payload), 'utf8');

		try {
			await this.requestWithRedirects(
				url,
				'POST',
				body,
				headers,
				options.policy,
				0,
				signal
			);
		} catch (error) {
			this.logger.warn(
				`Исходящий запрос интеграции ${options.policy} завершился ошибкой для ${this.safeOrigin(url)}: ${this.safeErrorMessage(error)}`
			);
			throw error;
		}
	}

	isPublicIpAddress(value: string): boolean {
		try {
			if (ipaddr.IPv6.isValid(value)) {
				const address = ipaddr.IPv6.parse(value);
				if (address.isIPv4MappedAddress()) return false;
				return (
					address.range() === 'unicast' &&
					address.match(PUBLIC_IPV6_RANGE) &&
					!NON_PUBLIC_IPV6_RANGES.some(range => address.match(range))
				);
			}

			const address = ipaddr.IPv4.parse(value);
			return (
				address.range() === 'unicast' &&
				!NON_PUBLIC_IPV4_RANGES.some(range => address.match(range))
			);
		} catch {
			return false;
		}
	}

	private async requestWithRedirects(
		url: string,
		method: 'GET' | 'POST',
		body: Buffer | undefined,
		headers: Record<string, string>,
		policy: OutboundHttpPolicy,
		redirectCount: number,
		signal: AbortSignal
	): Promise<void> {
		const target = await this.resolveTarget(url, policy, signal);
		const dispatcher = this.createPinnedAgent(target);

		try {
			const response = await request(target.url, {
				dispatcher,
				method,
				body: method === 'POST' ? body : undefined,
				headers,
				headersTimeout: REQUEST_TIMEOUT_MS,
				bodyTimeout: REQUEST_TIMEOUT_MS,
				maxRedirections: 0,
				signal
			});
			await response.body.dump({ limit: MAX_RESPONSE_SIZE_BYTES });

			if (response.statusCode >= 300 && response.statusCode < 400) {
				if (redirectCount >= MAX_REDIRECTS) {
					throw new BadRequestException(
						'Слишком много перенаправлений интеграции'
					);
				}
				const location = response.headers.location;
				if (!location || Array.isArray(location)) {
					throw new BadRequestException(
						'Интеграция вернула некорректное перенаправление'
					);
				}

				const redirectUrl = new URL(location, target.url);
				if (
					policy === 'amo-crm' &&
					redirectUrl.origin !== target.url.origin
				) {
					throw new BadRequestException(
						'amoCRM не может перенаправлять запрос на другой домен'
					);
				}
				const shouldSwitchToGet =
					response.statusCode === 303 ||
					((response.statusCode === 301 || response.statusCode === 302) &&
						method === 'POST');
				const nextHeaders = shouldSwitchToGet
					? this.withoutBodyHeaders(headers)
					: headers;
				await this.requestWithRedirects(
					redirectUrl.toString(),
					shouldSwitchToGet ? 'GET' : method,
					shouldSwitchToGet ? undefined : body,
					nextHeaders,
					policy,
					redirectCount + 1,
					signal
				);
				return;
			}

			if (response.statusCode < 200 || response.statusCode >= 300) {
				throw new Error(`HTTP ${response.statusCode}`);
			}
		} finally {
			await dispatcher.close().catch(() => undefined);
		}
	}

	private async resolveTarget(
		value: string,
		policy: OutboundHttpPolicy,
		signal?: AbortSignal
	): Promise<ResolvedTarget> {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new BadRequestException('Укажите корректный URL интеграции');
		}

		this.assertUrlPolicy(url, policy);
		const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
		const family = isIP(hostname);
		let addresses: Array<{ address: string; family: number }>;
		try {
			addresses = family
				? [{ address: hostname, family }]
				: await this.withAbort(
						lookup(hostname, { all: true, verbatim: true }),
						signal
					);
		} catch {
			throw new BadRequestException(
				'Не удалось проверить DNS-адрес интеграции'
			);
		}

		if (
			!addresses.length ||
			addresses.some(item => !this.isPublicIpAddress(item.address))
		) {
			throw new BadRequestException(
				'Интеграция должна вести только на публичный сетевой адрес'
			);
		}

		return {
			url,
			address: addresses[0].address,
			family: addresses[0].family as 4 | 6
		};
	}

	private assertUrlPolicy(url: URL, policy: OutboundHttpPolicy) {
		if (!['http:', 'https:'].includes(url.protocol)) {
			throw new BadRequestException(
				'Интеграция поддерживает только HTTP и HTTPS'
			);
		}
		if (url.username || url.password) {
			throw new BadRequestException(
				'Логин и пароль нельзя передавать внутри URL интеграции'
			);
		}

		const port = url.port
			? Number(url.port)
			: url.protocol === 'https:'
				? 443
				: 80;
		if (policy === 'amo-crm') {
			if (
				url.protocol !== 'https:' ||
				port !== 443 ||
				!this.isAmoCrmHost(url.hostname)
			) {
				throw new BadRequestException(
					'Разрешены только официальные HTTPS-домены amoCRM и Kommo'
				);
			}
			return;
		}

		if (!PUBLIC_HTTP_PORTS.has(port)) {
			throw new BadRequestException(
				'Разрешены порты 80, 443, 8080 и 8443'
			);
		}
	}

	private createPinnedAgent(target: ResolvedTarget) {
		const expectedHostname = target.url.hostname
			.replace(/^\[/, '')
			.replace(/\]$/, '');
		return new Agent({
			connect: {
				lookup: (hostname, options, callback) => {
					if (hostname !== expectedHostname) {
						callback(
							new Error('Hostname changed during connection'),
							null,
							0
						);
						return;
					}
					if ((options as { all?: boolean }).all) {
						(callback as any)(null, [
							{ address: target.address, family: target.family }
						]);
						return;
					}
					callback(null, target.address, target.family);
				}
			},
			connectTimeout: REQUEST_TIMEOUT_MS,
			headersTimeout: REQUEST_TIMEOUT_MS,
			bodyTimeout: REQUEST_TIMEOUT_MS,
			maxResponseSize: MAX_RESPONSE_SIZE_BYTES,
			maxRedirections: 0,
			pipelining: 0
		});
	}

	private normalizeHeaders(value?: Record<string, string>) {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};
		for (const [name, headerValue] of Object.entries(value || {})) {
			const normalizedName = name.toLowerCase();
			if (
				!['content-type', 'authorization', 'accept'].includes(
					normalizedName
				)
			) {
				continue;
			}
			if (/[\r\n]/.test(headerValue)) {
				throw new BadRequestException('Некорректный заголовок интеграции');
			}
			headers[name] = headerValue;
		}
		return headers;
	}

	private withoutBodyHeaders(headers: Record<string, string>) {
		return Object.fromEntries(
			Object.entries(headers).filter(
				([name]) =>
					!['content-type', 'content-length'].includes(name.toLowerCase())
			)
		);
	}

	private isAmoCrmHost(hostname: string) {
		const normalized = hostname.toLowerCase().replace(/\.$/, '');
		return AMO_CRM_HOST_SUFFIXES.some(suffix =>
			normalized.endsWith(suffix)
		);
	}

	private toIntegrationConfig(value: unknown): IntegrationConfig {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return {};
		}
		return value as IntegrationConfig;
	}

	private optionalString(value: unknown, label: string) {
		if (value === undefined || value === null || value === '') return '';
		if (typeof value !== 'string') {
			throw new BadRequestException(`${label} должен быть строкой`);
		}
		return value.trim();
	}

	private async withAbort<T>(promise: Promise<T>, signal?: AbortSignal) {
		if (!signal) return promise;
		if (signal.aborted) throw signal.reason;
		return Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason), {
					once: true
				});
			})
		]);
	}

	private safeOrigin(value: string) {
		try {
			return new URL(value).origin;
		} catch {
			return 'invalid-url';
		}
	}

	private safeErrorMessage(error: unknown) {
		if (error instanceof BadRequestException) {
			return error.message;
		}
		if (error instanceof Error) {
			return error.name === 'TimeoutError' || error.name === 'AbortError'
				? 'timeout'
				: error.message.replace(/[\r\n]/g, ' ').slice(0, 160);
		}
		return 'unknown error';
	}
}
