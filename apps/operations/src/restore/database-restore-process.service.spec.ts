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
	backupRole: 'winwidget_operations_backup',
	acl: { profile: 'standard', routines: [], runtimeRoutines: [] }
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
		password: string | null,
		options?: { stdoutOverflowError?: string; signal?: AbortSignal }
	): Promise<{ stdout: string }>;
	connectionArguments(value: DatabaseRestoreConnection): string[];
	environment(password: string | null): NodeJS.ProcessEnv;
	identifier(value: string): string;
	syncPath(path: string): Promise<void>;
	wait(
		child: ReturnType<typeof spawnMock>,
		password: string | null,
		output?: Promise<void>,
		initialError?: Error,
		signal?: AbortSignal
	): Promise<void>;
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

const observeSettlement = (promise: Promise<unknown>) => {
	let state: 'pending' | 'resolved' | 'rejected' = 'pending';
	void promise.then(
		() => {
			state = 'resolved';
		},
		() => {
			state = 'rejected';
		}
	);
	return () => state;
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
			connection.password,
			{
				stdoutOverflowError:
					'Restore dump table of contents exceeds the safe size limit'
			}
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
			connection.password,
			{ signal: undefined }
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
			connection.password,
			{ signal: undefined }
		);
	});

	it('executes an exact SQL plan through the admin connection', async () => {
		await service.executeSql(connection, 'SELECT 1;');

		expect(command).toHaveBeenCalledWith(
			'psql',
			[
				'--no-password',
				'--set',
				'ON_ERROR_STOP=1',
				...connectionArguments,
				'--command',
				'SELECT 1;'
			],
			connection.password,
			{ signal: undefined }
		);
	});

	it('extracts only the Prisma migration ledger from the source without database credentials', async () => {
		command.mockResolvedValue({ stdout: 'COPY ledger' });

		await expect(
			service.extractMigrationLedger('/restore/source.dump', target)
		).resolves.toBe('COPY ledger');
		expect(command).toHaveBeenCalledWith(
			'pg_restore',
			[
				'--data-only',
				'--strict-names',
				'--schema',
				'operations',
				'--table',
				'_prisma_migrations',
				'--file',
				'-',
				'/restore/source.dump'
			],
			null,
			{
				stdoutOverflowError:
					'Restore migration ledger exceeds the safe size limit',
				signal: undefined
			}
		);
	});

	it('reads the complete restored Prisma ledger as bounded JSON', async () => {
		command.mockResolvedValue({ stdout: '[]\n' });

		await expect(
			service.readMigrationLedger(connection, target)
		).resolves.toBe('[]\n');
		expect(command).toHaveBeenCalledWith(
			'psql',
			[
				'--no-password',
				'--set',
				'ON_ERROR_STOP=1',
				'--tuples-only',
				'--no-align',
				...connectionArguments,
				'--command',
				`SELECT COALESCE(json_agg(json_build_object('migrationName', migration_name, 'checksum', checksum, 'finished', finished_at IS NOT NULL, 'rolledBack', rolled_back_at IS NOT NULL, 'appliedStepsCount', applied_steps_count) ORDER BY migration_name, started_at, id)::text, '[]') FROM "operations"."_prisma_migrations";`
			],
			connection.password,
			{
				stdoutOverflowError:
					'Restore migration ledger exceeds the safe size limit',
				signal: undefined
			}
		);
	});

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
	afterEach(() => jest.useRealTimers());

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

	it('terminates the child when the durable lease aborts execution', async () => {
		jest.useFakeTimers();
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const controller = new AbortController();
		const result = new DatabaseRestoreProcessService().recreateSchema(
			connection,
			target,
			controller.signal
		);

		controller.abort(new Error('restore lease lost'));
		expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
		await jest.advanceTimersByTimeAsync(10_000);
		expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
		child.emit('close', null, 'SIGKILL');
		await expect(result).rejects.toThrow('restore lease lost');
	});

	it('rejects an oversized TOC instead of silently dropping its schema entry', async () => {
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const result = new DatabaseRestoreProcessService().listDump(
			'/restore/source.dump',
			connection.password
		);
		child.stdout?.write(
			`3; 2615 2203 SCHEMA - operations owner\n${'x'.repeat(2_000_000)}`
		);
		child.emit('close', 0);

		await expect(result).rejects.toThrow(
			'Restore dump table of contents exceeds the safe size limit'
		);
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

	it('waits for output settlement after the child closes successfully', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'restore-safety-'));
		const path = join(directory, 'job.dump.safety');
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const service = new DatabaseRestoreProcessService();
		const syncPath = jest
			.spyOn(service as unknown as ProcessInternals, 'syncPath')
			.mockResolvedValue();
		const result = service.createSafetyCopy(
			connection,
			'operations',
			path
		);
		const settlement = observeSettlement(result);

		try {
			child.stdout?.write(Buffer.from('PGDMP-safety'));
			child.emit('close', 0);
			await Promise.resolve();
			expect(settlement()).toBe('pending');
			expect(syncPath).not.toHaveBeenCalled();

			child.stdout?.end();
			await expect(result).resolves.toBeUndefined();
			expect(syncPath.mock.calls).toEqual([[path], [directory]]);
			await expect(readFile(path, 'utf8')).resolves.toBe('PGDMP-safety');
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('aborts a pending safety pipeline after the child has already closed', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'restore-safety-'));
		const path = join(directory, 'job.dump.safety');
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const controller = new AbortController();
		const result = new DatabaseRestoreProcessService().createSafetyCopy(
			connection,
			'operations',
			path,
			controller.signal
		);
		const settlement = observeSettlement(result);

		try {
			child.stdout?.write(Buffer.from('partial safety'));
			child.emit('close', 0);
			await Promise.resolve();
			expect(settlement()).toBe('pending');

			controller.abort(new Error('restore lease lost after child close'));
			await expect(result).rejects.toThrow(/abort/i);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('terminates a safety dump after a pipeline error and waits for close', async () => {
		jest.useFakeTimers();
		const child = childProcess();
		const output = Promise.resolve().then(() => {
			throw new Error('safety pipeline failed');
		});
		const result = (
			new DatabaseRestoreProcessService() as unknown as ProcessInternals
		).wait(child as never, connection.password, output);
		const settlement = observeSettlement(result);

		await jest.advanceTimersByTimeAsync(0);
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
		expect(settlement()).toBe('pending');

		await jest.advanceTimersByTimeAsync(10_000);
		expect(child.kill).toHaveBeenCalledTimes(2);
		expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
		expect(settlement()).toBe('pending');

		child.emit('close', null, 'SIGKILL');
		await expect(result).rejects.toThrow('safety pipeline failed');
	});

	it('terminates a safety dump without stdout and waits for close', async () => {
		jest.useFakeTimers();
		const child = childProcess();
		child.stdout = null;
		spawnMock.mockReturnValue(child);
		const result = new DatabaseRestoreProcessService().createSafetyCopy(
			connection,
			'operations',
			'/unused/safety.dump'
		);
		const settlement = observeSettlement(result);

		expect(child.kill).toHaveBeenCalledWith('SIGTERM');
		expect(settlement()).toBe('pending');
		await jest.advanceTimersByTimeAsync(10_000);
		expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
		expect(settlement()).toBe('pending');

		child.emit('close', null, 'SIGKILL');
		await expect(result).rejects.toThrow(
			'Safety backup stdout is unavailable'
		);
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

	it('keeps the child error ahead of a secondary output failure', async () => {
		const child = childProcess();
		let rejectOutput!: (error: Error) => void;
		const output = new Promise<void>((_resolve, reject) => {
			rejectOutput = reject;
		});
		const result = (
			new DatabaseRestoreProcessService() as unknown as ProcessInternals
		).wait(child as never, connection.password, output);

		child.stderr?.write(`failure ${connection.password}`);
		child.emit('exit', 2);
		rejectOutput(new Error('secondary pipeline failure'));
		await Promise.resolve();
		child.emit('close', 2);

		await expect(result).rejects.toThrow('failure [REDACTED]');
		expect(child.kill).not.toHaveBeenCalled();
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

	it('propagates a spawn error only after the child close boundary', async () => {
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const result = new DatabaseRestoreProcessService().listDump(
			'/restore/source.dump',
			connection.password
		);
		const settlement = observeSettlement(result);
		child.emit('error', new Error('spawn failed'));
		await Promise.resolve();
		expect(settlement()).toBe('pending');
		child.emit('close', -1);

		await expect(result).rejects.toThrow('spawn failed');
	});

	it('keeps a timed out command pending until close after SIGTERM', async () => {
		jest.useFakeTimers();
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const result = new DatabaseRestoreProcessService().listDump(
			'/restore/source.dump',
			connection.password
		);
		const settlement = observeSettlement(result);

		await jest.advanceTimersByTimeAsync(30 * 60_000);
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(child.kill).toHaveBeenCalledWith('SIGTERM');
		expect(settlement()).toBe('pending');

		child.emit('close', null, 'SIGTERM');
		await expect(result).rejects.toThrow(
			'Database restore command timed out'
		);
		expect(child.kill).toHaveBeenCalledTimes(1);
	});

	it('escalates a timed out command to SIGKILL and still waits for close', async () => {
		jest.useFakeTimers();
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const result = new DatabaseRestoreProcessService().listDump(
			'/restore/source.dump',
			connection.password
		);
		const settlement = observeSettlement(result);

		await jest.advanceTimersByTimeAsync(30 * 60_000 + 10_000);
		expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
		expect(settlement()).toBe('pending');

		child.emit('close', null, 'SIGKILL');
		await expect(result).rejects.toThrow(
			'Database restore command timed out'
		);
	});

	it('does not escalate after the child closes during the grace period', async () => {
		jest.useFakeTimers();
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const result = new DatabaseRestoreProcessService().listDump(
			'/restore/source.dump',
			connection.password
		);

		await jest.advanceTimersByTimeAsync(30 * 60_000 + 9_999);
		child.emit('close', null, 'SIGTERM');
		await expect(result).rejects.toThrow(
			'Database restore command timed out'
		);
		await jest.advanceTimersByTimeAsync(1);
		expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
	});

	it('keeps timeout as the primary error even when the child exits zero', async () => {
		jest.useFakeTimers();
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const result = new DatabaseRestoreProcessService().listDump(
			'/restore/source.dump',
			connection.password
		);

		await jest.advanceTimersByTimeAsync(30 * 60_000);
		child.emit('close', 0);

		await expect(result).rejects.toThrow(
			'Database restore command timed out'
		);
	});

	it('clears termination timers after a normal close', async () => {
		jest.useFakeTimers();
		const child = childProcess();
		spawnMock.mockReturnValue(child);
		const result = new DatabaseRestoreProcessService().listDump(
			'/restore/source.dump',
			connection.password
		);

		child.emit('close', 0);
		await expect(result).resolves.toBe('');
		expect(jest.getTimerCount()).toBe(0);
		await jest.advanceTimersByTimeAsync(30 * 60_000 + 10_000);
		expect(child.kill).not.toHaveBeenCalled();
	});
});
