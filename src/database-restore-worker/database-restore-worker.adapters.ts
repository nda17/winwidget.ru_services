import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
	chmod,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	statfs,
	unlink
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export type DatabaseRestorePostgresCommand =
	| 'pg_dump'
	| 'pg_restore'
	| 'psql';

export interface DatabaseRestoreCommandInput {
	command: DatabaseRestorePostgresCommand;
	args: readonly string[];
	password: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface DatabaseRestoreCommandResult {
	stdout: string;
}

export class DatabaseRestoreCommandError extends Error {
	constructor(
		readonly command: DatabaseRestorePostgresCommand,
		readonly exitCode: number | null,
		readonly stderr: string,
		message: string
	) {
		super(message);
		this.name = DatabaseRestoreCommandError.name;
	}
}

@Injectable()
export class DatabaseRestoreCommandRunner {
	async run(
		input: DatabaseRestoreCommandInput
	): Promise<DatabaseRestoreCommandResult> {
		this.assertNoSecretInArguments(input.args, input.password);
		if (input.signal?.aborted) {
			throw this.abortError(input.command, input.signal.reason);
		}

		return new Promise<DatabaseRestoreCommandResult>((resolve, reject) => {
			const child = spawn(input.command, [...input.args], {
				env: {
					PATH: process.env.PATH,
					LANG: 'C.UTF-8',
					LC_ALL: 'C.UTF-8',
					PGAPPNAME: 'winwidget-database-restore-worker',
					PGCONNECT_TIMEOUT: '10',
					PGPASSWORD: input.password
				},
				stdio: ['ignore', 'pipe', 'pipe']
			});
			let stdout = '';
			let stderr = '';
			let settled = false;
			let terminationError: Error | null = null;
			let forceKillTimer: NodeJS.Timeout | null = null;
			const timeout = setTimeout(() => {
				terminate(new Error(`${input.command} timed out`));
			}, input.timeoutMs);
			timeout.unref();

			const cleanup = () => {
				clearTimeout(timeout);
				if (forceKillTimer) clearTimeout(forceKillTimer);
				input.signal?.removeEventListener('abort', onAbort);
			};
			const finish = (
				error: Error | null,
				result?: DatabaseRestoreCommandResult
			) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error);
				else resolve(result!);
			};
			const terminate = (error: Error) => {
				if (settled || terminationError) return;
				terminationError = error;
				child.kill('SIGTERM');
				forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
				forceKillTimer.unref();
			};
			const onAbort = () =>
				terminate(this.abortError(input.command, input.signal?.reason));

			input.signal?.addEventListener('abort', onAbort, { once: true });
			if (input.signal?.aborted) onAbort();
			child.stdout?.on('data', chunk => {
				if (stdout.length < 1024 * 1024) {
					stdout += Buffer.from(chunk).toString('utf8');
				}
			});
			child.stderr?.on('data', chunk => {
				if (stderr.length < 64 * 1024) {
					stderr += Buffer.from(chunk).toString('utf8');
				}
			});
			child.once('error', error => finish(error));
			child.once('close', code => {
				if (terminationError) {
					finish(terminationError);
					return;
				}
				if (code !== 0) {
					finish(
						new DatabaseRestoreCommandError(
							input.command,
							code,
							stderr.trim(),
							`${input.command} failed with exit code ${code ?? 'unknown'}`
						)
					);
					return;
				}
				finish(null, { stdout });
			});
		});
	}

	private assertNoSecretInArguments(
		args: readonly string[],
		password: string
	): void {
		if (!password.trim()) {
			throw new Error('PostgreSQL admin password is empty');
		}
		if (
			args.some(
				argument =>
					argument.includes(password) ||
					/postgres(?:ql)?:\/\//i.test(argument)
			)
		) {
			throw new Error(
				'PostgreSQL credentials and connection URLs are forbidden in process arguments'
			);
		}
	}

	private abortError(
		command: DatabaseRestorePostgresCommand,
		reason: unknown
	): Error {
		if (reason instanceof Error) return reason;
		return new Error(`${command} was aborted`);
	}
}

export interface DatabaseRestoreFileInfo {
	size: number;
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

@Injectable()
export class DatabaseRestoreFileSystem {
	async ensurePrivateDirectory(path: string): Promise<void> {
		await mkdir(path, { recursive: true, mode: 0o700 });
		const info = await lstat(path);
		if (!info.isDirectory() || info.isSymbolicLink()) {
			throw new Error(`Unsafe database restore directory: ${path}`);
		}
		await chmod(path, 0o700);
	}

