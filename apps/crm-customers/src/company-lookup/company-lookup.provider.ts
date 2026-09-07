import type { CompanyLookupResult } from './company-lookup.contract';

/** Server-side DI port. Providers return normalized requisites, never raw data.
 * Replacing a source changes the module binding and adapter, not CRM forms or
 * persisted Company records. Authorization/cache/rate limits remain in service. */
export abstract class CompanyLookupProvider {
	abstract assertConfigured(): void;
	abstract lookup(inn: string): Promise<CompanyLookupResult>;
}
