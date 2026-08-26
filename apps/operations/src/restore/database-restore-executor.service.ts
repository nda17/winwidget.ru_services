import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, open, type FileHandle } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DatabaseRestoreTarget } from './database-restore.contract';

interface TargetConfiguration {
	environmentPrefix: string;
	database: string;
	schema: string;
	adminRole: string;
	migrationRole: string;
	runtimeRole: string;
	backupRole: string;
}

const TARGETS: Record<DatabaseRestoreTarget, TargetConfiguration> = {
	'notification-delivery': {
		environmentPrefix: 'NOTIFICATION_DELIVERY',
		database: 'winwidget_notification_delivery',
		schema: 'notification_delivery',
		adminRole: 'winwidget_notification_delivery_admin',
		migrationRole: 'winwidget_notification_delivery_migration',
		runtimeRole: 'winwidget_notification_delivery_runtime',
		backupRole: 'winwidget_notification_delivery_backup'
	},
	campaigns: {
		environmentPrefix: 'CAMPAIGNS',
		database: 'winwidget_campaigns',
		schema: 'campaigns',
		adminRole: 'winwidget_campaigns_admin',
		migrationRole: 'winwidget_campaigns_migration',
		runtimeRole: 'winwidget_campaigns_runtime',
		backupRole: 'winwidget_campaigns_backup'
	},
	reporting: {
		environmentPrefix: 'REPORTING',
		database: 'winwidget_reporting',
		schema: 'reporting',
		adminRole: 'winwidget_reporting_admin',
		migrationRole: 'winwidget_reporting_migration',
		runtimeRole: 'winwidget_reporting_runtime',
		backupRole: 'winwidget_reporting_backup'
	},
	widgets: {
		environmentPrefix: 'WIDGETS',
		database: 'winwidget_widgets',
		schema: 'widgets',
		adminRole: 'winwidget_widgets_admin',
		migrationRole: 'winwidget_widgets_migration',
		runtimeRole: 'winwidget_widgets_runtime',
		backupRole: 'winwidget_widgets_backup'
	},
	billing: {
		environmentPrefix: 'BILLING',
		database: 'winwidget_billing',
		schema: 'billing',
		adminRole: 'winwidget_billing_admin',
		migrationRole: 'winwidget_billing_migration',
		runtimeRole: 'winwidget_billing_runtime',
		backupRole: 'winwidget_billing_backup'
	},
	identity: {
		environmentPrefix: 'IDENTITY',
		database: 'winwidget_identity',
		schema: 'identity',
		adminRole: 'winwidget_identity_admin',
		migrationRole: 'winwidget_identity_migration',
		runtimeRole: 'winwidget_identity_runtime',
		backupRole: 'winwidget_identity_backup'
	},
	platform: {
		environmentPrefix: 'PLATFORM',
		database: 'winwidget_platform',
		schema: 'platform',
		adminRole: 'winwidget_platform_admin',
		migrationRole: 'winwidget_platform_migration',
		runtimeRole: 'winwidget_platform_runtime',
		backupRole: 'winwidget_platform_backup'
	},
	support: {
		environmentPrefix: 'SUPPORT',
		database: 'winwidget_support',
		schema: 'support',
		adminRole: 'winwidget_support_admin',
		migrationRole: 'winwidget_support_migration',
		runtimeRole: 'winwidget_support_runtime',
		backupRole: 'winwidget_support_backup'
	},
	operations: {
		environmentPrefix: 'OPERATIONS',
		database: 'winwidget_operations',
		schema: 'operations',
		adminRole: 'winwidget_operations_admin',
		migrationRole: 'winwidget_operations_migration',
		runtimeRole: 'winwidget_operations_runtime',
		backupRole: 'winwidget_operations_backup'
	}
};

@Injectable()
export class DatabaseRestoreExecutorService {
	constructor(private readonly config: ConfigService) {}

