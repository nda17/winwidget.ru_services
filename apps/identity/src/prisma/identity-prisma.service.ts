import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/identity-client';

const DATABASE_URL_KEY = 'IDENTITY_DATABASE_URL';
const PLACEHOLDERS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'postgresql://user:password@host:5432/database'
]);

export function getIdentityDatabaseUrl(): string {
	const value = process.env[DATABASE_URL_KEY]?.trim();
	if (!value || PLACEHOLDERS.has(value)) {
		throw new Error(
			`Identity database URL is missing: set ${DATABASE_URL_KEY}`
		);
	}
	return value;
}

@Injectable()
export class IdentityPrismaService
	extends PrismaClient
	implements OnModuleInit
{
	private disconnectPromise: Promise<void> | null = null;

	constructor() {
		super({ datasources: { db: { url: getIdentityDatabaseUrl() } } });
	}

	async onModuleInit(): Promise<void> {
		await this.$connect();
	}

	disconnect(): Promise<void> {
		this.disconnectPromise ??= this.$disconnect();
		return this.disconnectPromise;
	}
}
