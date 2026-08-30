import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { DatabaseRestoreProcessService } from './database-restore-process.service';
import {
	DatabaseRestoreConnection,
	DatabaseRestoreTargetConfiguration
} from './database-restore-target-registry.service';

const spawnMock = jest.fn();
jest.mock('node:child_process', () => ({
	spawn: (...args: unknown[]) => spawnMock(...args)
}));

const target: DatabaseRestoreTargetConfiguration = {
	environmentPrefix: 'OPERATIONS',
	database: 'winwidget_operations',
	schema: 'operations',
	adminRole: 'winwidget_operations_admin',
	migrationRole: 'winwidget_operations_migration',
	runtimeRole: 'winwidget_operations_runtime',
	backupRole: 'winwidget_operations_backup'
};
const connection: DatabaseRestoreConnection = {
	host: '127.0.0.1',
	port: 55441,
	user: target.adminRole,
	database: target.database,
	password: 'test-restore-password'
};
const connectionArguments = [
	'--host',
	'127.0.0.1',
	'--port',
	'55441',
	'--username',
	'winwidget_operations_admin',
	'--dbname',
	'winwidget_operations'
];

interface ProcessInternals {
	command(
		command: 'pg_restore' | 'psql',
		args: string[],
		password: string | null
	): Promise<{ stdout: string }>;
	connectionArguments(value: DatabaseRestoreConnection): string[];
	environment(password: string | null): NodeJS.ProcessEnv;
	identifier(value: string): string;
	aclSql(value: DatabaseRestoreTargetConfiguration): string;
}

const childProcess = () => {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough | null;
		stderr: PassThrough | null;
		kill: jest.Mock;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = jest.fn();
	return child;
};

describe('DatabaseRestoreProcessService command plans', () => {
	let service: DatabaseRestoreProcessService;
	let command: jest.SpyInstance;

	beforeEach(() => {
		service = new DatabaseRestoreProcessService();
		command = jest
			.spyOn(service as unknown as ProcessInternals, 'command')
			.mockResolvedValue({ stdout: '' });
	});

	afterEach(() => jest.restoreAllMocks());

	it('lists the custom dump with the existing password environment boundary', async () => {
		command.mockResolvedValue({ stdout: 'TOC' });

		await expect(
			service.listDump('/restore/source.dump', connection.password)
		).resolves.toBe('TOC');
		expect(command).toHaveBeenCalledWith(
			'pg_restore',
			['--list', '/restore/source.dump'],
			connection.password
		);
	});

	it('uses the exact destructive schema recreation command', async () => {
		await service.recreateSchema(connection, target);

		expect(command).toHaveBeenCalledWith(
			'psql',
			[
				'--no-password',
				'--set',
				'ON_ERROR_STOP=1',
				...connectionArguments,
				'--command',
				'DROP SCHEMA "operations" CASCADE; CREATE SCHEMA "operations" AUTHORIZATION "winwidget_operations_migration";'
			],
			connection.password
		);
	});

	it('uses the exact pg_restore command', async () => {
		await service.restoreSchema(
			connection,
			target,
			'/restore/source.dump'
		);

		expect(command).toHaveBeenCalledWith(
			'pg_restore',
			[
				'--exit-on-error',
				'--no-owner',
				'--no-privileges',
				'--role',
				'winwidget_operations_migration',
				'--schema',
				'operations',
				...connectionArguments,
				'/restore/source.dump'
			],
			connection.password
		);
	});

	it('applies the exact existing ACL plan', async () => {
		await service.applyAcl(connection, target);

		expect(command).toHaveBeenCalledWith(
			'psql',
			[
				'--no-password',
				'--set',
				'ON_ERROR_STOP=1',
				...connectionArguments,
				'--command',
				[
					'GRANT USAGE ON SCHEMA "operations" TO "winwidget_operations_runtime", "winwidget_operations_backup";',
					'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "operations" TO "winwidget_operations_runtime";',
					'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "operations" TO "winwidget_operations_runtime";',
					'GRANT SELECT ON ALL TABLES IN SCHEMA "operations" TO "winwidget_operations_backup";',
					'ALTER DEFAULT PRIVILEGES FOR ROLE "winwidget_operations_migration" IN SCHEMA "operations" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "winwidget_operations_runtime";',
					'ALTER DEFAULT PRIVILEGES FOR ROLE "winwidget_operations_migration" IN SCHEMA "operations" GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "winwidget_operations_runtime";',
					'ALTER DEFAULT PRIVILEGES FOR ROLE "winwidget_operations_migration" IN SCHEMA "operations" GRANT SELECT ON TABLES TO "winwidget_operations_backup";'
				].join(' ')
			],
			connection.password
		);
	});

	it.each([
		['ok\n', true],
		['missing\n', false]
	])(
		'maps the exact ledger query output %p to %p',
		async (stdout, expected) => {
			command.mockResolvedValue({ stdout });

			await expect(
				service.verifyMigrationLedger(connection, target)
			).resolves.toBe(expected);
			expect(command).toHaveBeenCalledWith(
				'psql',
				[
					'--no-password',
					'--tuples-only',
					'--no-align',
					...connectionArguments,
					'--command',
					"SELECT CASE WHEN to_regclass('operations._prisma_migrations') IS NOT NULL THEN 'ok' ELSE 'missing' END;"
				],
				connection.password
			);
		}
	);

	it('keeps connection arguments, minimal environment, and identifier validation exact', () => {
		const internal = service as unknown as ProcessInternals;

		expect(internal.connectionArguments(connection)).toEqual(
			connectionArguments
		);
		expect(internal.environment(null)).toEqual({
			PATH: process.env.PATH,
			LANG: 'C',
			LC_ALL: 'C'
		});
		expect(internal.environment(connection.password)).toEqual({
			PATH: process.env.PATH,
			LANG: 'C',
			LC_ALL: 'C',
			PGPASSWORD: connection.password
		});
		expect(internal.identifier('safe_name')).toBe('"safe_name"');
		expect(() => internal.identifier('unsafe-name')).toThrow(
			'Unsafe PostgreSQL identifier'
		);
	});
});

