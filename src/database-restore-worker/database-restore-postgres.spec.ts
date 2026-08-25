import { DatabaseRestoreWorkerConfig } from '@/database-restore-worker/database-restore-worker.config';
import {
	assertDatabaseRestoreTableOfContents,
	assertExactDatabaseMigrations,
	buildDatabaseConnectionPreflightSql,
	buildDatabaseOwnershipAndAclRepairSql,
	buildDatabasePreReopenVerificationSql,
	buildDatabaseReopenSql,
	parseDatabaseMigrationRows
} from '@/database-restore-worker/database-restore-postgres';

function createEnvironment(): NodeJS.ProcessEnv {
	return {
		DATABASE_RESTORE_STORAGE_DIR: '/restore',
		DATABASE_RESTORE_QUEUE_SECRET: 'restore-queue-secret-32-bytes-minimum',
		DATABASE_RESTORE_NOTIFICATION_DELIVERY_PORT: '55432',
		DATABASE_RESTORE_CAMPAIGNS_PORT: '55433',
		DATABASE_RESTORE_REPORTING_PORT: '55435',
		DATABASE_RESTORE_WIDGETS_PORT: '55436',
		DATABASE_RESTORE_BILLING_PORT: '55437',
		DATABASE_RESTORE_IDENTITY_PORT: '55438',
		DATABASE_RESTORE_PLATFORM_PORT: '55439',
		DATABASE_RESTORE_SUPPORT_PORT: '55440',
		DATABASE_RESTORE_NOTIFICATION_DELIVERY_ADMIN_PASSWORD_FILE:
			'/secrets/notification-delivery',
		DATABASE_RESTORE_CAMPAIGNS_ADMIN_PASSWORD_FILE: '/secrets/campaigns',
		DATABASE_RESTORE_REPORTING_ADMIN_PASSWORD_FILE: '/secrets/reporting',
		DATABASE_RESTORE_WIDGETS_ADMIN_PASSWORD_FILE: '/secrets/widgets',
		DATABASE_RESTORE_BILLING_ADMIN_PASSWORD_FILE: '/secrets/billing',
		DATABASE_RESTORE_IDENTITY_ADMIN_PASSWORD_FILE: '/secrets/identity',
		DATABASE_RESTORE_PLATFORM_ADMIN_PASSWORD_FILE: '/secrets/platform',
		DATABASE_RESTORE_SUPPORT_ADMIN_PASSWORD_FILE: '/secrets/support',
		APP_REVISION: 'd'.repeat(40)
	};
}

function createConfig(): DatabaseRestoreWorkerConfig {
	return new DatabaseRestoreWorkerConfig(createEnvironment(), '/app');
}

