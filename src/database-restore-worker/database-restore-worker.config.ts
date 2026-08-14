import type { DatabaseRestoreTarget } from '@/dev-tools/database-restore-queue.contract';
import { isAbsolute, join, resolve } from 'node:path';

export interface DatabaseRestoreTargetConfig {
	target: DatabaseRestoreTarget;
	label: string;
	host: '127.0.0.1';
	port: number;
	database: string;
	schema: string;
	adminRole: string;
	migrationRole: string;
	runtimeRoles: readonly string[];
	backupRole: string;
	allApplicationRoles: readonly string[];
	passwordFile: string;
	migrationsDirectory: string;
	anchorTables: readonly string[];
}

const MIN_QUEUE_SECRET_LENGTH = 32;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;

const PASSWORD_FILE_ENV_KEYS: Record<DatabaseRestoreTarget, string> = {
	core: 'DATABASE_RESTORE_CORE_ADMIN_PASSWORD_FILE',
	'notification-delivery':
		'DATABASE_RESTORE_NOTIFICATION_DELIVERY_ADMIN_PASSWORD_FILE',
	campaigns: 'DATABASE_RESTORE_CAMPAIGNS_ADMIN_PASSWORD_FILE',
	reporting: 'DATABASE_RESTORE_REPORTING_ADMIN_PASSWORD_FILE',
	widgets: 'DATABASE_RESTORE_WIDGETS_ADMIN_PASSWORD_FILE',
	billing: 'DATABASE_RESTORE_BILLING_ADMIN_PASSWORD_FILE',
	identity: 'DATABASE_RESTORE_IDENTITY_ADMIN_PASSWORD_FILE'
};

const PORT_ENV_KEYS: Record<DatabaseRestoreTarget, string> = {
	core: 'DATABASE_RESTORE_CORE_PORT',
	'notification-delivery': 'DATABASE_RESTORE_NOTIFICATION_DELIVERY_PORT',
	campaigns: 'DATABASE_RESTORE_CAMPAIGNS_PORT',
	reporting: 'DATABASE_RESTORE_REPORTING_PORT',
	widgets: 'DATABASE_RESTORE_WIDGETS_PORT',
	billing: 'DATABASE_RESTORE_BILLING_PORT',
	identity: 'DATABASE_RESTORE_IDENTITY_PORT'
};

export class DatabaseRestoreWorkerConfig {
	readonly storageDirectory: string;
	readonly queueSecret: string;
	readonly appRevision: string;
	readonly pollIntervalMs: number;
	readonly commandTimeoutMs: number;
	readonly productionMode: boolean;
	readonly targets: Readonly<
		Record<DatabaseRestoreTarget, DatabaseRestoreTargetConfig>
	>;

