import { DatabaseRestoreWorkerConfig } from '@/database-restore-worker/database-restore-worker.config';
import {
	assertDatabaseRestoreTableOfContents,
	assertExactDatabaseMigrations,
	buildCoreRestoreAuditSql,
	buildDatabaseConnectionPreflightSql,
	buildDatabaseOwnershipAndAclRepairSql,
	buildDatabasePreReopenVerificationSql,
	buildDatabaseReopenSql,
	parseDatabaseMigrationRows
} from '@/database-restore-worker/database-restore-postgres';

function createConfig(): DatabaseRestoreWorkerConfig {
	return new DatabaseRestoreWorkerConfig(
		{
			DATABASE_RESTORE_STORAGE_DIR: '/restore',
			DATABASE_RESTORE_QUEUE_SECRET:
				'restore-queue-secret-32-bytes-minimum',
			DATABASE_RESTORE_CORE_PORT: '55434',
			DATABASE_RESTORE_NOTIFICATION_DELIVERY_PORT: '55432',
			DATABASE_RESTORE_CAMPAIGNS_PORT: '55433',
			DATABASE_RESTORE_REPORTING_PORT: '55435',
			DATABASE_RESTORE_WIDGETS_PORT: '55436',
			DATABASE_RESTORE_CORE_ADMIN_PASSWORD_FILE: '/secrets/core',
			DATABASE_RESTORE_NOTIFICATION_DELIVERY_ADMIN_PASSWORD_FILE:
				'/secrets/notification-delivery',
			DATABASE_RESTORE_CAMPAIGNS_ADMIN_PASSWORD_FILE: '/secrets/campaigns',
			DATABASE_RESTORE_REPORTING_ADMIN_PASSWORD_FILE: '/secrets/reporting',
			DATABASE_RESTORE_WIDGETS_ADMIN_PASSWORD_FILE: '/secrets/widgets',
			APP_REVISION: 'd'.repeat(40)
		},
		'/app'
	);
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
		expect(() =>
			assertDatabaseRestoreTableOfContents(
				`${valid}\n9; 6104 107 PUBLICATION TABLES IN SCHEMA reporting unsafe_publication winwidget_reporting_migration`,
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

	it('preserves the admin database owner and grants maintenance only explicit Core tables', () => {
		const core = createConfig().targets.core;
		const repairSql = buildDatabaseOwnershipAndAclRepairSql(core);
		const reopenSql = buildDatabaseReopenSql(core);

		expect(reopenSql).toContain(
			'ALTER DATABASE "default_db" OWNER TO "winwidget_core_admin"'
		);
		expect(reopenSql).not.toContain('OWNER TO "gen_user"');
		expect(repairSql).toContain(
			'"scheduled_job_runs"\n    TO "winwidget_maintenance"'
		);
		expect(repairSql).not.toContain(
			'ALL TABLES IN SCHEMA "public" TO "winwidget_api_runtime", "winwidget_maintenance"'
		);
		expect(repairSql).toContain(
			'REVOKE ALL ON TABLE "public"."reporting_producer_state" FROM "winwidget_api_runtime"'
		);
	});

	it.each([
		[
			'core',
			'gen_user',
			'public',
			'PUBLIC, "winwidget_api_runtime", "winwidget_maintenance", "winwidget_backup"'
		],
		[
			'notification-delivery',
			'winwidget_notification_delivery_migration',
			'notification_delivery',
			'PUBLIC, "winwidget_notification_delivery_runtime", "winwidget_notification_delivery_backup"'
		],
		[
			'campaigns',
			'winwidget_campaigns_migration',
			'campaigns',
			'PUBLIC, "winwidget_campaigns_runtime", "winwidget_campaigns_backup"'
		],
		[
			'reporting',
			'winwidget_reporting_migration',
			'reporting',
			'PUBLIC, "winwidget_reporting_runtime", "winwidget_reporting_backup"'
		],
		[
			'widgets',
			'winwidget_widgets_migration',
			'widgets',
			'PUBLIC, "winwidget_widgets_runtime", "winwidget_widgets_backup"'
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
			expect(verificationSql).toContain(
				`acldefault('f', to_regrole('${migrationRole}')::oid)`
			);
			expect(verificationSql).toContain(
				"RAISE EXCEPTION 'Future routine default ACL is invalid'"
			);
		}
	);

	it('pins the live PostgreSQL 18 database, owner and application roles before fencing', () => {
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
		expect(sql).toContain('pg_database_size(current_database())::TEXT');
	});

	it('builds an idempotent deterministic Core restore audit insert', () => {
		const sql = buildCoreRestoreAuditSql({
			jobId: '0190f8d5-16d6-4b31-9b42-58ceea54f94d',
			target: 'core',
			sha256: 'a'.repeat(64),
			requestedBy: 'dev-user'
		});

		expect(sql).toContain(
			"'database_restore_0190f8d5-16d6-4b31-9b42-58ceea54f94d'"
		);
		expect(sql).toContain("'DEV_DATABASE_RESTORE'");
		expect(sql).toContain('ON CONFLICT ("id") DO NOTHING');
		expect(sql).toContain("'status', 'SUCCEEDED'");
	});
});

describe('DatabaseRestoreWorkerConfig', () => {
	it('defines the isolated Widgets database, roles, migrations and anchors', () => {
		const target = createConfig().targets.widgets;

		expect(target).toMatchObject({
			target: 'widgets',
			label: 'Widgets',
			host: '127.0.0.1',
			port: 55436,
			database: 'winwidget_widgets',
			schema: 'widgets',
			adminRole: 'winwidget_widgets_admin',
			migrationRole: 'winwidget_widgets_migration',
			runtimeRoles: ['winwidget_widgets_runtime'],
			backupRole: 'winwidget_widgets_backup',
			passwordFile: '/secrets/widgets',
			migrationsDirectory: '/app/apps/widgets/prisma/migrations',
			anchorTables: [
				'_prisma_migrations',
				'service_identity',
				'widgets',
				'outbox_events'
			]
		});
	});

	it('rejects queue secrets with surrounding whitespace', () => {
		expect(
			() =>
				new DatabaseRestoreWorkerConfig({
					DATABASE_RESTORE_STORAGE_DIR: '/restore',
					DATABASE_RESTORE_QUEUE_SECRET:
						' restore-queue-secret-32-bytes-minimum ',
					DATABASE_RESTORE_CORE_PORT: '55434',
					DATABASE_RESTORE_NOTIFICATION_DELIVERY_PORT: '55432',
					DATABASE_RESTORE_CAMPAIGNS_PORT: '55433',
					DATABASE_RESTORE_REPORTING_PORT: '55435',
					DATABASE_RESTORE_WIDGETS_PORT: '55436',
					DATABASE_RESTORE_CORE_ADMIN_PASSWORD_FILE: '/secrets/core',
					DATABASE_RESTORE_NOTIFICATION_DELIVERY_ADMIN_PASSWORD_FILE:
						'/secrets/notification-delivery',
					DATABASE_RESTORE_CAMPAIGNS_ADMIN_PASSWORD_FILE:
						'/secrets/campaigns',
					DATABASE_RESTORE_REPORTING_ADMIN_PASSWORD_FILE:
						'/secrets/reporting',
					DATABASE_RESTORE_WIDGETS_ADMIN_PASSWORD_FILE: '/secrets/widgets',
					APP_REVISION: 'd'.repeat(40)
				})
		).toThrow('must not contain surrounding whitespace');
	});
});
