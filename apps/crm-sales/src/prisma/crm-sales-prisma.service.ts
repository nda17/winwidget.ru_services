import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/crm-sales-client';

const DATABASE_URL_ERROR =
	'CRM Sales database URL is missing or invalid: set CRM_SALES_DATABASE_URL';
const PLACEHOLDER_PATTERN = /change[_-]?me|xyzxyzxyz|<[^>]+>|\$\{/i;

export function parseCrmSalesDatabaseUrl(value?: string): string {
	const databaseUrl = value?.trim();
	if (!databaseUrl || PLACEHOLDER_PATTERN.test(databaseUrl)) {
		throw new Error(DATABASE_URL_ERROR);
	}

	let parsed: URL;
	try {
		parsed = new URL(databaseUrl);
	} catch {
		throw new Error(DATABASE_URL_ERROR);
	}
	if (
		!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
		!parsed.hostname ||
		parsed.pathname.length <= 1
	) {
		throw new Error(DATABASE_URL_ERROR);
	}
	return databaseUrl;
}

@Injectable()
export class CrmSalesPrismaService
	extends PrismaClient
	implements OnModuleInit, OnModuleDestroy
{
	constructor() {
		super({
			datasources: {
				db: {
					url: parseCrmSalesDatabaseUrl(process.env.CRM_SALES_DATABASE_URL)
				}
			}
		});
	}

	async onModuleInit(): Promise<void> {
		await this.$connect();
	}

	async onModuleDestroy(): Promise<void> {
		await this.$disconnect();
	}
}
