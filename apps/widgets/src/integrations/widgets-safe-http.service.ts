import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as dnsPromises from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import type { WidgetsProviderKind } from '../messaging/widgets-messaging.constants';

export type WidgetsOutboundHttpPolicy = WidgetsProviderKind;

export interface WidgetsSafeHttpErrorDetails {
	provider: WidgetsOutboundHttpPolicy;
	httpStatus: number | null;
	providerCode: string | null;
	retryAfterMs: number | null;
	safeReason: string;
}

export class WidgetsSafeHttpError extends Error {
	readonly provider: WidgetsOutboundHttpPolicy;
	readonly httpStatus: number | null;
	readonly providerCode: string | null;
	readonly retryAfterMs: number | null;
	readonly safeReason: string;

	constructor(details: WidgetsSafeHttpErrorDetails) {
		super(details.safeReason);
		this.name = 'WidgetsSafeHttpError';
		this.provider = details.provider;
		this.httpStatus = details.httpStatus;
		this.providerCode = details.providerCode;
		this.retryAfterMs = details.retryAfterMs;
		this.safeReason = details.safeReason;
	}
}

interface IntegrationConfig {
	webhookUrl?: unknown;
	bitrix24WebhookUrl?: unknown;
	amoCrmDomain?: unknown;
}

interface PostJsonOptions {
	policy: WidgetsOutboundHttpPolicy;
	headers?: Record<string, string>;
}

interface ResolvedTarget {
	url: URL;
	address: string;
	family: 4 | 6;
}

interface HttpResponse {
	status: number;
	headers: IncomingHttpHeaders;
	body: string;
}

class WidgetsTransportError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'WidgetsTransportError';
	}
}

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_REDIRECTS = 2;
const PUBLIC_HTTP_PORTS = new Set([80, 443, 8080, 8443]);
const AMO_CRM_HOST_SUFFIXES = ['.amocrm.ru', '.amocrm.com', '.kommo.com'];

const NON_PUBLIC_IPV4_ADDRESSES = new BlockList();
for (const [address, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4]
] as const) {
	NON_PUBLIC_IPV4_ADDRESSES.addSubnet(address, prefix, 'ipv4');
}
const NON_PUBLIC_IPV6_ADDRESSES = new BlockList();
for (const [address, prefix] of [
	['::', 128],
	['::1', 128],
	['::ffff:0:0', 96],
	['64:ff9b:1::', 48],
	['100::', 64],
	['2001::', 23],
	['2001:db8::', 32],
	['2002::', 16],
	['3fff::', 20],
	['3ffe::', 16],
	['5f00::', 16],
	['fc00::', 7],
	['fe80::', 10],
	['fec0::', 10],
	['ff00::', 8]
] as const) {
	NON_PUBLIC_IPV6_ADDRESSES.addSubnet(address, prefix, 'ipv6');
}

@Injectable()
export class WidgetsSafeHttpService {
	private readonly logger = new Logger(WidgetsSafeHttpService.name);

