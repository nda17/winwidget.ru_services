import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/crm-access-client';

const DATABASE_URL_KEY = 'CRM_ACCESS_DATABASE_URL';
const PLACEHOLDER_DATABASE_URLS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'postgresql://user:password@host:5432/database'
]);

export function getCrmAccessDatabaseUrl(): string {
	const databaseUrl = process.env[DATABASE_URL_KEY]?.trim();
	if (!databaseUrl || PLACEHOLDER_DATABASE_URLS.has(databaseUrl)) {
		throw new Error(
			`CRM Access database URL is missing: set ${DATABASE_URL_KEY}`
		);
	}
	return databaseUrl;
}

@Injectable()
export class CrmAccessPrismaService
	extends PrismaClient
	implements OnModuleInit
{
	private disconnectPromise: Promise<void> | null = null;

	constructor() {
		super({ datasources: { db: { url: getCrmAccessDatabaseUrl() } } });
	}

	async onModuleInit(): Promise<void> {
		await this.$connect();
	}

	disconnect(): Promise<void> {
		this.disconnectPromise ??= this.$disconnect();
		return this.disconnectPromise;
	}
}
