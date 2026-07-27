import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/notification-delivery-client';

const DATABASE_URL_KEY = 'NOTIFICATION_DELIVERY_DATABASE_URL';
const PLACEHOLDER_DATABASE_URLS = new Set([
	'change_me',
	'XYZXYZXYZ',
	'postgresql://user:password@host:5432/database'
]);

function getNotificationDeliveryDatabaseUrl() {
	const databaseUrl = process.env[DATABASE_URL_KEY]?.trim();

	if (!databaseUrl || PLACEHOLDER_DATABASE_URLS.has(databaseUrl)) {
		throw new Error(
			`Notification delivery database URL is missing: set ${DATABASE_URL_KEY}`
		);
	}

	return databaseUrl;
}

@Injectable()
export class NotificationDeliveryPrismaService
	extends PrismaClient
	implements OnModuleInit
{
	private disconnectPromise: Promise<void> | null = null;

	constructor() {
		super({
			datasources: {
				db: {
					url: getNotificationDeliveryDatabaseUrl()
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
