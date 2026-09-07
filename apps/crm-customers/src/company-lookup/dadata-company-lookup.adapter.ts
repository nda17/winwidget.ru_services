import { Injectable } from '@nestjs/common';
import {
	assertCompanyLookupInn,
	companyLookupUnavailable,
	type CompanyLookupResult,
	type CompanyLookupStatus
} from './company-lookup.contract';
import { CompanyLookupProvider } from './company-lookup.provider';

const PROVIDER_URL =
	'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';
const TIMEOUT_MS = 5000;
const MAX_BYTES = 2 * 1024 * 1024;

/** Only this adapter knows DaData credentials, HTTP protocol and response shape. */
@Injectable()
export class DadataCompanyLookupAdapter extends CompanyLookupProvider {
	assertConfigured(): void {
		this.apiKey();
	}

	async lookup(inn: string): Promise<CompanyLookupResult> {
		assertCompanyLookupInn(inn);
		return this.request(inn, this.apiKey());
	}

	private apiKey(): string {
		const key = process.env.CRM_CUSTOMERS_DADATA_API_KEY;
		// Optional configuration must not prevent the application from booting.
		if (
			!key ||
			key.length > 512 ||
			/[^\x21-\x7e]/.test(key) ||
			/^(?:change|replace|example|placeholder)/i.test(key)
		)
			throw companyLookupUnavailable();

		return key;
	}

	private async request(
		inn: string,
		key: string
	): Promise<CompanyLookupResult> {
		const abort = new AbortController();
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cancel = () => {
			abort.abort();
			void reader?.cancel().catch(() => undefined);
		};
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				cancel();
				reject(companyLookupUnavailable());
			}, TIMEOUT_MS);
		});
		const read = async () => {
			const response = await fetch(PROVIDER_URL, {
				method: 'POST',
				redirect: 'error',
				signal: abort.signal,
				headers: {
					'content-type': 'application/json',
					accept: 'application/json',
					authorization: `Token ${key}`
				},
				body: JSON.stringify({
					query: inn,
					branch_type: 'MAIN',
					type: inn.length === 10 ? 'LEGAL' : 'INDIVIDUAL',
					count: 5
				})
			});
			const length = response.headers.get('content-length');
			if (
				abort.signal.aborted ||
				response.status !== 200 ||
				!/^application\/json(?:\s*;|$)/i.test(
					response.headers.get('content-type') ?? ''
				) ||
				(length !== null &&
					(!/^(?:0|[1-9][0-9]*)$/.test(length) ||
						Number(length) > MAX_BYTES)) ||
				!response.body
			) {
				void response.body?.cancel().catch(() => undefined);
				throw companyLookupUnavailable();
			}
			reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					size += chunk.value.byteLength;
					if (abort.signal.aborted || size > MAX_BYTES) {
						cancel();
						throw companyLookupUnavailable();
					}
					chunks.push(chunk.value);
				}
				if (abort.signal.aborted) throw companyLookupUnavailable();
				const body: unknown = JSON.parse(
					new TextDecoder('utf-8', { fatal: true }).decode(
						Buffer.concat(chunks)
					)
				);
				return mapDadataCompanyLookupResult(body, inn, new Date());
			} finally {
				reader.releaseLock();
			}
		};
		try {
			return await Promise.race([read(), deadline]);
		} catch {
			// Transport exceptions may contain headers/URLs/body. Never propagate or log them.
			cancel();
			throw companyLookupUnavailable();
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw companyLookupUnavailable();
	return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
	if (
		typeof value !== 'string' ||
		value.length > maximum ||
		!/\S/.test(value) ||
		/[\x00-\x1f\x7f-\x9f]/.test(value)
	)
		throw companyLookupUnavailable();
	return value;
}
function nullableDigits(value: unknown, length: number): string | null {
	if (value === null) return null;
	if (
		typeof value !== 'string' ||
		value.length !== length ||
		/[^0-9]/.test(value)
	)
		throw companyLookupUnavailable();
	return value;
}

/** The provider may add unrelated fields. Read only the allowlisted public
 * party data; never return management, contacts, raw data, IDs or credentials. */
export function mapDadataCompanyLookupResult(
	value: unknown,
	inn: string,
	queriedAt: Date
): CompanyLookupResult {
	assertCompanyLookupInn(inn);
	if (!Number.isFinite(queriedAt.getTime()))
		throw companyLookupUnavailable();
	const suggestions = object(value).suggestions;
	if (!Array.isArray(suggestions) || suggestions.length > 5)
		throw companyLookupUnavailable();
	const expectedType = inn.length === 10 ? 'LEGAL' : 'INDIVIDUAL';
	const items = suggestions.map(suggestion => {
		const data = object(object(suggestion).data);
		const individual = expectedType === 'INDIVIDUAL';
		// DaData omits branch/KPP fields for individual entrepreneurs. This
		// provider-specific absence is not valid for legal entities or branches.
		const validBranch =
			data.branch_type === 'MAIN' ||
			(individual &&
				(data.branch_type === undefined || data.branch_type === null));
		if (
			data.inn !== inn ||
			data.type !== expectedType ||
			!validBranch ||
			(individual && data.kpp !== undefined && data.kpp !== null)
		)
			throw companyLookupUnavailable();
		const names = object(data.name);
		const legalName = text(names.full_with_opf, 2000);
		const name = text(names.short_with_opf ?? legalName, 200);
		const status = text(object(data.state).status, 64);
		const known = [
			'ACTIVE',
			'LIQUIDATING',
			'LIQUIDATED',
			'BANKRUPT',
			'REORGANIZING'
		];
		const address = data.address === null ? null : object(data.address);
		return Object.freeze({
			name,
			legalName,
			inn,
			kpp: individual ? null : nullableDigits(data.kpp, 9),
			ogrn: nullableDigits(data.ogrn, expectedType === 'LEGAL' ? 13 : 15),
			legalAddress:
				address === null
					? null
					: text(address.unrestricted_value ?? address.value, 2000),
			entityType: expectedType,
			status: (known.includes(status)
				? status
				: 'UNKNOWN') as CompanyLookupStatus
		});
	});
	return Object.freeze({
		schemaVersion: 1,
		provider: 'DADATA',
		queriedAt: queriedAt.toISOString(),
		inn,
		items: Object.freeze(items)
	});
}
