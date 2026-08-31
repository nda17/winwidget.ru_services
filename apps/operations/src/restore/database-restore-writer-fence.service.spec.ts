import { DatabaseRestoreProcessService } from './database-restore-process.service';
import {
	DatabaseRestoreConnection,
	DatabaseRestoreTargetConfiguration
} from './database-restore-target-registry.service';
import { DatabaseRestoreWriterFenceService } from './database-restore-writer-fence.service';

const target: DatabaseRestoreTargetConfiguration = {
	environmentPrefix: 'REPORTING',
	database: 'winwidget_reporting',
	schema: 'reporting',
	adminRole: 'winwidget_reporting_admin',
	migrationRole: 'winwidget_reporting_migration',
	runtimeRole: 'winwidget_reporting_runtime',
	backupRole: 'winwidget_reporting_backup',
	acl: { profile: 'standard', routines: [], runtimeRoutines: [] }
};
const connection: DatabaseRestoreConnection = {
	host: '127.0.0.1',
	port: 55432,
	user: target.adminRole,
	database: target.database,
	password: 'test-password'
};
const operationId = '11111111-1111-4111-8111-111111111111';
const generationMarker = 'a'.repeat(64);

describe('DatabaseRestoreWriterFenceService', () => {
	it('keeps the same operation marker stable and rejects mixed initial boundaries before replacing it', async () => {
		const executeSql = jest.fn().mockResolvedValue(undefined);
		const service = new DatabaseRestoreWriterFenceService({
			executeSql
		} as unknown as DatabaseRestoreProcessService);

		const first = await service.apply(connection, target, operationId);
		const takeover = await service.apply(connection, target, operationId);

		expect(takeover.evidenceSha256).toBe(first.evidenceSha256);
		const takeoverSql = executeSql.mock.calls[3][1] as string;
		expect(takeoverSql).toContain(
			'Database restore writer apply boundary is mixed or unknown'
		);
		expect(takeoverSql).toContain('login_count NOT IN (0, 3)');
		expect(takeoverSql).toContain('IF login_count = 0 THEN');
		expect(takeoverSql).toContain(
			`winwidget.restore_generation=${first.evidenceSha256}`
		);
		expect(takeoverSql).toContain(
			`ALTER ROLE "${target.adminRole}" SET "winwidget.restore_generation" TO '${first.evidenceSha256}';`
		);
	});

	it('reapplies only the exact generation without overwriting a newer marker', async () => {
		const executeSql = jest.fn().mockResolvedValue(undefined);
		const service = new DatabaseRestoreWriterFenceService({
			executeSql
		} as unknown as DatabaseRestoreProcessService);

		const evidence = await service.reapply(
			connection,
			target,
			operationId
		);

		expect(executeSql).toHaveBeenCalledTimes(3);
		const reapplySql = executeSql.mock.calls[0][1] as string;
		expect(reapplySql).toContain('pg_advisory_xact_lock');
		expect(reapplySql).toContain(
			`winwidget.restore_generation=${evidence.evidenceSha256}`
		);
		expect(reapplySql).toContain(
			'Database restore writer fence generation marker drifted'
		);
		expect(reapplySql).toContain(
			'Database restore writer reapply boundary is mixed or unknown'
		);
		expect(reapplySql).toContain('login_count NOT IN (0, 3)');
		expect(reapplySql).not.toContain('SET "winwidget.restore_generation"');
		for (const role of [
			target.runtimeRole,
			target.migrationRole,
			target.backupRole
		]) {
			expect(reapplySql).toContain(`ALTER ROLE "${role}" NOLOGIN;`);
		}
	});

	it('sets the exact three target roles NOLOGIN before draining and proving zero writers', async () => {
		const executeSql = jest.fn().mockResolvedValue(undefined);
		const service = new DatabaseRestoreWriterFenceService({
			executeSql
		} as unknown as DatabaseRestoreProcessService);

		await expect(
			service.apply(connection, target, operationId)
		).resolves.toEqual(
			expect.objectContaining({
				roles: [
					target.runtimeRole,
					target.migrationRole,
					target.backupRole
				],
				evidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/)
			})
		);
		expect(executeSql).toHaveBeenCalledTimes(3);
		const fenceSql = executeSql.mock.calls[0][1] as string;
		const drainSql = executeSql.mock.calls[1][1] as string;
		const verifySql = executeSql.mock.calls[2][1] as string;
		for (const role of [
			target.runtimeRole,
			target.migrationRole,
			target.backupRole
		]) {
			expect(fenceSql).toContain(`ALTER ROLE "${role}" NOLOGIN;`);
			expect(drainSql).toContain(role);
			expect(verifySql).toContain(role);
		}
		expect(fenceSql).not.toContain(' LOGIN;');
		expect(fenceSql).toContain('pg_advisory_xact_lock');
		expect(fenceSql).toContain('winwidget.restore_generation');
		expect(fenceSql).toContain("SET LOCAL lock_timeout = '5000ms'");
		expect(fenceSql).toContain("SET LOCAL statement_timeout = '15000ms'");
		expect(drainSql).toContain('pg_terminate_backend(backend_pid, 5000)');
		expect(drainSql).not.toContain(
			'activity.datname = current_database()'
		);
		expect(verifySql).toContain('pg_prepared_xacts');
		expect(verifySql).toContain('unexpected admin session');
		expect(verifySql).not.toContain(
			'activity.datname = current_database()'
		);
		expect(verifySql).toContain('unexpected login superuser');
		expect(verifySql).toContain('pg_auth_members');
		expect(verifySql).toContain('protected role membership drifted');
	});

	it('never enables LOGIN until the fenced state and zero sessions are rechecked', async () => {
		const executeSql = jest.fn().mockResolvedValue(undefined);
		const service = new DatabaseRestoreWriterFenceService({
			executeSql
		} as unknown as DatabaseRestoreProcessService);

		await service.release(connection, target, generationMarker);

		expect(executeSql).toHaveBeenCalledTimes(1);
		const sql = executeSql.mock.calls[0][1] as string;
		const verifyIndex = sql.indexOf(
			'Database restore writer roles are not fully fenced'
		);
		const loginIndex = sql.indexOf(
			`ALTER ROLE "${target.runtimeRole}" LOGIN;`
		);
		expect(verifyIndex).toBeGreaterThanOrEqual(0);
		expect(loginIndex).toBeGreaterThan(verifyIndex);
		expect(sql).toContain(
			'Database restore writer roles were not fully unfenced'
		);
		expect(sql).toContain('trusted bootstrap admin boundary drifted');
		expect(sql).toContain('protected role membership drifted');
		expect(sql).toContain(
			`winwidget.restore_generation=${generationMarker}`
		);
	});

	it('does not attempt a release when fenced verification fails', async () => {
		const executeSql = jest
			.fn()
			.mockRejectedValue(new Error('writer session remains'));
		const service = new DatabaseRestoreWriterFenceService({
			executeSql
		} as unknown as DatabaseRestoreProcessService);

		await expect(
			service.release(connection, target, generationMarker)
		).rejects.toThrow('writer session remains');
		expect(executeSql).toHaveBeenCalledTimes(1);
	});
});
