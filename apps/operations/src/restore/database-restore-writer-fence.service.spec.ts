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
	it('keeps same-operation takeover idempotent and changes the marker for a new operation', async () => {
		const executeSql = jest.fn().mockResolvedValue(undefined);
		const service = new DatabaseRestoreWriterFenceService({
			executeSql
		} as unknown as DatabaseRestoreProcessService);

		const first = await service.apply(connection, target, operationId);
		const takeover = await service.apply(connection, target, operationId);
		const next = await service.apply(
			connection,
			target,
			'22222222-2222-4222-8222-222222222222'
		);

		expect(takeover.evidenceSha256).toBe(first.evidenceSha256);
		expect(next.evidenceSha256).not.toBe(first.evidenceSha256);
		const staleReleaseSql = await (async () => {
			executeSql.mockClear();
			await service.release(connection, target, first.evidenceSha256);
			return executeSql.mock.calls[0][1] as string;
		})();
		expect(staleReleaseSql).toContain(
			`winwidget.restore_generation=${first.evidenceSha256}`
		);
		expect(staleReleaseSql).not.toContain(
			`winwidget.restore_generation=${next.evidenceSha256}`
		);
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
