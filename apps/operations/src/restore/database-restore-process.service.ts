import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import {
	DatabaseRestoreConnection,
	DatabaseRestoreTargetConfiguration
} from './database-restore-target-registry.service';

@Injectable()
export class DatabaseRestoreProcessService {
	async listDump(path: string, password: string): Promise<string> {
		return (await this.command('pg_restore', ['--list', path], password))
			.stdout;
	}

	async createSafetyCopy(
		connection: DatabaseRestoreConnection,
		schema: string,
		path: string
	): Promise<void> {
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
		if (!child.stdout)
			throw new Error('Safety backup stdout is unavailable');
		await Promise.all([
			pipeline(
				child.stdout,
				createWriteStream(path, { flags: 'wx', mode: 0o600 })
			),
			this.wait(child, connection.password)
		]);
		await chmod(path, 0o600);
	}

	async recreateSchema(
		connection: DatabaseRestoreConnection,
		target: DatabaseRestoreTargetConfiguration
	): Promise<void> {
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
			connection.password
		);
	}

	async restoreSchema(
		connection: DatabaseRestoreConnection,
		target: DatabaseRestoreTargetConfiguration,
		source: string
	): Promise<void> {
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
			connection.password
		);
	}

	async applyAcl(
		connection: DatabaseRestoreConnection,
		target: DatabaseRestoreTargetConfiguration
	): Promise<void> {
		await this.command(
			'psql',
			[
				'--no-password',
				'--set',
				'ON_ERROR_STOP=1',
				...this.connectionArguments(connection),
				'--command',
				this.aclSql(target)
			],
			connection.password
		);
	}

	async verifyMigrationLedger(
		connection: DatabaseRestoreConnection,
		target: DatabaseRestoreTargetConfiguration
	): Promise<boolean> {
		const verification = await this.command(
			'psql',
			[
				'--no-password',
				'--tuples-only',
				'--no-align',
				...this.connectionArguments(connection),
				'--command',
				`SELECT CASE WHEN to_regclass('${target.schema}._prisma_migrations') IS NOT NULL THEN 'ok' ELSE 'missing' END;`
			],
			connection.password
		);
		return verification.stdout.trim() === 'ok';
	}

	private async command(
		command: 'pg_restore' | 'psql',
		args: string[],
		password: string | null
	): Promise<{ stdout: string }> {
		const child = spawn(command, args, {
			env: this.environment(password),
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		child.stdout?.on('data', chunk => {
			stdout = `${stdout}${Buffer.from(chunk).toString('utf8')}`.slice(
				-2_000_000
			);
		});
		await this.wait(child, password);
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

	private wait(
		child: ReturnType<typeof spawn>,
		password: string | null
	): Promise<void> {
		return new Promise((resolve, reject) => {
			let stderr = '';
			const timeout = setTimeout(() => {
				child.kill('SIGTERM');
				reject(new Error('Database restore command timed out'));
			}, 30 * 60_000);
			timeout.unref();
			child.stderr?.on('data', chunk => {
				stderr = `${stderr}${Buffer.from(chunk).toString('utf8')}`.slice(
					-2_000
				);
			});
			child.once('error', error => {
				clearTimeout(timeout);
				reject(error);
			});
			child.once('close', code => {
				clearTimeout(timeout);
				if (code === 0) resolve();
				else {
					reject(
						new Error(
							this.redact(stderr, password).trim() ||
								`Database restore command exited ${code}`
						)
					);
				}
			});
		});
	}

	private aclSql(target: DatabaseRestoreTargetConfiguration): string {
		const schema = this.identifier(target.schema);
		const runtime = this.identifier(target.runtimeRole);
		const backup = this.identifier(target.backupRole);
		const migration = this.identifier(target.migrationRole);
		return [
			`GRANT USAGE ON SCHEMA ${schema} TO ${runtime}, ${backup};`,
			`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${runtime};`,
			`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtime};`,
			`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${backup};`,
			`ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime};`,
			`ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${runtime};`,
			`ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} IN SCHEMA ${schema} GRANT SELECT ON TABLES TO ${backup};`
		].join(' ');
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
