import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
	chmod,
	mkdtemp,
	readdir,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { DatabaseBackupTarget } from '../scheduled-jobs/scheduled-jobs.types';
import {
	DATABASE_RESTORE_TARGETS,
	DatabaseRestoreTarget
} from '../restore/database-restore.contract';
import { DatabaseRestoreMigrationManifestService } from '../restore/database-restore-migration-manifest.service';
import {
	TelegramDocumentReceipt,
	TelegramTransportService
} from '../telegram/telegram-transport.service';
import {
	DatabaseBackupProvenanceService,
	SignedDatabaseBackupProvenance
} from './database-backup-provenance.service';

const MAX_FILE_SIZE = 49 * 1024 * 1024;
const URL_KEYS: Record<DatabaseBackupTarget, string> = {
	'notification-delivery': 'NOTIFICATION_DELIVERY_BACKUP_URL',
	campaigns: 'CAMPAIGNS_BACKUP_URL',
	reporting: 'REPORTING_BACKUP_URL',
	widgets: 'WIDGETS_BACKUP_URL',
	billing: 'BILLING_BACKUP_URL',
	identity: 'IDENTITY_BACKUP_URL',
	platform: 'PLATFORM_BACKUP_URL',
	support: 'SUPPORT_BACKUP_URL',
	operations: 'OPERATIONS_BACKUP_URL'
};
const DATABASE_TARGETS: Record<
	DatabaseBackupTarget,
	{ database: string; schema: string }
> = {
	'notification-delivery': {
		database: 'winwidget_notification_delivery',
		schema: 'notification_delivery'
	},
	campaigns: { database: 'winwidget_campaigns', schema: 'campaigns' },
	reporting: { database: 'winwidget_reporting', schema: 'reporting' },
	widgets: { database: 'winwidget_widgets', schema: 'widgets' },
	billing: { database: 'winwidget_billing', schema: 'billing' },
	identity: { database: 'winwidget_identity', schema: 'identity' },
	platform: { database: 'winwidget_platform', schema: 'platform' },
	support: { database: 'winwidget_support', schema: 'support' },
	operations: { database: 'winwidget_operations', schema: 'operations' }
};

export interface DatabaseBackupResult {
	target: DatabaseBackupTarget;
	databaseName: string;
	schema: string;
	fileName: string;
	fileSize: number;
	fileSha256: string;
	createdAt: string;
	telegramSent: true;
	telegramReceipt: TelegramDocumentReceipt;
	backupProvenance: SignedDatabaseBackupProvenance | null;
	provenanceTelegramReceipt: TelegramDocumentReceipt | null;
}

@Injectable()
export class DatabaseBackupService implements OnModuleInit {
	private readonly tempPrefix = 'winwidget-operations-backup-';

	constructor(
		private readonly config: ConfigService,
		private readonly telegram: TelegramTransportService,
		private readonly provenance: DatabaseBackupProvenanceService,
		private readonly manifests: DatabaseRestoreMigrationManifestService
	) {}

	async onModuleInit(): Promise<void> {
		const staleBefore = Date.now() - 24 * 60 * 60_000;
		const entries = await readdir(tmpdir(), { withFileTypes: true }).catch(
			() => []
		);
		await Promise.all(
			entries
				.filter(
					entry =>
						entry.isDirectory() && entry.name.startsWith(this.tempPrefix)
				)
				.map(async entry => {
					const path = join(tmpdir(), entry.name);
					const info = await stat(path).catch(() => null);
					if (info && info.mtimeMs < staleBefore) {
						await rm(path, { recursive: true, force: true });
					}
				})
		);
		if (process.env.OPERATIONS_PROCESS_ROLE === 'worker') {
			await this.provenance.assertSigningKey(
				this.requiredConfig('DATABASE_BACKUP_PROVENANCE_KEY_ID'),
				this.requiredConfig('DATABASE_BACKUP_PROVENANCE_PRIVATE_KEY_FILE')
			);
		}
	}

