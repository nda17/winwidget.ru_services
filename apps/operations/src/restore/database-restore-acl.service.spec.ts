import { DatabaseRestoreAclService } from './database-restore-acl.service';
import { DatabaseRestoreProcessService } from './database-restore-process.service';
import {
	DatabaseRestoreConnection,
	DatabaseRestoreTargetConfiguration
} from './database-restore-target-registry.service';

const connection: DatabaseRestoreConnection = {
	host: '127.0.0.1',
	port: 55441,
	user: 'winwidget_reporting_admin',
	database: 'winwidget_reporting',
	password: 'test-restore-password'
};

const reportingTarget: DatabaseRestoreTargetConfiguration = {
	environmentPrefix: 'REPORTING',
	database: 'winwidget_reporting',
	schema: 'reporting',
	adminRole: 'winwidget_reporting_admin',
	migrationRole: 'winwidget_reporting_migration',
	runtimeRole: 'winwidget_reporting_runtime',
	backupRole: 'winwidget_reporting_backup',
	acl: {
		profile: 'standard',
		routines: ['reject_report_run_snapshot_mutation()'],
		runtimeRoutines: []
	}
};

const widgetsTarget: DatabaseRestoreTargetConfiguration = {
	environmentPrefix: 'WIDGETS',
	database: 'winwidget_widgets',
	schema: 'widgets',
	adminRole: 'winwidget_widgets_admin',
	migrationRole: 'winwidget_widgets_migration',
	runtimeRole: 'winwidget_widgets_runtime',
	backupRole: 'winwidget_widgets_backup',
	acl: {
		profile: 'standard',
		routines: ['enforce_ai_consent_receipt_immutability()'],
		runtimeRoutines: []
	}
};

const platformTarget: DatabaseRestoreTargetConfiguration = {
	environmentPrefix: 'PLATFORM',
	database: 'winwidget_platform',
	schema: 'platform',
	adminRole: 'winwidget_platform_admin',
	migrationRole: 'winwidget_platform_migration',
	runtimeRole: 'winwidget_platform_runtime',
	backupRole: 'winwidget_platform_backup',
	acl: {
		profile: 'platform',
		routines: [
			'current_semantic_fingerprint()',
			'enforce_billing_offer_producer_cursor()',
			'enforce_current_semantic_fingerprint()',
			'enforce_service_identity_integrity()',
			'refresh_current_semantic_fingerprint(text)'
		],
		runtimeRoutines: [
			'current_semantic_fingerprint()',
			'refresh_current_semantic_fingerprint(text)'
		]
	}
};

const setup = () => {
	const process = {
		executeSql: jest.fn<
			Promise<void>,
			[DatabaseRestoreConnection, string, AbortSignal?]
		>(async () => undefined)
	};
	return {
		process,
		service: new DatabaseRestoreAclService(
			process as unknown as DatabaseRestoreProcessService
		)
	};
};