	constructor(
		environment: NodeJS.ProcessEnv = process.env,
		workingDirectory = process.cwd()
	) {
		this.storageDirectory = this.requireAbsolutePath(
			environment,
			'DATABASE_RESTORE_STORAGE_DIR'
		);
		const rawQueueSecret = environment.DATABASE_RESTORE_QUEUE_SECRET;
		if (
			!rawQueueSecret ||
			rawQueueSecret !== rawQueueSecret.trim() ||
			['change_me', 'XYZXYZXYZ'].includes(rawQueueSecret)
		) {
			throw new Error(
				'DATABASE_RESTORE_QUEUE_SECRET is required and must not contain surrounding whitespace'
			);
		}
		this.queueSecret = rawQueueSecret;
		if (
			Buffer.byteLength(this.queueSecret, 'utf8') < MIN_QUEUE_SECRET_LENGTH
		) {
			throw new Error(
				`DATABASE_RESTORE_QUEUE_SECRET must be at least ${MIN_QUEUE_SECRET_LENGTH} bytes`
			);
		}
		this.appRevision = this.requireValue(environment, 'APP_REVISION');
		if (!/^[0-9a-f]{40}$/.test(this.appRevision)) {
			throw new Error(
				'APP_REVISION must be the exact 40-character Git revision'
			);
		}

		this.pollIntervalMs = this.parseInteger(
			environment.DATABASE_RESTORE_POLL_INTERVAL_MS,
			DEFAULT_POLL_INTERVAL_MS,
			250,
			60_000,
			'DATABASE_RESTORE_POLL_INTERVAL_MS'
		);
		this.commandTimeoutMs = this.parseInteger(
			environment.DATABASE_RESTORE_COMMAND_TIMEOUT_MS,
			DEFAULT_COMMAND_TIMEOUT_MS,
			60_000,
			2 * 60 * 60 * 1_000,
			'DATABASE_RESTORE_COMMAND_TIMEOUT_MS'
		);
		this.productionMode =
			(environment.MODE || '').trim().toLowerCase() === 'production' ||
			(environment.NODE_ENV || '').trim().toLowerCase() === 'production';

		const migrationsRoot =
			environment.DATABASE_RESTORE_MIGRATIONS_ROOT?.trim()
				? resolve(environment.DATABASE_RESTORE_MIGRATIONS_ROOT.trim())
				: resolve(workingDirectory);
		const passwordFiles = Object.fromEntries(
			Object.entries(PASSWORD_FILE_ENV_KEYS).map(([target, key]) => [
				target,
				this.requireAbsolutePath(environment, key)
			])
		) as Record<DatabaseRestoreTarget, string>;

		this.targets = {
			core: this.target({
				target: 'core',
				label: 'Core',
				port: this.requireTargetPort(environment, 'core'),
				database: 'default_db',
				schema: 'public',
				adminRole: 'winwidget_core_admin',
				migrationRole: 'gen_user',
				runtimeRoles: ['winwidget_api_runtime', 'winwidget_maintenance'],
				backupRole: 'winwidget_backup',
				passwordFile: passwordFiles.core,
				migrationsDirectory: join(migrationsRoot, 'prisma/migrations'),
				anchorTables: [
					'_prisma_migrations',
					'User',
					'admin_event_logs',
					'identity_core_source_state',
					'outbox_events',
					'reporting_producer_state'
				]
			}),
			'notification-delivery': this.target({
				target: 'notification-delivery',
				label: 'Notification Delivery',
				port: this.requireTargetPort(environment, 'notification-delivery'),
				database: 'winwidget_notification_delivery',
				schema: 'notification_delivery',
				adminRole: 'winwidget_notification_delivery_admin',
				migrationRole: 'winwidget_notification_delivery_migration',
				runtimeRoles: ['winwidget_notification_delivery_runtime'],
				backupRole: 'winwidget_notification_delivery_backup',
				passwordFile: passwordFiles['notification-delivery'],
				migrationsDirectory: join(
					migrationsRoot,
					'apps/notification-delivery/prisma/migrations'
				),
				anchorTables: [
					'_prisma_migrations',
					'delivery_receipts',
					'outbox_events'
				]
			}),
			campaigns: this.target({
				target: 'campaigns',
				label: 'Campaigns',
				port: this.requireTargetPort(environment, 'campaigns'),
				database: 'winwidget_campaigns',
				schema: 'campaigns',
				adminRole: 'winwidget_campaigns_admin',
				migrationRole: 'winwidget_campaigns_migration',
				runtimeRoles: ['winwidget_campaigns_runtime'],
				backupRole: 'winwidget_campaigns_backup',
				passwordFile: passwordFiles.campaigns,
				migrationsDirectory: join(
					migrationsRoot,
					'apps/campaigns/prisma/migrations'
				),
				anchorTables: ['_prisma_migrations', 'campaigns', 'deliveries']
			}),
			reporting: this.target({
				target: 'reporting',
				label: 'Reporting',
				port: this.requireTargetPort(environment, 'reporting'),
				database: 'winwidget_reporting',
				schema: 'reporting',
				adminRole: 'winwidget_reporting_admin',
				migrationRole: 'winwidget_reporting_migration',
				runtimeRoles: ['winwidget_reporting_runtime'],
				backupRole: 'winwidget_reporting_backup',
				passwordFile: passwordFiles.reporting,
				migrationsDirectory: join(
					migrationsRoot,
					'apps/reporting/prisma/migrations'
				),
				anchorTables: [
					'_prisma_migrations',
					'identity_user_projections',
					'projection_receipts',
					'reporting_settings'
				]
			}),
			widgets: this.target({
				target: 'widgets',
				label: 'Widgets',
				port: this.requireTargetPort(environment, 'widgets'),
				database: 'winwidget_widgets',
				schema: 'widgets',
				adminRole: 'winwidget_widgets_admin',
				migrationRole: 'winwidget_widgets_migration',
				runtimeRoles: ['winwidget_widgets_runtime'],
				backupRole: 'winwidget_widgets_backup',
				passwordFile: passwordFiles.widgets,
				migrationsDirectory: join(
					migrationsRoot,
					'apps/widgets/prisma/migrations'
				),
				anchorTables: [
					'_prisma_migrations',
					'service_identity',
					'widgets',
					'outbox_events'
				]
			}),
			billing: this.target({
				target: 'billing',
				label: 'Billing',
				port: this.requireTargetPort(environment, 'billing'),
				database: 'winwidget_billing',
				schema: 'billing',
				adminRole: 'winwidget_billing_admin',
				migrationRole: 'winwidget_billing_migration',
				runtimeRoles: ['winwidget_billing_runtime'],
				backupRole: 'winwidget_billing_backup',
				passwordFile: passwordFiles.billing,
				migrationsDirectory: join(
					migrationsRoot,
					'apps/billing/prisma/migrations'
				),
				anchorTables: [
					'_prisma_migrations',
					'service_identity',
					'payments',
					'subscriptions',
					'outbox_events'
				]
			}),
			identity: this.target({
				target: 'identity',
				label: 'Identity',
				port: this.requireTargetPort(environment, 'identity'),
				database: 'winwidget_identity',
				schema: 'identity',
				adminRole: 'winwidget_identity_admin',
				migrationRole: 'winwidget_identity_migration',
				runtimeRoles: ['winwidget_identity_runtime'],
				backupRole: 'winwidget_identity_backup',
				passwordFile: passwordFiles.identity,
				migrationsDirectory: join(
					migrationsRoot,
					'apps/identity/prisma/migrations'
				),
				anchorTables: [
					'_prisma_migrations',
					'service_identity',
					'users',
					'auth_identities',
					'outbox_events'
				]
			})
		};
	}

