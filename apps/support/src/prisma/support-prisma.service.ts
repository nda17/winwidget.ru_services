import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/support-client';

const PLACEHOLDER_DATABASE_URLS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'postgresql://user:password@host:5432/database'
]);

export function getSupportDatabaseUrl(): string {
	const databaseUrl = process.env.SUPPORT_DATABASE_URL?.trim();
	if (!databaseUrl || PLACEHOLDER_DATABASE_URLS.has(databaseUrl)) {
		throw new Error(
			'Support database URL is missing: set SUPPORT_DATABASE_URL'
		);
	}
	return databaseUrl;
}

@Injectable()
export class SupportPrismaService
	extends PrismaClient
	implements OnModuleInit
{
	private disconnectPromise: Promise<void> | null = null;

	constructor() {
		super({ datasources: { db: { url: getSupportDatabaseUrl() } } });
	}

	async onModuleInit(): Promise<void> {
		await this.$connect();
	}

	disconnect(): Promise<void> {
		this.disconnectPromise ??= this.$disconnect();
		return this.disconnectPromise;
	}
}