describe('DatabaseRestoreProcessService process boundary', () => {
	beforeEach(() => spawnMock.mockReset());

	it('captures successful stdout and uses the exact minimal command environment', async () => {
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const result = new DatabaseRestoreProcessService().listDump(
			'/restore/source.dump',
			connection.password
		);
		child.stdout?.write('TOC output');
		child.emit('close', 0);

		await expect(result).resolves.toBe('TOC output');
		expect(spawnMock).toHaveBeenCalledWith(
			'pg_restore',
			['--list', '/restore/source.dump'],
			{
				env: {
					PATH: process.env.PATH,
					LANG: 'C',
					LC_ALL: 'C',
					PGPASSWORD: connection.password
				},
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
	});

	it('keeps only the last 2000000 bytes of command stdout', async () => {
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const result = new DatabaseRestoreProcessService().listDump(
			'/restore/source.dump',
			connection.password
		);
		child.stdout?.write(`prefix${'x'.repeat(2_000_000)}`);
		child.emit('close', 0);

		await expect(result).resolves.toBe('x'.repeat(2_000_000));
	});

	it('writes the safety dump exclusively with mode 0600 and the exact pg_dump command', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'restore-safety-'));
		const path = join(directory, 'job.dump.safety');
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const service = new DatabaseRestoreProcessService();

		try {
			const result = service.createSafetyCopy(
				connection,
				'operations',
				path
			);
			child.stdout?.end(Buffer.from('PGDMP-safety'));
			child.emit('close', 0);
			await result;

			expect(spawnMock).toHaveBeenCalledWith(
				'pg_dump',
				[
					'--format=custom',
					'--no-owner',
					'--no-privileges',
					'--no-password',
					'--schema',
					'operations',
					...connectionArguments
				],
				{
					env: {
						PATH: process.env.PATH,
						LANG: 'C',
						LC_ALL: 'C',
						PGPASSWORD: connection.password
					},
					stdio: ['ignore', 'pipe', 'pipe']
				}
			);
			await expect(readFile(path, 'utf8')).resolves.toBe('PGDMP-safety');
			expect((await stat(path)).mode & 0o777).toBe(0o600);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('rejects a safety dump without stdout using the stable error', async () => {
		const child = childProcess();
		child.stdout = null;
		spawnMock.mockReturnValue(child);

		await expect(
			new DatabaseRestoreProcessService().createSafetyCopy(
				connection,
				'operations',
				'/unused/safety.dump'
			)
		).rejects.toThrow('Safety backup stdout is unavailable');
	});

	it('captures stdout and redacts the password from a non-zero command error', async () => {
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const service = new DatabaseRestoreProcessService();
		const result = service.listDump(
			'/restore/source.dump',
			connection.password
		);
		child.stdout?.write('toc output');
		child.stderr?.write(`failure ${connection.password}`);
		child.emit('close', 2);

		await expect(result).rejects.toThrow('failure [REDACTED]');
	});

	it('uses the stable fallback for a non-zero command without stderr', async () => {
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const result = new DatabaseRestoreProcessService().listDump(
			'/restore/source.dump',
			connection.password
		);
		child.emit('close', 3);

		await expect(result).rejects.toThrow(
			'Database restore command exited 3'
		);
	});

	it('propagates a spawn error', async () => {
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const result = new DatabaseRestoreProcessService().listDump(
			'/restore/source.dump',
			connection.password
		);
		child.emit('error', new Error('spawn failed'));

		await expect(result).rejects.toThrow('spawn failed');
	});

	it('keeps the 30 minute timeout and sends SIGTERM', async () => {
		jest.useFakeTimers();
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const result = new DatabaseRestoreProcessService().listDump(
			'/restore/source.dump',
			connection.password
		);

		jest.advanceTimersByTime(30 * 60_000);
		await expect(result).rejects.toThrow(
			'Database restore command timed out'
		);
		expect(child.kill).toHaveBeenCalledWith('SIGTERM');
		jest.useRealTimers();
	});
});
