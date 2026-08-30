import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { DatabaseRestoreTarget } from './database-restore.contract';

export interface DatabaseRestoreTargetConfiguration {
	environmentPrefix: string;
	database: string;
	schema: string;
	adminRole: string;
	migrationRole: string;
	runtimeRole: string;
	backupRole: string;
}

export interface DatabaseRestoreConnection {
	host: '127.0.0.1';
	port: number;
	user: string;
	database: string;
	password: string;
}

const TARGETS: Record<
	DatabaseRestoreTarget,
	DatabaseRestoreTargetConfiguration
> = {
	'notification-delivery': {
		environmentPrefix: 'NOTIFICATION_DELIVERY',
		database: 'winwidget_notification_delivery',
		schema: 'notification_delivery',
		adminRole: 'winwidget_notification_delivery_admin',
		migrationRole: 'winwidget_notification_delivery_migration',
		runtimeRole: 'winwidget_notification_delivery_runtime',
		backupRole: 'winwidget_notification_delivery_backup'
	},
	campaigns: {
		environmentPrefix: 'CAMPAIGNS',
		database: 'winwidget_campaigns',
		schema: 'campaigns',
		adminRole: 'winwidget_campaigns_admin',
		migrationRole: 'winwidget_campaigns_migration',
		runtimeRole: 'winwidget_campaigns_runtime',
		backupRole: 'winwidget_campaigns_backup'
	},
	reporting: {
		environmentPrefix: 'REPORTING',
		database: 'winwidget_reporting',
		schema: 'reporting',
		adminRole: 'winwidget_reporting_admin',
		migrationRole: 'winwidget_reporting_migration',
		runtimeRole: 'winwidget_reporting_runtime',
		backupRole: 'winwidget_reporting_backup'
	},
	widgets: {
		environmentPrefix: 'WIDGETS',
		database: 'winwidget_widgets',
		schema: 'widgets',
		adminRole: 'winwidget_widgets_admin',
		migrationRole: 'winwidget_widgets_migration',
		runtimeRole: 'winwidget_widgets_runtime',
		backupRole: 'winwidget_widgets_backup'
	},
	billing: {
		environmentPrefix: 'BILLING',
		database: 'winwidget_billing',
		schema: 'billing',
		adminRole: 'winwidget_billing_admin',
		migrationRole: 'winwidget_billing_migration',
		runtimeRole: 'winwidget_billing_runtime',
		backupRole: 'winwidget_billing_backup'
	},
	identity: {
		environmentPrefix: 'IDENTITY',
		database: 'winwidget_identity',
		schema: 'identity',
		adminRole: 'winwidget_identity_admin',
		migrationRole: 'winwidget_identity_migration',
		runtimeRole: 'winwidget_identity_runtime',
		backupRole: 'winwidget_identity_backup'
	},
	platform: {
		environmentPrefix: 'PLATFORM',
		database: 'winwidget_platform',
		schema: 'platform',
		adminRole: 'winwidget_platform_admin',
		migrationRole: 'winwidget_platform_migration',
		runtimeRole: 'winwidget_platform_runtime',
		backupRole: 'winwidget_platform_backup'
	},
	support: {
		environmentPrefix: 'SUPPORT',
		database: 'winwidget_support',
		schema: 'support',
		adminRole: 'winwidget_support_admin',
		migrationRole: 'winwidget_support_migration',
		runtimeRole: 'winwidget_support_runtime',
		backupRole: 'winwidget_support_backup'
	},
	operations: {
		environmentPrefix: 'OPERATIONS',
		database: 'winwidget_operations',
		schema: 'operations',
		adminRole: 'winwidget_operations_admin',
		migrationRole: 'winwidget_operations_migration',
		runtimeRole: 'winwidget_operations_runtime',
		backupRole: 'winwidget_operations_backup'
	}
};

@Injectable()
export class DatabaseRestoreTargetRegistryService {
	constructor(private readonly config: ConfigService) {}

	get(target: DatabaseRestoreTarget): DatabaseRestoreTargetConfiguration {
		return TARGETS[target];
	}

	all(): DatabaseRestoreTargetConfiguration[] {
		return Object.values(TARGETS);
	}

	async connection(
		target: DatabaseRestoreTargetConfiguration
	): Promise<DatabaseRestoreConnection> {
		const userKey = `${target.environmentPrefix}_POSTGRES_ADMIN_USER`;
		const portKey = `${target.environmentPrefix}_POSTGRES_PORT`;
		const passwordFileKey = `DATABASE_RESTORE_${target.environmentPrefix}_ADMIN_PASSWORD_FILE`;
		const user = this.config.get<string>(userKey)?.trim();
		if (user !== target.adminRole) {
			throw new Error(`${userKey} must be ${target.adminRole}`);
		}
		const rawPort = this.config.get<string>(portKey)?.trim();
		const port = rawPort ? Number(rawPort) : Number.NaN;
		if (!Number.isInteger(port) || port < 1 || port > 65_535) {
			throw new Error(`${portKey} must be an integer between 1 and 65535`);
		}
		const passwordFile = this.config.get<string>(passwordFileKey)?.trim();
		if (
			!passwordFile ||
			!isAbsolute(passwordFile) ||
			passwordFile === '/'
		) {
			throw new Error(`${passwordFileKey} must be an absolute file path`);
		}
		const password = await this.readSecret(passwordFile, passwordFileKey);
		return {
			host: '127.0.0.1',
			port,
			user,
			database: target.database,
			password
		};
	}

	private async readSecret(path: string, key: string): Promise<string> {
		let handle: FileHandle | undefined;
		try {
			handle = await open(
				path,
				constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
			);
			const metadata = await handle.stat();
			if (
				!metadata.isFile() ||
				metadata.size < 1 ||
				metadata.size > 4_096
			) {
				throw new Error(`${key} does not reference a valid secret file`);
			}
			const raw = await handle.readFile({ encoding: 'utf8' });
			const password = raw.replace(/\r?\n$/, '');
			if (
				!password ||
				password !== password.trim() ||
				/[\u0000\r\n]/.test(password) ||
				['change_me', 'XYZXYZXYZ'].includes(password)
			) {
				throw new Error(`${key} contains an invalid secret`);
			}
			return password;
		} catch (error) {
			if (error instanceof Error && error.message.startsWith(key)) {
				throw error;
			}
			throw new Error(`${key} could not be read safely`);
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}
}
