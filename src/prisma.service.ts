import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

function getDatabaseUrl() {
	const mode = process.env.MODE?.trim().toLowerCase() ?? 'development';
	if (mode !== 'development' && mode !== 'production') {
		throw new Error(
			`Unsupported MODE=${mode}: expected development or production`
		);
	}

	const databaseUrlKey =
		mode === 'production'
			? 'DATABASE_URL_PRODUCTION'
			: 'DATABASE_URL_DEVELOPMENT';
	const databaseUrl = process.env[databaseUrlKey]?.trim();

	if (!databaseUrl || databaseUrl === 'change_me') {
		throw new Error(
			`Database URL is missing for MODE=${mode}: set ${databaseUrlKey}`
		);
	}

	return databaseUrl;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
	private disconnectPromise: Promise<void> | null = null;

	constructor() {
		super({
			datasources: {
				db: {
					url: getDatabaseUrl()
				}
			}
		});
	}

	async onModuleInit() {
		await this.$connect();
	}

	disconnect() {
		this.disconnectPromise ??= this.$disconnect();
		return this.disconnectPromise;
	}
}
