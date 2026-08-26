import { ConfigService } from '@nestjs/config';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseRestoreExecutorService } from './database-restore-executor.service';

const OPERATIONS_TARGET = {
	environmentPrefix: 'OPERATIONS',
	database: 'winwidget_operations',
	schema: 'operations',
	adminRole: 'winwidget_operations_admin',
	migrationRole: 'winwidget_operations_migration',
	runtimeRole: 'winwidget_operations_runtime',
	backupRole: 'winwidget_operations_backup'
};

interface ExecutorInternals {
	connection(target: typeof OPERATIONS_TARGET): Promise<{
		host: '127.0.0.1';
		port: number;
		user: string;
		database: string;
		password: string;
	}>;
	connectionArguments(connection: {
		host: '127.0.0.1';
		port: number;
		user: string;
		database: string;
	}): string[];
}

describe('DatabaseRestoreExecutorService privileged connection boundary', () => {
	it('builds the exact loopback target from admin user, port, and a secret file', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'operations-secret-'));
		const secretPath = join(directory, 'admin-password');
		await writeFile(secretPath, 'test-restore-password', { mode: 0o600 });
		const service = new DatabaseRestoreExecutorService(
			new ConfigService({
				OPERATIONS_POSTGRES_ADMIN_USER: 'winwidget_operations_admin',
				OPERATIONS_POSTGRES_PORT: '55441',
				DATABASE_RESTORE_OPERATIONS_ADMIN_PASSWORD_FILE: secretPath
			})
		);
		const internal = service as unknown as ExecutorInternals;

		try {
			const connection = await internal.connection(OPERATIONS_TARGET);
			expect(connection).toEqual({
				host: '127.0.0.1',
				port: 55441,
				user: 'winwidget_operations_admin',
				database: 'winwidget_operations',
				password: 'test-restore-password'
			});
			expect(internal.connectionArguments(connection)).toEqual([
				'--host',
				'127.0.0.1',
				'--port',
				'55441',
				'--username',
				'winwidget_operations_admin',
				'--dbname',
				'winwidget_operations'
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('requires a mounted password file instead of an inline credential', async () => {
		const service = new DatabaseRestoreExecutorService(
			new ConfigService({
				OPERATIONS_POSTGRES_ADMIN_USER: 'winwidget_operations_admin',
				OPERATIONS_POSTGRES_PORT: '55441'
			})
		);

		await expect(
			(service as unknown as ExecutorInternals).connection(
				OPERATIONS_TARGET
			)
		).rejects.toThrow('DATABASE_RESTORE_OPERATIONS_ADMIN_PASSWORD_FILE');
	});

	it('rejects a symlinked secret file', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'operations-secret-'));
		const targetPath = join(directory, 'target');
		const linkPath = join(directory, 'link');
		await writeFile(targetPath, 'test-restore-password', { mode: 0o600 });
		await symlink(targetPath, linkPath);
		const service = new DatabaseRestoreExecutorService(
			new ConfigService({
				OPERATIONS_POSTGRES_ADMIN_USER: 'winwidget_operations_admin',
				OPERATIONS_POSTGRES_PORT: '55441',
				DATABASE_RESTORE_OPERATIONS_ADMIN_PASSWORD_FILE: linkPath
			})
		);

		try {
			await expect(
				(service as unknown as ExecutorInternals).connection(
					OPERATIONS_TARGET
				)
			).rejects.toThrow('could not be read safely');
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
