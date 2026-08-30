import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
	DatabaseRestoreConnection,
	DatabaseRestoreTargetConfiguration
} from './database-restore-target-registry.service';

const DATABASE_COMMAND_TIMEOUT_MS = 30 * 60_000;
const DATABASE_COMMAND_TERMINATION_GRACE_MS = 10_000;
const DATABASE_COMMAND_STDOUT_TAIL_CHARACTERS = 2_000_000;
const RESTORE_COMMAND_CAPTURE_MAX_BYTES = 2_000_000;
const RESTORE_TOC_OVERFLOW_ERROR =
	'Restore dump table of contents exceeds the safe size limit';
const RESTORE_LEDGER_OVERFLOW_ERROR =
	'Restore migration ledger exceeds the safe size limit';

@Injectable()
export class DatabaseRestoreProcessService {
	async listDump(
		path: string,
		password: string,
		signal?: AbortSignal
	): Promise<string> {
		signal?.throwIfAborted();
		return (
			await this.command('pg_restore', ['--list', path], password, {
				stdoutOverflowError: RESTORE_TOC_OVERFLOW_ERROR,
				signal
			})
		).stdout;
	}

	async createSafetyCopy(
		connection: DatabaseRestoreConnection,
		schema: string,
		path: string,
		signal?: AbortSignal
	): Promise<void> {
		signal?.throwIfAborted();
		const child = spawn(
			'pg_dump',
			[
				'--format=custom',
				'--no-owner',
				'--no-privileges',
				'--no-password',
				'--schema',
				schema,
				...this.connectionArguments(connection)
			],
			{
				env: this.environment(connection.password),
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		if (!child.stdout) {
			const error = new Error('Safety backup stdout is unavailable');
			await this.wait(
				child,
				connection.password,
				undefined,
				error,
				signal
			);
			throw error;
		}
		const outputSignal = signal
			? AbortSignal.any([
					signal,
					AbortSignal.timeout(DATABASE_COMMAND_TIMEOUT_MS)
				])
			: AbortSignal.timeout(DATABASE_COMMAND_TIMEOUT_MS);
		const output = pipeline(
			child.stdout,
			createWriteStream(path, { flags: 'wx', mode: 0o600 }),
			{ signal: outputSignal }
		);
		await this.wait(child, connection.password, output, undefined, signal);
		await chmod(path, 0o600);
		await this.durablySyncArtifact(path, signal);
	}

	async recreateSchema(
		connection: DatabaseRestoreConnection,
		target: DatabaseRestoreTargetConfiguration,
		signal?: AbortSignal
	): Promise<void> {
		signal?.throwIfAborted();
		await this.command(
			'psql',
			[
				'--no-password',
				'--set',
				'ON_ERROR_STOP=1',
				...this.connectionArguments(connection),
				'--command',
				`DROP SCHEMA ${this.identifier(target.schema)} CASCADE; CREATE SCHEMA ${this.identifier(target.schema)} AUTHORIZATION ${this.identifier(target.migrationRole)};`
			],
			connection.password,
			{ signal }
		);
	}

	async restoreSchema(
		connection: DatabaseRestoreConnection,
		target: DatabaseRestoreTargetConfiguration,
		source: string,
		signal?: AbortSignal
	): Promise<void> {
		signal?.throwIfAborted();
		await this.command(
			'pg_restore',
			[
				'--exit-on-error',
				'--no-owner',
				'--no-privileges',
				'--role',
				target.migrationRole,
				'--schema',
				target.schema,
				...this.connectionArguments(connection),
				source
			],
			connection.password,
			{ signal }
		);
	}

	async executeSql(
		connection: DatabaseRestoreConnection,
		sql: string,
		signal?: AbortSignal
	): Promise<void> {
		signal?.throwIfAborted();
		await this.command(
			'psql',
			[
				'--no-password',
				'--set',
				'ON_ERROR_STOP=1',
				...this.connectionArguments(connection),
				'--command',
				sql
			],
			connection.password,
			{ signal }
		);
	}

	async extractMigrationLedger(
		source: string,
		target: DatabaseRestoreTargetConfiguration,
		signal?: AbortSignal
	): Promise<string> {
		signal?.throwIfAborted();
		return (
			await this.command(
				'pg_restore',
				[
					'--data-only',
					'--strict-names',
					'--schema',
					target.schema,
					'--table',
					'_prisma_migrations',
					'--file',
					'-',
					source
				],
				null,
				{
					stdoutOverflowError: RESTORE_LEDGER_OVERFLOW_ERROR,
					signal
				}
			)
		).stdout;
	}

	async readMigrationLedger(
		connection: DatabaseRestoreConnection,
		target: DatabaseRestoreTargetConfiguration,
		signal?: AbortSignal
	): Promise<string> {
		signal?.throwIfAborted();
		return (
			await this.command(
				'psql',
				[
					'--no-password',
					'--set',
					'ON_ERROR_STOP=1',
					'--tuples-only',
					'--no-align',
					...this.connectionArguments(connection),
					'--command',
					`SELECT COALESCE(json_agg(json_build_object('migrationName', migration_name, 'checksum', checksum, 'finished', finished_at IS NOT NULL, 'rolledBack', rolled_back_at IS NOT NULL, 'appliedStepsCount', applied_steps_count) ORDER BY migration_name, started_at, id)::text, '[]') FROM ${this.identifier(target.schema)}."_prisma_migrations";`
				],
				connection.password,
				{
					stdoutOverflowError: RESTORE_LEDGER_OVERFLOW_ERROR,
					signal
				}
			)
		).stdout;
	}

	private async command(
		command: 'pg_restore' | 'psql',
		args: string[],
		password: string | null,
		options: {
			stdoutOverflowError?: string;
			signal?: AbortSignal;
		} = {}
	): Promise<{ stdout: string }> {
		options.signal?.throwIfAborted();
		const child = spawn(command, args, {
			env: this.environment(password),
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		let stdoutBytes = 0;
		let stdoutOverflow = false;
		const stdoutChunks: Buffer[] = [];
		child.stdout?.on('data', chunk => {
			const buffer = Buffer.from(chunk);
			if (!options.stdoutOverflowError) {
				stdout = `${stdout}${buffer.toString('utf8')}`.slice(
					-DATABASE_COMMAND_STDOUT_TAIL_CHARACTERS
				);
				return;
			}
			if (
				stdoutOverflow ||
				stdoutBytes + buffer.length > RESTORE_COMMAND_CAPTURE_MAX_BYTES
			) {
				stdoutOverflow = true;
				stdoutChunks.length = 0;
				return;
			}
			stdoutBytes += buffer.length;
			stdoutChunks.push(buffer);
		});
		await this.wait(child, password, undefined, undefined, options.signal);
		if (stdoutOverflow) {
			throw new Error(options.stdoutOverflowError);
		}
		if (options.stdoutOverflowError) {
			stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
		}
		return { stdout };
	}

	private connectionArguments(
		connection: DatabaseRestoreConnection
	): string[] {
		return [
			'--host',
			connection.host,
			'--port',
			String(connection.port),
			'--username',
			connection.user,
			'--dbname',
			connection.database
		];
	}

	private async durablySyncArtifact(
		path: string,
		signal?: AbortSignal
	): Promise<void> {
		signal?.throwIfAborted();
		await this.syncPath(path);
		signal?.throwIfAborted();
		await this.syncPath(dirname(path));
		signal?.throwIfAborted();
	}

	private async syncPath(path: string): Promise<void> {
		const handle = await open(path, 'r');
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private wait(
		child: ReturnType<typeof spawn>,
		password: string | null,
		output?: Promise<void>,
		initialError?: Error,
		signal?: AbortSignal
	): Promise<void> {
		return new Promise((resolve, reject) => {
			let stderr = '';
			let closed = false;
			let exited = false;
			let stopRequested = false;
			let primaryError: Error | null = null;
			let outputError: Error | null = null;
			let terminationTimeout: NodeJS.Timeout | null = null;
			const errorValue = (error: unknown) =>
				error instanceof Error ? error : new Error(String(error));
			const clearTimers = () => {
				clearTimeout(timeout);
				if (terminationTimeout) clearTimeout(terminationTimeout);
				signal?.removeEventListener('abort', handleAbort);
			};
			const sendSignal = (signal: NodeJS.Signals) => {
				try {
					child.kill(signal);
				} catch (error) {
					primaryError ??= errorValue(error);
				}
			};
			function requestStop(error: Error) {
				primaryError ??= error;
				if (stopRequested || closed) return;
				stopRequested = true;
				clearTimeout(timeout);
				if (!exited) sendSignal('SIGTERM');
				if (closed || exited) return;
				terminationTimeout = setTimeout(() => {
					if (!closed && !exited) sendSignal('SIGKILL');
				}, DATABASE_COMMAND_TERMINATION_GRACE_MS);
				terminationTimeout.unref();
			}
			const handleAbort = () =>
				requestStop(
					errorValue(
						signal?.reason ?? new Error('Database restore was aborted')
					)
				);
			const timeout = setTimeout(
				() => requestStop(new Error('Database restore command timed out')),
				DATABASE_COMMAND_TIMEOUT_MS
			);
			timeout.unref();
			child.stderr?.on('data', chunk => {
				stderr = `${stderr}${Buffer.from(chunk).toString('utf8')}`.slice(
					-2_000
				);
			});
			child.once('error', error => {
				primaryError ??= error;
			});
			child.once('exit', () => {
				exited = true;
			});
			child.once('close', code => {
				closed = true;
				exited = true;
				clearTimers();
				void (async () => {
					if (output) {
						const [settledOutput] = await Promise.allSettled([output]);
						if (settledOutput.status === 'rejected') {
							outputError ??= errorValue(settledOutput.reason);
						}
					}
					if (primaryError) throw primaryError;
					if (code !== 0) {
						throw new Error(
							this.redact(stderr, password).trim() ||
								`Database restore command exited ${code}`
						);
					}
					if (outputError) throw outputError;
				})().then(resolve, reject);
			});
			if (output) {
				void output.catch(error => {
					outputError ??= errorValue(error);
					if (!closed && !exited) requestStop(outputError);
				});
			}
			if (signal) {
				signal.addEventListener('abort', handleAbort, { once: true });
				if (signal.aborted) handleAbort();
			}
			if (initialError) requestStop(initialError);
		});
	}

	private identifier(value: string): string {
		if (!/^[a-z_][a-z0-9_]*$/.test(value))
			throw new Error('Unsafe PostgreSQL identifier');
		return `"${value}"`;
	}

	private environment(password: string | null): NodeJS.ProcessEnv {
		const environment = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' };
		return password
			? { ...environment, PGPASSWORD: password }
			: environment;
	}

	private redact(value: string, secret: string | null): string {
		return secret ? value.split(secret).join('[REDACTED]') : value;
	}
}
