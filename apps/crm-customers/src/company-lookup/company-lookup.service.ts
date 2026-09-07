import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
	assertCustomersPermission,
	type CustomersAuthorization
} from '../access/customers-authorization.client';
import {
	assertCompanyLookupInn,
	type CompanyLookupResult
} from './company-lookup.contract';

import { CompanyLookupProvider } from './company-lookup.provider';

const BUSY_RETRY_MS = 5000;
const MINUTE_MS = 60_000;
const CACHE_TTL_MS = 15 * MINUTE_MS;
const NEGATIVE_TTL_MS = 30_000;
const CACHE_LIMIT = 1000;

interface RateEntry {
	readonly at: number;
	readonly workspace: string;
	readonly actor: string;
}
interface CacheEntry {
	readonly expiresAt: number;
	readonly result: CompanyLookupResult;
}
function limited(seconds: number): HttpException {
	return new HttpException(
		{
			code: 'crm_company_lookup_rate_limited',
			message: 'Слишком много запросов поиска. Повторите немного позже.',
			retryAfterSeconds: Math.max(1, Math.ceil(seconds))
		},
		HttpStatus.TOO_MANY_REQUESTS
	);
}

@Injectable()
export class CompanyLookupService {
	constructor(private readonly provider: CompanyLookupProvider) {}

	// Per-process protection, not a distributed or provider-account quota.
	private readonly cache = new Map<string, CacheEntry>();
	private readonly pending = new Map<
		string,
		Promise<CompanyLookupResult>
	>();
	private requests: RateEntry[] = [];

	async lookup(
		context: CustomersAuthorization,
		inn: string
	): Promise<CompanyLookupResult> {
		assertCustomersPermission(context, 'customers:read');
		assertCustomersPermission(context, 'customers:write', true);
		assertCompanyLookupInn(inn);
		this.provider.assertConfigured();
		const now = Date.now();
		this.reserve(context, now);
		for (const [cachedInn, entry] of this.cache)
			if (entry.expiresAt <= now) this.cache.delete(cachedInn);
		const cached = this.cache.get(inn);
		if (cached) {
			this.cache.delete(inn);
			this.cache.set(inn, cached);
			return cached.result;
		}
		const pending = this.pending.get(inn);
		if (pending) return pending;
		if (this.pending.size >= 2) throw limited(BUSY_RETRY_MS / 1000);
		const request = this.provider
			.lookup(inn)
			.then(result => {
				while (this.cache.size >= CACHE_LIMIT)
					this.cache.delete(this.cache.keys().next().value!);
				this.cache.set(inn, {
					expiresAt:
						Date.now() +
						(result.items.length ? CACHE_TTL_MS : NEGATIVE_TTL_MS),
					result
				});
				return result;
			})
			.finally(() => {
				this.pending.delete(inn);
			});
		this.pending.set(inn, request);
		return request;
	}
	private reserve(context: CustomersAuthorization, now: number): void {
		// Sliding window includes authorized cache hits/single-flight followers.
		// Maximum 30 entries also bounds actor/workspace limiter memory.
		this.requests = this.requests.filter(
			entry => entry.at > now - MINUTE_MS
		);
		const workspace = this.requests.filter(
			entry => entry.workspace === context.workspaceId
		);
		const actor = workspace.filter(
			entry => entry.actor === context.subject
		);
		const exhausted = [
			{ entries: this.requests, maximum: 30 },
			{ entries: workspace, maximum: 20 },
			{ entries: actor, maximum: 10 }
		].filter(limit => limit.entries.length >= limit.maximum);
		if (exhausted.length)
			throw limited(
				Math.max(
					...exhausted.map(
						limit => (limit.entries[0].at + MINUTE_MS - now) / 1000
					)
				)
			);
		this.requests.push({
			at: now,
			workspace: context.workspaceId,
			actor: context.subject
		});
	}
}
