import {
	OutboundHttpProvider,
	SafeOutboundHttpError
} from '@/safe-outbound-http/safe-outbound-http.error';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { lookup } from 'dns/promises';
import * as ipaddr from 'ipaddr.js';
import { isIP } from 'net';
import { Agent, request } from 'undici';

export type OutboundHttpPolicy = OutboundHttpProvider;

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
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
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

		try {
			const headers = this.normalizeHeaders(options.headers);
			const body = Buffer.from(JSON.stringify(payload), 'utf8');
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
			const safeError = this.toSafeOutboundHttpError(
				options.policy,
				error
			);
			this.logger.warn(
				`Исходящий запрос интеграции ${options.policy} завершился ошибкой code=${safeError.providerCode || 'UNCLASSIFIED'} status=${safeError.httpStatus ?? 'none'}: ${safeError.safeReason}`
			);
			throw safeError;
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
			const responseBody = await this.readResponseBody(response.body);

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

			const responseError = this.getResponseError(
				policy,
				response.statusCode,
				response.headers['retry-after'],
				responseBody
			);
			if (responseError) {
				throw responseError;
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
		} catch (error) {
			const errorCode = this.getErrorCode(error);
			if (errorCode === 'EAI_AGAIN' || errorCode === 'EDNS') {
				throw new SafeOutboundHttpError({
					provider: policy,
					httpStatus: null,
					providerCode: 'DNS_TEMPORARY',
					retryAfterMs: null,
					safeReason: 'Outbound integration DNS lookup failed temporarily'
				});
			}
			if (errorCode === 'ENOTFOUND' || errorCode === 'ENODATA') {
				throw new SafeOutboundHttpError({
					provider: policy,
					httpStatus: null,
					providerCode: 'DNS_NOT_FOUND',
					retryAfterMs: null,
					safeReason: 'Outbound integration DNS destination was not found'
				});
			}
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

	private async readResponseBody(body: {
		text: () => Promise<string>;
	}): Promise<string> {
		const value = await body.text();
		const buffer = Buffer.from(value, 'utf8');
		return buffer.length <= MAX_RESPONSE_SIZE_BYTES
			? value
			: buffer.subarray(0, MAX_RESPONSE_SIZE_BYTES).toString('utf8');
	}

	private getResponseError(
		provider: OutboundHttpPolicy,
		httpStatus: number,
		retryAfterHeader: unknown,
		responseBody: string
	): SafeOutboundHttpError | null {
		const retryAfterMs = this.parseRetryAfter(retryAfterHeader);
		const parsedBody = this.parseJsonRecord(responseBody);
		const providerCode =
			provider === 'bitrix24'
				? this.getBitrix24ErrorCode(parsedBody)
				: provider === 'amo-crm'
					? this.getAmoCrmErrorCode(parsedBody, httpStatus)
					: null;
		const failedHttpStatus = httpStatus < 200 || httpStatus >= 300;

		if (!providerCode && !failedHttpStatus) return null;

		const safeCode =
			providerCode || this.normalizeProviderCode(`HTTP_${httpStatus}`);
		const providerLabel =
			provider === 'amo-crm'
				? 'amoCRM'
				: provider === 'bitrix24'
					? 'Bitrix24'
					: 'Webhook';
		return new SafeOutboundHttpError({
			provider,
			httpStatus,
			providerCode: safeCode,
			retryAfterMs,
			safeReason: safeCode
				? `${providerLabel} request failed (${safeCode})`
				: `${providerLabel} request failed`
		});
	}

	private getBitrix24ErrorCode(
		body: Record<string, unknown> | null
	): string | null {
		return this.normalizeProviderCode(body?.error);
	}

	private getAmoCrmErrorCode(
		body: Record<string, unknown> | null,
		httpStatus: number
	): string | null {
		if (!body) return null;

		const directCode =
			this.normalizeProviderCode(body.code) ||
			this.normalizeProviderCode(body.error);
		if (directCode) return directCode;

		const validationErrors = body['validation-errors'];
		if (Array.isArray(validationErrors)) {
			for (const item of validationErrors) {
				if (!item || typeof item !== 'object' || Array.isArray(item)) {
					continue;
				}
				const errors = (item as Record<string, unknown>).errors;
				if (!Array.isArray(errors)) continue;
				for (const error of errors) {
					if (
						!error ||
						typeof error !== 'object' ||
						Array.isArray(error)
					) {
						continue;
					}
					const code = this.normalizeProviderCode(
						(error as Record<string, unknown>).code
					);
					if (code) return code;
				}
			}
		}

		const bodyStatus =
			typeof body.status === 'number' ? body.status : null;
		if (
			Array.isArray(validationErrors) ||
			(bodyStatus !== null && bodyStatus >= 400)
		) {
			return this.normalizeProviderCode(
				`HTTP_${bodyStatus || httpStatus}`
			);
		}

		return null;
	}

	private parseJsonRecord(value: string): Record<string, unknown> | null {
		if (!value.trim()) return null;
		try {
			const parsed = JSON.parse(value) as unknown;
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	}

	private normalizeProviderCode(value: unknown): string | null {
		if (typeof value !== 'string' && typeof value !== 'number') {
			return null;
		}
		const normalized = String(value).trim();
		if (
			!normalized ||
			normalized.length > 100 ||
			!/^[a-z\d_.:-]+$/i.test(normalized)
		) {
			return null;
		}
		return normalized;
	}

	private parseRetryAfter(value: unknown): number | null {
		const candidate = Array.isArray(value) ? value[0] : value;
		if (typeof candidate !== 'string' && typeof candidate !== 'number') {
			return null;
		}
		const normalized = String(candidate).trim();
		if (!normalized) return null;

		if (/^\d+(?:\.\d+)?$/.test(normalized)) {
			const delay = Number(normalized) * 1000;
			return Number.isFinite(delay)
				? Math.min(Math.max(Math.round(delay), 0), MAX_RETRY_AFTER_MS)
				: null;
		}

		const timestamp = Date.parse(normalized);
		if (!Number.isFinite(timestamp)) return null;
		return Math.min(
			Math.max(timestamp - Date.now(), 0),
			MAX_RETRY_AFTER_MS
		);
	}

	private toSafeOutboundHttpError(
		provider: OutboundHttpPolicy,
		error: unknown
	): SafeOutboundHttpError {
		if (error instanceof SafeOutboundHttpError) return error;

		const errorName = error instanceof Error ? error.name : '';
		const errorCode = this.getErrorCode(error);
		if (
			errorName === 'TimeoutError' ||
			errorName === 'AbortError' ||
			[
				'UND_ERR_CONNECT_TIMEOUT',
				'UND_ERR_HEADERS_TIMEOUT',
				'UND_ERR_BODY_TIMEOUT',
				'ETIMEDOUT'
			].includes(errorCode || '')
		) {
			return new SafeOutboundHttpError({
				provider,
				httpStatus: null,
				providerCode: 'TRANSPORT_TIMEOUT',
				retryAfterMs: null,
				safeReason: 'Outbound integration request timed out'
			});
		}

		if (['EAI_AGAIN', 'ENOTFOUND', 'EDNS'].includes(errorCode || '')) {
			return new SafeOutboundHttpError({
				provider,
				httpStatus: null,
				providerCode: 'DNS_ERROR',
				retryAfterMs: null,
				safeReason: 'Outbound integration DNS lookup failed'
			});
		}

		if (
			[
				'ECONNREFUSED',
				'ECONNRESET',
				'ENETUNREACH',
				'EHOSTUNREACH',
				'UND_ERR_SOCKET'
			].includes(errorCode || '')
		) {
			return new SafeOutboundHttpError({
				provider,
				httpStatus: null,
				providerCode: 'CONNECTION_ERROR',
				retryAfterMs: null,
				safeReason: 'Outbound integration connection failed'
			});
		}

		if (
			[
				'CERT_HAS_EXPIRED',
				'DEPTH_ZERO_SELF_SIGNED_CERT',
				'ERR_TLS_CERT_ALTNAME_INVALID',
				'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
			].includes(errorCode || '')
		) {
			return new SafeOutboundHttpError({
				provider,
				httpStatus: null,
				providerCode: 'TLS_CONFIGURATION',
				retryAfterMs: null,
				safeReason: 'Outbound integration TLS verification failed'
			});
		}

		if (error instanceof BadRequestException) {
			return new SafeOutboundHttpError({
				provider,
				httpStatus: null,
				providerCode: error.message.includes('DNS-адрес')
					? 'DNS_ERROR'
					: 'INVALID_DESTINATION',
				retryAfterMs: null,
				safeReason: error.message.includes('DNS-адрес')
					? 'Outbound integration DNS lookup failed'
					: 'Outbound integration destination is invalid'
			});
		}

		return new SafeOutboundHttpError({
			provider,
			httpStatus: null,
			providerCode: 'TRANSPORT_ERROR',
			retryAfterMs: null,
			safeReason: 'Outbound integration request failed'
		});
	}

	private getErrorCode(error: unknown): string | null {
		if (!error || typeof error !== 'object') return null;
		const code = (error as { code?: unknown }).code;
		return typeof code === 'string' ? code.toUpperCase() : null;
	}
}