describe('database restore PostgreSQL contract', () => {
	it('accepts only the selected schema with all target anchors', () => {
		const target = createConfig().targets.reporting;
		const valid = [
			'1; 0 0 ENCODING - UTF8',
			'2; 2615 100 SCHEMA - reporting winwidget_reporting_migration',
			'3; 1259 101 TABLE reporting _prisma_migrations winwidget_reporting_migration',
			'4; 1259 102 TABLE reporting identity_user_projections winwidget_reporting_migration',
			'5; 1259 103 TABLE reporting projection_receipts winwidget_reporting_migration',
			'6; 1259 104 TABLE reporting reporting_settings winwidget_reporting_migration'
		].join('\n');

		expect(
			assertDatabaseRestoreTableOfContents(valid, target).tables.has(
				'reporting_settings'
			)
		).toBe(true);
		expect(() =>
			assertDatabaseRestoreTableOfContents(
				`${valid}\n7; 1259 105 TABLE public User gen_user`,
				target
			)
		).toThrow('outside target schema');
		expect(() =>
			assertDatabaseRestoreTableOfContents(
				`${valid}\n8; 3456 106 COLLATION reporting unsafe_collation winwidget_reporting_migration`,
				target
			)
		).toThrow('ownership cannot be restored safely');
	});

	it('requires an exact fully-applied Prisma migration ledger', () => {
		const expected = [
			{
				migrationName: '20260730000000_init_campaigns',
				checksum: 'a'.repeat(64)
			}
		];
		const actual = parseDatabaseMigrationRows(
			`20260730000000_init_campaigns\t${'a'.repeat(64)}\tapplied\n`
		);

		expect(() =>
			assertExactDatabaseMigrations(actual, expected)
		).not.toThrow();
		expect(() =>
			parseDatabaseMigrationRows(
				`20260730000000_init_campaigns\t${'a'.repeat(64)}\tinvalid\n`
			)
		).toThrow('migration ledger is invalid');
		expect(() =>
			assertExactDatabaseMigrations(
				[
					...actual,
					{
						migrationName: '20260730010000_unexpected',
						checksum: 'b'.repeat(64)
					}
				],
				expected
			)
		).toThrow('do not match this release');
	});

	it('repairs and verifies least-privilege service ACLs', () => {
		const target = createConfig().targets.reporting;
		const repairSql = buildDatabaseOwnershipAndAclRepairSql(target);
		const verificationSql = buildDatabasePreReopenVerificationSql(target);
		const reopenSql = buildDatabaseReopenSql(target);

		expect(repairSql).toContain(
			'REVOKE ALL ON TABLE "reporting"."_prisma_migrations" FROM "winwidget_reporting_runtime"'
		);
		expect(repairSql).toContain(
			'GRANT SELECT ON ALL TABLES IN SCHEMA "reporting" TO "winwidget_reporting_backup"'
		);
		expect(verificationSql).toContain(
			"RAISE EXCEPTION 'Service runtime has unexpected routine execution privilege'"
		);
		expect(reopenSql).toContain(
			'ALTER DATABASE "winwidget_reporting" OWNER TO "winwidget_reporting_admin"'
		);
		expect(repairSql).not.toContain('winwidget_core');
		expect(verificationSql).not.toContain('Core restore');
	});

	it.each([
		[
			'notification-delivery',
			'winwidget_notification_delivery_migration',
			'notification_delivery',
			'PUBLIC, "winwidget_notification_delivery_runtime", "winwidget_notification_delivery_backup"'
		],
		[
			'reporting',
			'winwidget_reporting_migration',
			'reporting',
			'PUBLIC, "winwidget_reporting_runtime", "winwidget_reporting_backup"'
		],
		[
			'support',
			'winwidget_support_migration',
			'support',
			'PUBLIC, "winwidget_support_runtime", "winwidget_support_backup"'
		]
	] as const)(
		'hardens future function ACL for %s',
		(targetName, migrationRole, schema, restrictedRoles) => {
			const target = createConfig().targets[targetName];
			const repairSql = buildDatabaseOwnershipAndAclRepairSql(target);
			const verificationSql =
				buildDatabasePreReopenVerificationSql(target);

			expect(repairSql).toContain(
				`ALTER DEFAULT PRIVILEGES FOR ROLE "${migrationRole}" IN SCHEMA "${schema}"\n    REVOKE ALL ON FUNCTIONS FROM PUBLIC;`
			);
			expect(repairSql).toContain(
				`ALTER DEFAULT PRIVILEGES FOR ROLE "${migrationRole}"\n    REVOKE ALL ON FUNCTIONS FROM ${restrictedRoles};`
			);
			expect(verificationSql).toContain('defaults.defaclnamespace = 0');
		}
	);

	it('pins the live PostgreSQL 18 database, owner and roles before fencing', () => {
		const target = createConfig().targets['notification-delivery'];
		const sql = buildDatabaseConnectionPreflightSql(target);

		expect(sql).toContain(
			"current_database() <> 'winwidget_notification_delivery'"
		);
		expect(sql).toContain(
			"current_user <> 'winwidget_notification_delivery_admin'"
		);
		expect(sql).toContain("current_setting('server_version_num')");
		expect(sql).toContain(
			"ARRAY['winwidget_notification_delivery_migration', 'winwidget_notification_delivery_runtime', 'winwidget_notification_delivery_backup']::TEXT[]"
		);
	});
});

describe('DatabaseRestoreWorkerConfig', () => {
	it('defines only isolated service database targets', () => {
		const config = createConfig();

		expect(Object.keys(config.targets).sort()).toEqual([
			'billing',
			'campaigns',
			'identity',
			'notification-delivery',
			'platform',
			'reporting',
			'support',
			'widgets'
		]);
		expect(config.targets.support).toMatchObject({
			target: 'support',
			port: 55440,
			database: 'winwidget_support',
			schema: 'support',
			adminRole: 'winwidget_support_admin',
			migrationRole: 'winwidget_support_migration',
			runtimeRoles: ['winwidget_support_runtime'],
			backupRole: 'winwidget_support_backup',
			passwordFile: '/secrets/support',
			migrationsDirectory: '/app/apps/support/prisma/migrations',
			anchorTables: [
				'_prisma_migrations',
				'service_identity',
				'routing_settings',
				'telegram_webhook_inbox',
				'outbox_events'
			]
		});
	});

	it('rejects queue secrets with surrounding whitespace', () => {
		const environment = createEnvironment();
		environment.DATABASE_RESTORE_QUEUE_SECRET =
			' restore-queue-secret-32-bytes-minimum ';

		expect(
			() => new DatabaseRestoreWorkerConfig(environment, '/app')
		).toThrow('must not contain surrounding whitespace');
	});
});