	async restore(input: {
		jobId: string;
		target: DatabaseRestoreTarget;
		source: string;
		expectedSha256: string;
	}) {
		const target = TARGETS[input.target];
		const connection = await this.connection(target);
		const actualSha256 = await this.sha256(input.source);
		if (actualSha256 !== input.expectedSha256) {
			throw new Error('Restore dump checksum mismatch');
		}
		const toc = await this.command(
			'pg_restore',
			['--list', input.source],
			connection.password
		);
		if (!toc.stdout.includes(` ${target.schema} `)) {
			throw new Error(
				'Restore dump does not contain the exact target schema'
			);
		}
		for (const other of Object.values(TARGETS)) {
			if (
				other.schema !== target.schema &&
				toc.stdout.includes(` SCHEMA - ${other.schema} `)
			) {
				throw new Error('Restore dump contains a foreign service schema');
			}
		}
		const safetyPath = `${input.source}.safety`;
		await this.dumpSafetyCopy(connection, target.schema, safetyPath);
		const safetySha256 = await this.sha256(safetyPath);
		try {
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
					input.source
				],
				connection.password
			);
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
			if (verification.stdout.trim() !== 'ok') {
				throw new Error('Restored database migration ledger is missing');
			}
			return {
				target: input.target,
				safetyBackupFileName:
					safetyPath.split('/').pop() || `${input.jobId}.safety`,
				safetyBackupSha256: safetySha256,
				restoredAt: new Date().toISOString(),
				verifiedAt: new Date().toISOString()
			};
		} catch (error) {
			throw new Error(
				`Database restore failed after safety backup ${safetySha256}: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	private async connection(target: TargetConfiguration) {
		const userKey = `${target.environmentPrefix}_POSTGRES_ADMIN_USER`;
		const portKey = `${target.environmentPrefix}_POSTGRES_PORT`;
		const passwordFileKey = `DATABASE_RESTORE_${target.environmentPrefix}_ADMIN_PASSWORD_FILE`;
		const user = this.config.get<string>(userKey)?.trim();
		if (user !== target.adminRole) {
			throw new Error(`${userKey} must be ${target.adminRole}`);
		}
		const rawPort = this.config.get<string>(portKey)?.trim();
		const port = rawPort ? Number(rawPort) : Number.NaN;
		if (!Number.isInteger(port) || port < 1 || port > 65_535) {
			throw new Error(`${portKey} must be an integer between 1 and 65535`);
		}
		const passwordFile = this.config.get<string>(passwordFileKey)?.trim();
		if (
			!passwordFile ||
			!isAbsolute(passwordFile) ||
			passwordFile === '/'
		) {
			throw new Error(`${passwordFileKey} must be an absolute file path`);
		}
		const password = await this.readSecret(passwordFile, passwordFileKey);
		return {
			host: '127.0.0.1' as const,
			port,
			user,
			database: target.database,
			password
		};
	}

	private async dumpSafetyCopy(
		connection: {
			host: '127.0.0.1';
			port: number;
			user: string;
			database: string;
			password: string;
		},
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

	private connectionArguments(connection: {
		host: '127.0.0.1';
		port: number;
		user: string;
		database: string;
	}): string[] {
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

	private async readSecret(path: string, key: string): Promise<string> {
		let handle: FileHandle | undefined;
		try {
			handle = await open(
				path,
				constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
			);
			const metadata = await handle.stat();
			if (
				!metadata.isFile() ||
				metadata.size < 1 ||
				metadata.size > 4_096
			) {
				throw new Error(`${key} does not reference a valid secret file`);
			}
			const raw = await handle.readFile({ encoding: 'utf8' });
			const password = raw.replace(/\r?\n$/, '');
			if (
				!password ||
				password !== password.trim() ||
				/[\u0000\r\n]/.test(password) ||
				['change_me', 'XYZXYZXYZ'].includes(password)
			) {
				throw new Error(`${key} contains an invalid secret`);
			}
			return password;
		} catch (error) {
			if (error instanceof Error && error.message.startsWith(key)) {
				throw error;
			}
			throw new Error(`${key} could not be read safely`);
		} finally {
			await handle?.close().catch(() => undefined);
		}
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

	private aclSql(target: TargetConfiguration): string {
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

	private async sha256(path: string): Promise<string> {
		const hash = createHash('sha256');
		for await (const chunk of createReadStream(path)) hash.update(chunk);
		return hash.digest('hex');
	}
}
