import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/platform-client';

const DATABASE_URL_KEY = 'PLATFORM_DATABASE_URL';
const PLACEHOLDER_DATABASE_URLS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'postgresql://user:password@host:5432/database'
]);

export function getPlatformDatabaseUrl(): string {
	const databaseUrl = process.env[DATABASE_URL_KEY]?.trim();
	if (!databaseUrl || PLACEHOLDER_DATABASE_URLS.has(databaseUrl)) {
		throw new Error(
			`Platform database URL is missing: set ${DATABASE_URL_KEY}`
		);
	}
	return databaseUrl;
}

@Injectable()
export class PlatformPrismaService
	extends PrismaClient
	implements OnModuleInit
{
	private disconnectPromise: Promise<void> | null = null;

	constructor() {
		super({ datasources: { db: { url: getPlatformDatabaseUrl() } } });
	}

	async onModuleInit(): Promise<void> {
		await this.$connect();
	}

	disconnect(): Promise<void> {
		this.disconnectPromise ??= this.$disconnect();
		return this.disconnectPromise;
	}
}
