import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/widgets-client';

const DATABASE_URL_KEY = 'WIDGETS_DATABASE_URL';
const PLACEHOLDER_DATABASE_URLS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'postgresql://user:password@host:5432/database'
]);

export function getWidgetsDatabaseUrl(): string {
	const databaseUrl = process.env[DATABASE_URL_KEY]?.trim();
	if (!databaseUrl || PLACEHOLDER_DATABASE_URLS.has(databaseUrl)) {
		throw new Error(
			`Widgets database URL is missing: set ${DATABASE_URL_KEY}`
		);
	}
	return databaseUrl;
}

@Injectable()
export class WidgetsPrismaService
	extends PrismaClient
	implements OnModuleInit
{
	private disconnectPromise: Promise<void> | null = null;

	constructor() {
		super({
			datasources: {
				db: { url: getWidgetsDatabaseUrl() }
			}
		});
	}

	async onModuleInit(): Promise<void> {
		await this.$connect();
	}

	disconnect(): Promise<void> {
		this.disconnectPromise ??= this.$disconnect();
		return this.disconnectPromise;
	}
}