describe('DatabaseRestoreAclService', () => {
	it('verifies the exact role, database, object, routine, and default ACL boundary', async () => {
		const { process, service } = setup();
		const signal = new AbortController().signal;

		await service.verify(connection, reportingTarget, signal);

		expect(process.executeSql).toHaveBeenCalledTimes(1);
		expect(process.executeSql).toHaveBeenCalledWith(
			connection,
			expect.any(String),
			signal
		);
		const sql = process.executeSql.mock.calls[0][1];
		expect(sql).not.toContain('BEGIN;');
		expect(sql).toContain("current_database() <> 'winwidget_reporting'");
		expect(sql).toContain(
			'membership.roleid IN (admin_oid, migration_oid, runtime_oid, backup_oid)'
		);
		expect(sql).toContain(
			'Database restore has an unexpected login superuser'
		);
		expect(sql).toContain('Database restore database privileges drifted');
		expect(sql).toContain('to_regprocedure(expected.signature)::OID');
		expect(sql).toContain(
			"'reporting.reject_report_run_snapshot_mutation()'"
		);
		expect(sql).toContain("acldefault('s', relation.relowner)");
		expect(sql).toContain("defaults.defaclobjtype = 'S'");
		expect(sql).toContain(
			"'winwidget_reporting_backup'::TEXT, 'CONNECT'::TEXT"
		);
	});

	it('reconciles Platform with its least-privilege table, column, and routine allowlists', async () => {
		const { process, service } = setup();
		const platformConnection = {
			...connection,
			user: platformTarget.adminRole,
			database: platformTarget.database
		};

		await service.reconcileAndVerify(platformConnection, platformTarget);

		const sql = process.executeSql.mock.calls[0][1];
		expect(sql.startsWith('BEGIN;')).toBe(true);
		expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
		expect(sql).toContain(
			'SET LOCAL ROLE "winwidget_platform_migration";'
		);
		expect(sql).toContain(
			'GRANT SELECT ON TABLE "platform"."service_identity", "platform"."source_sequences", "platform"."site_settings", "platform"."legal_pages", "platform"."home_page_content", "platform"."billing_offer_producer_state", "platform"."outbox_events" TO "winwidget_platform_runtime";'
		);
		expect(sql).toContain(
			'GRANT UPDATE ("current_semantic_fingerprint", "updated_at") ON TABLE "platform"."service_identity" TO "winwidget_platform_runtime";'
		);
		expect(sql).toContain(
			'GRANT EXECUTE ON FUNCTION "platform"."current_semantic_fingerprint"() TO "winwidget_platform_runtime";'
		);
		expect(sql).toContain(
			'GRANT EXECUTE ON FUNCTION "platform"."refresh_current_semantic_fingerprint"(TEXT) TO "winwidget_platform_runtime";'
		);
		expect(sql).toContain(
			'GRANT SELECT ON TABLES TO "winwidget_platform_backup";'
		);
		expect(sql).not.toContain(
			'GRANT SELECT ON TABLES TO "winwidget_platform_runtime";'
		);
		expect(sql).not.toContain(
			'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "platform" TO "winwidget_platform_runtime";'
		);
		expect(sql).not.toContain(
			'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "platform"'
		);
		expect(sql).toContain(
			'Database restore Platform table allowlist drifted'
		);
		expect(sql).toContain('relation.relkind::TEXT AS relkind');
		expect(sql).toContain(
			'Database restore Platform sequence allowlist drifted'
		);
		expect(sql).toContain(
			'Database restore global table default privileges drifted'
		);
		expect(sql).toContain(
			'Database restore global sequence default privileges drifted'
		);
	});

	it('keeps the Widgets consent immutability trigger routine owner-only after restore', async () => {
		const { process, service } = setup();
		const widgetsConnection = {
			...connection,
			user: widgetsTarget.adminRole,
			database: widgetsTarget.database
		};

		await service.reconcileAndVerify(widgetsConnection, widgetsTarget);

		const sql = process.executeSql.mock.calls[0][1];
		expect(sql).toContain(
			"'widgets.enforce_ai_consent_receipt_immutability()'"
		);
		expect(sql).toContain(
			'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA "widgets" FROM PUBLIC, "winwidget_widgets_runtime", "winwidget_widgets_backup";'
		);
		expect(sql).not.toContain(
			'GRANT EXECUTE ON FUNCTION "widgets"."enforce_ai_consent_receipt_immutability"() TO "winwidget_widgets_runtime";'
		);
	});

	it('rejects an unsafe routine signature before invoking PostgreSQL', async () => {
		const { process, service } = setup();
		const unsafeTarget: DatabaseRestoreTargetConfiguration = {
			...platformTarget,
			acl: {
				...platformTarget.acl,
				runtimeRoutines: ['unexpected(integer)']
			}
		};

		await expect(
			service.reconcileAndVerify(connection, unsafeTarget)
		).rejects.toThrow('Unsafe PostgreSQL routine signature');
		expect(process.executeSql).not.toHaveBeenCalled();
	});
});