	private target(
		input: Omit<
			DatabaseRestoreTargetConfig,
			'host' | 'allApplicationRoles'
		>
	): DatabaseRestoreTargetConfig {
		return Object.freeze({
			...input,
			host: '127.0.0.1' as const,
			allApplicationRoles: Object.freeze([
				input.migrationRole,
				...input.runtimeRoles,
				input.backupRole
			])
		});
	}

	private requireValue(
		environment: NodeJS.ProcessEnv,
		key: string
	): string {
		const value = environment[key]?.trim();
		if (!value || ['change_me', 'XYZXYZXYZ'].includes(value)) {
			throw new Error(`${key} is required`);
		}
		return value;
	}

	private requireAbsolutePath(
		environment: NodeJS.ProcessEnv,
		key: string
	): string {
		const value = this.requireValue(environment, key);
		if (!isAbsolute(value) || value === '/') {
			throw new Error(`${key} must be an absolute scoped path`);
		}
		return resolve(value);
	}

	private requireTargetPort(
		environment: NodeJS.ProcessEnv,
		target: DatabaseRestoreTarget
	): number {
		const key = PORT_ENV_KEYS[target];
		return this.parseInteger(
			this.requireValue(environment, key),
			0,
			1024,
			65535,
			key
		);
	}

	private parseInteger(
		raw: string | undefined,
		fallback: number,
		minimum: number,
		maximum: number,
		key: string
	): number {
		if (!raw?.trim()) return fallback;
		const parsed = Number(raw);
		if (
			!Number.isInteger(parsed) ||
			parsed < minimum ||
			parsed > maximum
		) {
			throw new Error(
				`${key} must be an integer between ${minimum} and ${maximum}`
			);
		}
		return parsed;
	}
}