	async listFileNames(path: string): Promise<string[]> {
		const entries = await readdir(path, { withFileTypes: true });
		return entries
			.filter(entry => entry.isFile() && !entry.isSymbolicLink())
			.map(entry => entry.name)
			.sort();
	}

	async readUtf8File(path: string, maxBytes: number): Promise<string> {
		const info = await this.fileInfo(path);
		if (!info.isFile || info.isSymbolicLink || info.size > maxBytes) {
			throw new Error(
				`Unsafe or oversized database restore file: ${path}`
			);
		}
		return readFile(path, 'utf8');
	}

	async readSecretFile(path: string): Promise<string> {
		const raw = await this.readUtf8File(path, 4 * 1024);
		const secret = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
		if (
			!secret ||
			secret !== secret.trim() ||
			/[\r\n\u0000]/.test(secret)
		) {
			throw new Error('PostgreSQL admin password file is invalid');
		}
		return secret;
	}

	async fileInfo(path: string): Promise<DatabaseRestoreFileInfo> {
		const info = await lstat(path);
		return {
			size: info.size,
			isFile: info.isFile(),
			isDirectory: info.isDirectory(),
			isSymbolicLink: info.isSymbolicLink()
		};
	}

	async pathExists(path: string): Promise<boolean> {
		try {
			await lstat(path);
			return true;
		} catch (error) {
			if (this.isNodeError(error, 'ENOENT')) return false;
			throw error;
		}
	}

	async rename(source: string, destination: string): Promise<void> {
		await rename(source, destination);
		await this.syncDirectory(dirname(destination));
		if (dirname(source) !== dirname(destination)) {
			await this.syncDirectory(dirname(source));
		}
	}

	async removeFile(path: string): Promise<void> {
		try {
			await unlink(path);
			await this.syncDirectory(dirname(path));
		} catch (error) {
			if (!this.isNodeError(error, 'ENOENT')) throw error;
		}
	}

	async availableBytes(path: string): Promise<number> {
		const stats = await statfs(path);
		return stats.bavail * stats.bsize;
	}

	async calculateSha256(path: string): Promise<string> {
		const hash = createHash('sha256');
		for await (const chunk of createReadStream(path)) {
			hash.update(chunk);
		}
		return hash.digest('hex');
	}

	async readMigrationChecksums(
		migrationsDirectory: string
	): Promise<Array<{ migrationName: string; checksum: string }>> {
		const entries = await readdir(migrationsDirectory, {
			withFileTypes: true
		});
		const migrationNames = entries
			.filter(
				entry =>
					entry.isDirectory() &&
					!entry.isSymbolicLink() &&
					/^[0-9]{14}_[a-z0-9_]+$/.test(entry.name)
			)
			.map(entry => entry.name)
			.sort();
		if (!migrationNames.length) {
			throw new Error(
				`No Prisma migrations found in ${migrationsDirectory}`
			);
		}

		return Promise.all(
			migrationNames.map(async migrationName => ({
				migrationName,
				checksum: createHash('sha256')
					.update(
						await readFile(
							join(migrationsDirectory, migrationName, 'migration.sql')
						)
					)
					.digest('hex')
			}))
		);
	}

	async atomicWriteJson(path: string, value: unknown): Promise<void> {
		const temporaryPath = join(
			dirname(path),
			`.${basename(path)}.${randomUUID()}.tmp`
		);
		try {
			const handle = await open(temporaryPath, 'wx', 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporaryPath, path);
			await this.syncDirectory(dirname(path));
		} finally {
			await unlink(temporaryPath).catch(error => {
				if (!this.isNodeError(error, 'ENOENT')) throw error;
			});
		}
	}

	async atomicCreateJson(path: string, value: unknown): Promise<boolean> {
		const directory = dirname(path);
		const temporaryPath = join(
			directory,
			`.${basename(path)}.${randomUUID()}.tmp`
		);
		try {
			const handle = await open(temporaryPath, 'wx', 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
				await handle.sync();
			} finally {
				await handle.close();
			}

			try {
				await link(temporaryPath, path);
				return true;
			} catch (error) {
				if (this.isNodeError(error, 'EEXIST')) return false;
				throw error;
			}
		} finally {
			await unlink(temporaryPath).catch(error => {
				if (!this.isNodeError(error, 'ENOENT')) throw error;
			});
			await this.syncDirectory(directory);
		}
	}

	private async syncDirectory(path: string): Promise<void> {
		const handle = await open(path, 'r');
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	isNodeError(error: unknown, code: string): boolean {
		return (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === code
		);
	}
}
