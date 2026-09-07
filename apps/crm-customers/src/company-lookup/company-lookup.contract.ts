import {
	BadRequestException,
	ServiceUnavailableException
} from '@nestjs/common';

export type CompanyLookupEntityType = 'LEGAL' | 'INDIVIDUAL';
export type CompanyLookupStatus =
	| 'ACTIVE'
	| 'LIQUIDATING'
	| 'LIQUIDATED'
	| 'BANKRUPT'
	| 'REORGANIZING'
	| 'UNKNOWN';
export interface CompanyLookupItem {
	readonly name: string;
	readonly legalName: string;
	readonly inn: string;
	readonly kpp: string | null;
	readonly ogrn: string | null;
	readonly legalAddress: string | null;
	readonly entityType: CompanyLookupEntityType;
	readonly status: CompanyLookupStatus;
}
export interface CompanyLookupResult {
	readonly schemaVersion: 1;
	/** Stable provider identifier; forms and persistence are provider-neutral. */
	readonly provider: string;
	/** Provider snapshot time, retained on a cache hit. Not a persistence receipt. */
	readonly queriedAt: string;
	readonly inn: string;
	readonly items: readonly CompanyLookupItem[];
}

/** This stricter check belongs only to optional lookup. Manual CRM INN entry
 * and the existing company mutation contract deliberately remain unchanged. */
export function isValidCompanyLookupInn(value: unknown): value is string {
	if (
		typeof value !== 'string' ||
		![10, 12].includes(value.length) ||
		/[^0-9]/.test(value) ||
		/^0+$/.test(value)
	)
		return false;
	const digits = [...value].map(Number);
	const check = (weights: number[]) =>
		(weights.reduce(
			(sum, weight, index) => sum + weight * digits[index],
			0
		) %
			11) %
		10;
	return digits.length === 10
		? check([2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[9]
		: check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[10] &&
				check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === digits[11];
}
export function assertCompanyLookupInn(
	value: unknown
): asserts value is string {
	if (!isValidCompanyLookupInn(value))
		throw new BadRequestException({
			code: 'crm_company_lookup_invalid_inn',
			message: 'Укажите корректный ИНН из 10 или 12 цифр.'
		});
}
export function companyLookupUnavailable(): ServiceUnavailableException {
	return new ServiceUnavailableException({
		code: 'crm_company_lookup_unavailable',
		message:
			'Поиск компании временно недоступен. Повторите позже или заполните данные вручную.'
	});
}