	async validateIntegrationConfig(value: unknown): Promise<void> {
		const integrations = this.integrationConfig(value);
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
			await this.resolveTarget(
				webhookUrl,
				'webhook',
				Date.now() + REQUEST_TIMEOUT_MS
			);
		}
		if (bitrix24WebhookUrl) {
			await this.resolveTarget(
				`${bitrix24WebhookUrl.replace(/\/$/, '')}/crm.lead.add.json`,
				'bitrix24',
				Date.now() + REQUEST_TIMEOUT_MS
			);
		}
		if (amoCrmDomain) {
			await this.resolveTarget(
				this.amoApiUrl(amoCrmDomain),
				'amo-crm',
				Date.now() + REQUEST_TIMEOUT_MS
			);
		}
	}

	amoApiUrl(value: string): string {
		const normalized = value.trim();
		if (!normalized) throw new BadRequestException('Укажите домен amoCRM');
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
		return `https://${parsed.hostname.toLowerCase()}/api/v4/leads/complex`;
	}

	async postJson(
		rawUrl: string,
		payload: unknown,
		options: PostJsonOptions
	): Promise<void> {
		const deadline = Date.now() + REQUEST_TIMEOUT_MS;
		try {
			const body = Buffer.from(JSON.stringify(payload), 'utf8');
			const headers = this.normalizeHeaders(options.headers);
			await this.requestWithRedirects(
				rawUrl,
				'POST',
				body,
				headers,
				options.policy,
				0,
				deadline
			);
		} catch (error) {
			const safeError = this.toSafeError(options.policy, error);
			this.logger.warn(
				`Widgets provider request failed provider=${options.policy} code=${safeError.providerCode || 'UNCLASSIFIED'} status=${safeError.httpStatus ?? 'none'}: ${safeError.safeReason}`
			);
			throw safeError;
		}
	}

	isPublicIpAddress(value: string): boolean {
		const family = isIP(value);
		if (family === 4) {
			return !NON_PUBLIC_IPV4_ADDRESSES.check(value, 'ipv4');
		}
		if (family !== 6) return false;
		if (NON_PUBLIC_IPV6_ADDRESSES.check(value, 'ipv6')) return false;
		const firstGroup = value.split(':', 1)[0];
		const first = Number.parseInt(firstGroup, 16);
		return Number.isInteger(first) && first >= 0x2000 && first <= 0x3fff;
	}

	private async requestWithRedirects(
		rawUrl: string,
		method: 'GET' | 'POST',
		body: Buffer | undefined,
		headers: Record<string, string>,
		policy: WidgetsOutboundHttpPolicy,
		redirectCount: number,
		deadline: number
	): Promise<void> {
		const target = await this.resolveTarget(rawUrl, policy, deadline);
		const response = await this.requestOnce(
			target,
			method,
			body,
			headers,
			deadline
		);
		if (response.status >= 300 && response.status < 400) {
			if (redirectCount >= MAX_REDIRECTS) {
				throw new BadRequestException(
					'Слишком много перенаправлений интеграции'
				);
			}
			const location = this.header(response.headers.location);
			if (!location) {
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
			const switchToGet =
				response.status === 303 ||
				((response.status === 301 || response.status === 302) &&
					method === 'POST');
			const nextHeaders = { ...headers };
			if (switchToGet) {
				delete nextHeaders['content-type'];
				delete nextHeaders['content-length'];
			}
			if (redirectUrl.origin !== target.url.origin) {
				delete nextHeaders.authorization;
			}
			await this.requestWithRedirects(
				redirectUrl.toString(),
				switchToGet ? 'GET' : method,
				switchToGet ? undefined : body,
				nextHeaders,
				policy,
				redirectCount + 1,
				deadline
			);
			return;
		}
		const responseError = this.responseError(
			policy,
			response.status,
			response.headers['retry-after'],
			response.body
		);
		if (responseError) throw responseError;
	}

	private requestOnce(
		target: ResolvedTarget,
		method: 'GET' | 'POST',
		body: Buffer | undefined,
		headers: Record<string, string>,
		deadline: number
	): Promise<HttpResponse> {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			return Promise.reject(
				new WidgetsTransportError('TRANSPORT_TIMEOUT')
			);
		}
		return new Promise<HttpResponse>((resolve, reject) => {
			let settled = false;
			const finish = (error?: unknown, value?: HttpResponse) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) reject(error);
				else resolve(value as HttpResponse);
			};
			const request = (
				target.url.protocol === 'https:' ? httpsRequest : httpRequest
			)(
				target.url,
				{
					method,
					agent: false,
					headers: {
						accept: 'application/json',
						...headers,
						...(body ? { 'content-length': String(body.length) } : {})
					},
					lookup: (_hostname, _options, callback) =>
						callback(null, target.address, target.family)
				},
				response => {
					const chunks: Buffer[] = [];
					let retainedBytes = 0;
					response.on('data', (chunk: Buffer | string) => {
						if (retainedBytes >= MAX_RESPONSE_BYTES) return;
						const buffer = Buffer.isBuffer(chunk)
							? chunk
							: Buffer.from(chunk);
						const retained = buffer.subarray(
							0,
							MAX_RESPONSE_BYTES - retainedBytes
						);
						chunks.push(retained);
						retainedBytes += retained.length;
					});
					response.once('error', finish);
					response.once('end', () =>
						finish(undefined, {
							status: response.statusCode || 0,
							headers: response.headers,
							body: Buffer.concat(chunks).toString('utf8')
						})
					);
				}
			);
			const timer = setTimeout(() => {
				request.destroy(new WidgetsTransportError('TRANSPORT_TIMEOUT'));
			}, remaining);
			timer.unref();
			request.once('error', finish);
			request.end(body);
		});
	}

	private async resolveTarget(
		rawUrl: string,
		policy: WidgetsOutboundHttpPolicy,
		deadline: number
	): Promise<ResolvedTarget> {
		let url: URL;
		try {
			url = new URL(rawUrl.trim());
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
				: await this.withDeadline(
						this.lookupAddresses(hostname),
						deadline
					);
		} catch (error) {
			if (error instanceof WidgetsTransportError) throw error;
			const code = this.errorCode(error);
			if (code === 'EAI_AGAIN' || code === 'EDNS') {
				throw new WidgetsSafeHttpError({
					provider: policy,
					httpStatus: null,
					providerCode: 'DNS_TEMPORARY',
					retryAfterMs: null,
					safeReason: 'Outbound integration DNS lookup failed temporarily'
				});
			}
			if (code === 'ENOTFOUND' || code === 'ENODATA') {
				throw new WidgetsSafeHttpError({
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
			addresses.some(address => !this.isPublicIpAddress(address.address))
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

	private assertUrlPolicy(
		url: URL,
		policy: WidgetsOutboundHttpPolicy
	): void {
		if (!['http:', 'https:'].includes(url.protocol)) {
			throw new BadRequestException(
				'Интеграция поддерживает только HTTP и HTTPS'
			);
		}
		if (url.username || url.password || url.hash) {
			throw new BadRequestException(
				'URL интеграции не может содержать credentials или fragment'
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
			throw new BadRequestException('Порт URL интеграции не разрешён');
		}
	}

	private lookupAddresses(
		hostname: string
	): Promise<Array<{ address: string; family: number }>> {
		return dnsPromises.lookup(hostname, { all: true, verbatim: true });
	}

	private responseError(
		provider: WidgetsOutboundHttpPolicy,
		httpStatus: number,
		retryAfterHeader: unknown,
		body: string
	): WidgetsSafeHttpError | null {
		const parsed = this.jsonRecord(body);
		const providerCode =
			provider === 'bitrix24'
				? this.normalizeProviderCode(parsed?.error)
				: provider === 'amo-crm'
					? this.amoErrorCode(parsed, httpStatus)
					: null;
		if (!providerCode && httpStatus >= 200 && httpStatus < 300)
			return null;
		const code = providerCode || `HTTP_${httpStatus}`;
		return new WidgetsSafeHttpError({
			provider,
			httpStatus,
			providerCode: code,
			retryAfterMs: this.retryAfter(retryAfterHeader),
			safeReason: `${this.providerLabel(provider)} request failed (${code})`
		});
	}

	private amoErrorCode(
		body: Record<string, unknown> | null,
		httpStatus: number
	): string | null {
		if (!body) return null;
		const direct =
			this.normalizeProviderCode(body.code) ||
			this.normalizeProviderCode(body.error);
		if (direct) return direct;
		const validationErrors = body['validation-errors'];
		if (Array.isArray(validationErrors)) {
			for (const item of validationErrors) {
				if (!item || typeof item !== 'object' || Array.isArray(item))
					continue;
				const errors = (item as Record<string, unknown>).errors;
				if (!Array.isArray(errors)) continue;
				for (const error of errors) {
					if (!error || typeof error !== 'object' || Array.isArray(error))
						continue;
					const code = this.normalizeProviderCode(
						(error as Record<string, unknown>).code
					);
					if (code) return code;
				}
			}
		}
		return httpStatus >= 400 ? `HTTP_${httpStatus}` : null;
	}

	private retryAfter(value: unknown): number | null {
		const raw = this.header(value);
		if (!raw) return null;
		if (/^\d+$/.test(raw)) {
			return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS);
		}
		const timestamp = Date.parse(raw);
		if (!Number.isFinite(timestamp)) return null;
		return Math.min(
			Math.max(timestamp - Date.now(), 0),
			MAX_RETRY_AFTER_MS
		);
	}

	private toSafeError(
		provider: WidgetsOutboundHttpPolicy,
		error: unknown
	): WidgetsSafeHttpError {
		if (error instanceof WidgetsSafeHttpError) return error;
		const code =
			error instanceof WidgetsTransportError
				? error.code
				: this.errorCode(error);
		if (code === 'TRANSPORT_TIMEOUT' || code === 'ETIMEDOUT') {
			return this.safeError(
				provider,
				'TRANSPORT_TIMEOUT',
				'Outbound integration request timed out'
			);
		}
		if (code === 'EAI_AGAIN' || code === 'EDNS') {
			return this.safeError(
				provider,
				'DNS_TEMPORARY',
				'Outbound integration DNS lookup failed temporarily'
			);
		}
		if (code === 'ENOTFOUND' || code === 'ENODATA') {
			return this.safeError(
				provider,
				'DNS_NOT_FOUND',
				'Outbound integration DNS destination was not found'
			);
		}
		if (
			[
				'ECONNREFUSED',
				'ECONNRESET',
				'ENETUNREACH',
				'EHOSTUNREACH'
			].includes(code || '')
		) {
			return this.safeError(
				provider,
				'CONNECTION_ERROR',
				'Outbound integration connection failed'
			);
		}
		if (
			[
				'CERT_HAS_EXPIRED',
				'DEPTH_ZERO_SELF_SIGNED_CERT',
				'ERR_TLS_CERT_ALTNAME_INVALID',
				'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
			].includes(code || '')
		) {
			return this.safeError(
				provider,
				'TLS_CONFIGURATION',
				'Outbound integration TLS verification failed'
			);
		}
		if (error instanceof BadRequestException) {
			return this.safeError(
				provider,
				error.message.includes('DNS-адрес')
					? 'DNS_ERROR'
					: 'INVALID_DESTINATION',
				error.message.includes('DNS-адрес')
					? 'Outbound integration DNS lookup failed'
					: 'Outbound integration destination is invalid'
			);
		}
		return this.safeError(
			provider,
			'TRANSPORT_ERROR',
			'Outbound integration request failed'
		);
	}

	private safeError(
		provider: WidgetsOutboundHttpPolicy,
		providerCode: string,
		safeReason: string
	): WidgetsSafeHttpError {
		return new WidgetsSafeHttpError({
			provider,
			httpStatus: null,
			providerCode,
			retryAfterMs: null,
			safeReason
		});
	}

	private withDeadline<T>(
		promise: Promise<T>,
		deadline: number
	): Promise<T> {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			return Promise.reject(
				new WidgetsTransportError('TRANSPORT_TIMEOUT')
			);
		}
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new WidgetsTransportError('TRANSPORT_TIMEOUT'));
			}, remaining);
			timer.unref();
			promise.then(
				value => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(value);
				},
				error => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(error);
				}
			);
		});
	}

	private integrationConfig(value: unknown): IntegrationConfig {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			return {};
		return value as IntegrationConfig;
	}

	private optionalString(value: unknown, label: string): string | null {
		if (value === undefined || value === null || value === '') return null;
		if (typeof value !== 'string') {
			throw new BadRequestException(`${label} должен быть строкой`);
		}
		return value.trim() || null;
	}

	private normalizeHeaders(
		headers: Record<string, string> | undefined
	): Record<string, string> {
		const normalized: Record<string, string> = {
			'content-type': 'application/json'
		};
		for (const [key, value] of Object.entries(headers || {})) {
			const name = key.trim().toLowerCase();
			if (!name || /[\r\n]/.test(name) || /[\r\n]/.test(value)) {
				throw new BadRequestException(
					'Некорректный HTTP header интеграции'
				);
			}
			normalized[name] = value;
		}
		return normalized;
	}

	private isAmoCrmHost(value: string): boolean {
		const hostname = value.toLowerCase().replace(/\.$/, '');
		return AMO_CRM_HOST_SUFFIXES.some(
			suffix =>
				hostname.endsWith(suffix) && hostname.length > suffix.length
		);
	}

	private jsonRecord(value: string): Record<string, unknown> | null {
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
		if (typeof value !== 'string' && typeof value !== 'number')
			return null;
		const normalized = String(value).trim();
		return /^[A-Za-z0-9_.:-]{1,100}$/.test(normalized) ? normalized : null;
	}

	private providerLabel(provider: WidgetsOutboundHttpPolicy): string {
		if (provider === 'amo-crm') return 'amoCRM';
		if (provider === 'bitrix24') return 'Bitrix24';
		return 'Webhook';
	}

	private header(value: unknown): string | null {
		if (typeof value === 'string') return value.trim() || null;
		if (Array.isArray(value) && typeof value[0] === 'string') {
			return value[0].trim() || null;
		}
		return null;
	}

	private errorCode(error: unknown): string | null {
		if (!error || typeof error !== 'object') return null;
		const code = (error as { code?: unknown }).code;
		return typeof code === 'string' ? code.toUpperCase() : null;
	}
}