	async createAndSend(
		jobId: string,
		target: DatabaseBackupTarget,
		input: {
			chatId: string;
			messageThreadId: number;
			trigger: 'MANUAL' | 'SCHEDULED';
			backupJobCreatedAt: string;
		},
		signal: AbortSignal
	): Promise<DatabaseBackupResult> {
		const directory = await mkdtemp(join(tmpdir(), this.tempPrefix));
		await chmod(directory, 0o700);
		try {
			const database = this.database(target);
			const createdAt = new Date();
			const fileName = `winwidget-${target}-db-${createdAt
				.toISOString()
				.replace(/[:.]/g, '-')}.dump`;
			const filePath = join(directory, fileName);
			await this.pgDump(
				database.url,
				database.password,
				database.schema,
				filePath,
				signal
			);
			await this.run('pg_restore', ['--list', filePath], null, signal);
			const file = await stat(filePath);
			const fileSha256 = await this.sha256(filePath);
			const restoreTarget = DATABASE_RESTORE_TARGETS.includes(
				target as DatabaseRestoreTarget
			)
				? (target as DatabaseRestoreTarget)
				: null;
			let backupProvenance: SignedDatabaseBackupProvenance | null = null;
			let provenancePath: string | null = null;
			if (restoreTarget) {
				const keyId = this.requiredConfig(
					'DATABASE_BACKUP_PROVENANCE_KEY_ID'
				);
				const privateKeyFile = this.requiredConfig(
					'DATABASE_BACKUP_PROVENANCE_PRIVATE_KEY_FILE'
				);
				const revision = this.requiredRevision();
				const [pgDumpVersion, pgRestoreVersion] = await Promise.all([
					this.version('pg_dump', signal),
					this.version('pg_restore', signal)
				]);
				backupProvenance = await this.provenance.sign(
					{
						backupJobId: jobId,
						target: restoreTarget,
						databaseName: database.name,
						schema: database.schema,
						fileName,
						fileSize: file.size,
						artifactSha256: fileSha256,
						artifactCreatedAt: new Date().toISOString(),
						backupJobCreatedAt: input.backupJobCreatedAt,
						servicesSha: revision,
						migrationManifestSha: this.manifests.sha256(restoreTarget),
						imageRevision: revision,
						pgDumpVersion,
						pgRestoreVersion
					},
					keyId,
					privateKeyFile
				);
				provenancePath = `${filePath}.provenance.json`;
				await writeFile(
					provenancePath,
					`${JSON.stringify(backupProvenance, null, 2)}\n`,
					{ encoding: 'utf8', flag: 'wx', mode: 0o600 }
				);
			}
			const receipt = await this.telegram.sendDocument(
				input.chatId,
				filePath,
				[
					'<b>Backup базы данных WinWidget</b>',
					`База: <b>${target}</b>`,
					`Job ID: <code>${jobId}</code>`,
					`SHA-256: <code>${fileSha256}</code>`
				].join('\n'),
				{ messageThreadId: input.messageThreadId, signal }
			);
			const provenanceTelegramReceipt = provenancePath
				? await this.telegram.sendDocument(
						input.chatId,
						provenancePath,
						[
							'<b>Подпись backup базы данных WinWidget</b>',
							`База: <b>${target}</b>`,
							`Job ID: <code>${jobId}</code>`,
							`SHA-256: <code>${fileSha256}</code>`
						].join('\n'),
						{ messageThreadId: input.messageThreadId, signal }
					)
				: null;
			return {
				target,
				databaseName: database.name,
				schema: database.schema,
				fileName,
				fileSize: file.size,
				fileSha256,
				createdAt: createdAt.toISOString(),
				telegramSent: true,
				telegramReceipt: receipt,
				backupProvenance,
				provenanceTelegramReceipt
			};
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}

	private requiredConfig(key: string): string {
		const value = this.config.get<string>(key)?.trim();
		if (!value || ['change_me', 'XYZXYZXYZ'].includes(value)) {
			throw new Error(`${key} is not configured`);
		}
		return value;
	}

	private requiredRevision(): string {
		const revision = this.requiredConfig('APP_REVISION');
		if (!/^[0-9a-f]{40}$/.test(revision)) {
			throw new Error('APP_REVISION must be an exact services SHA');
		}
		return revision;
	}

	private async version(
		command: 'pg_dump' | 'pg_restore',
		signal: AbortSignal
	): Promise<string> {
		const child = spawn(command, ['--version'], {
			env: this.pgEnvironment(null),
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let output = '';
		child.stdout?.on('data', chunk => {
			output = `${output}${Buffer.from(chunk).toString('utf8')}`.slice(
				-512
			);
		});
		await this.waitForChild(child, null, signal);
		const version = output.trim();
		if (!version) throw new Error(`${command} version is unavailable`);
		return version;
	}

	private database(target: DatabaseBackupTarget) {
		const key = URL_KEYS[target];
		const expected = DATABASE_TARGETS[target];
		const raw = this.config.get<string>(key)?.trim();
		if (!raw || ['change_me', 'XYZXYZXYZ'].includes(raw)) {
			throw new Error(`${key} is not configured`);
		}
		const url = new URL(raw);
		if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
			throw new Error(`${key} must be a PostgreSQL URL`);
		}
		const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
		const schema = url.searchParams.get('schema')?.trim() || 'public';
		const password = url.password
			? decodeURIComponent(url.password)
			: null;
		if (!password || ['change_me', 'XYZXYZXYZ'].includes(password)) {
			throw new Error(`${key} is not configured securely`);
		}
		url.password = '';
		for (const parameter of [
			'schema',
			'connection_limit',
			'pool_timeout',
			'pgbouncer',
			'statement_cache_size'
		]) {
			url.searchParams.delete(parameter);
		}
		if (name !== expected.database || schema !== expected.schema) {
			throw new Error(`${key} has an unexpected database target`);
		}
		return { name, schema, password, url: url.toString() };
	}

	private async pgDump(
		url: string,
		password: string | null,
		schema: string,
		filePath: string,
		signal: AbortSignal
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
				url
			],
			{
				env: this.pgEnvironment(password),
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		if (!child.stdout) throw new Error('pg_dump stdout is unavailable');
		let bytes = 0;
		const limiter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				bytes += chunk.length;
				callback(
					bytes > MAX_FILE_SIZE
						? new Error('Backup exceeds Telegram 49 MB limit')
						: null,
					chunk
				);
			}
		});
		const output = pipeline(
			child.stdout,
			limiter,
			createWriteStream(filePath, { flags: 'wx', mode: 0o600 })
		);
		await this.waitForChild(child, password, signal, output);
	}

	private async run(
		command: 'pg_restore',
		args: string[],
		password: string | null,
		signal: AbortSignal
	): Promise<void> {
		const child = spawn(command, args, {
			env: this.pgEnvironment(password),
			stdio: ['ignore', 'ignore', 'pipe']
		});
		await this.waitForChild(child, password, signal);
	}

	private waitForChild(
		child: ReturnType<typeof spawn>,
		password: string | null,
		signal: AbortSignal,
		output?: Promise<void>
	): Promise<void> {
		return new Promise((resolve, reject) => {
			let stderr = '';
			let settled = false;
			const timeout = setTimeout(
				() => stop(new Error('PostgreSQL command timed out')),
				10 * 60_000
			);
			timeout.unref();
			const cleanup = () => {
				clearTimeout(timeout);
				signal.removeEventListener('abort', abort);
			};
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				error ? reject(error) : resolve();
			};
			const stop = (error: Error) => {
				child.kill('SIGTERM');
				finish(error);
			};
			const abort = () => stop(new Error('Backup lease was lost'));
			signal.addEventListener('abort', abort, { once: true });
			child.stderr?.on('data', chunk => {
				stderr = `${stderr}${Buffer.from(chunk).toString('utf8')}`.slice(
					-2_000
				);
			});
			child.once('error', error => finish(error));
			child.once('close', async code => {
				try {
					if (output) await output;
					if (code !== 0) {
						throw new Error(
							`PostgreSQL command failed: ${this.redact(stderr, password)
								.trim()
								.slice(0, 1_000)}`
						);
					}
					finish();
				} catch (error) {
					finish(
						error instanceof Error ? error : new Error(String(error))
					);
				}
			});
		});
	}

	private pgEnvironment(password: string | null): NodeJS.ProcessEnv {
		const environment = { ...process.env };
		for (const key of Object.values(URL_KEYS)) delete environment[key];
		delete environment.PGPASSWORD;
		if (password) environment.PGPASSWORD = password;
		return environment;
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
