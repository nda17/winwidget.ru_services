import {
	Injectable,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { PrismaClient } from '@prisma/crm-intake-client';

const DATABASE_URL_ERROR =
	'CRM Intake database URL is missing or invalid: set CRM_INTAKE_DATABASE_URL';
const PLACEHOLDER_PATTERN = /change[_-]?me|xyzxyzxyz|<[^>]+>|\$\{/i;

export function parseCrmIntakeDatabaseUrl(value?: string): string {
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
export class CrmIntakePrismaService
	extends PrismaClient
	implements OnModuleInit, OnApplicationShutdown
{
	constructor() {
		super({
			datasources: {
				db: {
					url: parseCrmIntakeDatabaseUrl(
						process.env.CRM_INTAKE_DATABASE_URL
					)
				}
			}
		});
	}

	async onModuleInit(): Promise<void> {
		await this.$connect();
	}

	async onApplicationShutdown(): Promise<void> {
		await this.$disconnect();
	}
}
