import {
	DatabaseBackupInput,
	DatabaseBackupResult,
	DatabaseBackupTarget
} from '@/maintenance/database-backup.types';
import { TelegramInfoTransportService } from '@/telegram-bot/telegram-info-transport.service';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export const DATABASE_BACKUP_MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024;
const PRISMA_ONLY_CONNECTION_PARAMS = [
	'connection_limit',
	'pool_timeout',
	'pgbouncer',
	'schema',
	'statement_cache_size'
] as const;
const DATABASE_URL_ENV_KEYS = [
	'DATABASE_BACKUP_URL',
	'DATABASE_MIGRATION_URL_PRODUCTION',
	'DATABASE_URL',
	'DATABASE_URL_DEVELOPMENT',
	'DATABASE_URL_PRODUCTION',
	'MAINTENANCE_DATABASE_URL_PRODUCTION',
	'NOTIFICATION_DELIVERY_BACKUP_URL',
	'NOTIFICATION_DELIVERY_DATABASE_URL',
	'NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION',
	'CAMPAIGNS_BACKUP_URL',
	'CAMPAIGNS_DATABASE_URL',
	'CAMPAIGNS_MIGRATION_DATABASE_URL',
	'REPORTING_BACKUP_URL',
	'REPORTING_DATABASE_URL',
	'REPORTING_MIGRATION_DATABASE_URL'
] as const;

const SERVICE_DATABASE_CONFIG = {
	'notification-delivery': {
		key: 'NOTIFICATION_DELIVERY_BACKUP_URL',
		label: 'Notification Delivery',
		filePrefix: 'winwidget-notification-delivery-db'
	},
	campaigns: {
		key: 'CAMPAIGNS_BACKUP_URL',
		label: 'Campaigns',
		filePrefix: 'winwidget-campaigns-db'
	},
	reporting: {
		key: 'REPORTING_BACKUP_URL',
		label: 'Reporting',
		filePrefix: 'winwidget-reporting-db'
	}
} as const;

interface PostgresConnection {
	target: DatabaseBackupTarget;
	label: string;
	databaseName: string;
	url: string;
	schema: string;
	password: string | null;
}

@Injectable()
export class DatabaseBackupService implements OnModuleInit {
	private readonly logger = new Logger(DatabaseBackupService.name);
	private readonly commandTimeoutMs = 10 * 60 * 1000;
	private readonly tempPrefix = 'winwidget-db-backup-';

	constructor(
		private readonly configService: ConfigService,
		private readonly telegram: TelegramInfoTransportService
	) {}

	async onModuleInit(): Promise<void> {
		await this.cleanupStaleDirectories();
	}

	async createAndSend(
		jobId: string,
		target: DatabaseBackupTarget,
		input: DatabaseBackupInput,
		signal: AbortSignal
	): Promise<DatabaseBackupResult> {
		this.assertInput(input);
		const directory = await mkdtemp(join(tmpdir(), this.tempPrefix));

		try {
			await chmod(directory, 0o700);
			const createdAt = new Date();
			const timestamp = createdAt.toISOString().replace(/[:.]/g, '-');
			const database = this.getPostgresConnection(target);
			const filePrefix =
				target === 'core'
					? 'winwidget-db'
					: SERVICE_DATABASE_CONFIG[target].filePrefix;
			const fileName = `${filePrefix}-${timestamp}.dump`;
			const filePath = join(directory, fileName);

			await this.runCommand(
				'pg_dump',
				[
					'--format=custom',
					'--no-owner',
					'--no-privileges',
					'--no-password',
					'--schema',
					database.schema,
					database.url
				],
				database.password,
				signal,
				{
					filePath,
					maxBytes: DATABASE_BACKUP_MAX_FILE_SIZE_BYTES
				}
			);
			const file = await stat(filePath);

			await this.runCommand(
				'pg_restore',
				['--list', filePath],
				null,
				signal
			);
			const fileSha256 = await this.calculateSha256(filePath);
			const telegramReceipt = await this.telegram.sendDocument(
				input.chatId,
				filePath,
				[
					'<b>Backup базы данных WinWidget</b>',
					`База: <b>${database.label}</b>`,
					`Создано: ${this.formatMoscowDateTime(createdAt)} МСК`,
					`Тип: ${input.trigger === 'MANUAL' ? 'ручной' : 'ежедневный'}`,
					`Job ID: <code>${jobId}</code>`,
					`SHA-256: <code>${fileSha256}</code>`
				].join('\n'),
				{
					messageThreadId: input.messageThreadId,
					signal
				}
			);

			return {
				target: database.target,
				databaseName: database.databaseName,
				schema: database.schema,
				fileName,
				fileSize: file.size,
				fileSha256,
				createdAt: createdAt.toISOString(),
				telegramSent: true,
				telegramReceipt
			};
		} finally {
			await rm(directory, { recursive: true, force: true }).catch(error =>
				this.logger.warn(
					`Failed to remove backup temp directory: ${
						error instanceof Error ? error.message : String(error)
					}`
				)
			);
		}
	}

	private async calculateSha256(filePath: string): Promise<string> {
		const hash = createHash('sha256');
		for await (const chunk of createReadStream(filePath)) {
			hash.update(chunk);
		}
		return hash.digest('hex');
	}

	private assertInput(input: DatabaseBackupInput): void {
		if (!input.chatId?.trim()) {
			throw new Error('Telegram chat ID for database backup is missing');
		}
		if (
			!Number.isInteger(input.messageThreadId) ||
			input.messageThreadId < 1
		) {
			throw new Error('Telegram Backups topic is missing');
		}
	}

	private getPostgresConnection(
		target: DatabaseBackupTarget
	): PostgresConnection {
		if (target !== 'core') {
			const config = SERVICE_DATABASE_CONFIG[target];
			const key = config.key;
			const raw = this.configService.get<string>(key)?.trim();
			if (!raw || ['change_me', 'XYZXYZXYZ'].includes(raw)) {
				throw new Error(`${key} is not configured`);
			}
			return this.parsePostgresConnection(key, raw, target, config.label);
		}

		const mode =
			this.configService.get<string>('MODE')?.trim().toLowerCase() ||
			'development';
		if (mode !== 'development' && mode !== 'production') {
			throw new Error(
				`Unsupported MODE=${mode}: expected development or production`
			);
		}
		const modeKey =
			mode === 'production'
				? 'DATABASE_URL_PRODUCTION'
				: 'DATABASE_URL_DEVELOPMENT';
		const backupUrl = this.configService
			.get<string>('DATABASE_BACKUP_URL')
			?.trim();
		const key = backupUrl ? 'DATABASE_BACKUP_URL' : modeKey;
		const raw = this.configService.get<string>(key)?.trim();
		if (!raw || ['change_me', 'XYZXYZXYZ'].includes(raw)) {
			throw new Error(`${key} is not configured`);
		}

		return this.parsePostgresConnection(
			key,
			raw,
			'core',
			'основная (core)'
		);
	}

	private parsePostgresConnection(
		key: string,
		raw: string,
		target: DatabaseBackupTarget,
		label: string
	): PostgresConnection {
		if (['change_me', 'XYZXYZXYZ'].includes(raw)) {
			throw new Error(`${key} is not configured`);
		}
		const url = new URL(raw);
		if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
			throw new Error(`${key} must be a PostgreSQL connection URL`);
		}
		const schema = url.searchParams.get('schema')?.trim() || 'public';
		const databaseName = decodeURIComponent(
			url.pathname.replace(/^\/+/, '')
		);
		if (!databaseName) {
			throw new Error(`${key} must include a PostgreSQL database name`);
		}
		const passwordParameter = url.searchParams.get('password');
		const password = url.password
			? decodeURIComponent(url.password)
			: passwordParameter || null;
		url.password = '';
		url.searchParams.delete('password');
		for (const parameter of PRISMA_ONLY_CONNECTION_PARAMS) {
			url.searchParams.delete(parameter);
		}

		return {
			target,
			label,
			databaseName,
			url: url.toString(),
			schema,
			password
		};
	}

	private async runCommand(
		command: 'pg_dump' | 'pg_restore',
		args: string[],
		password: string | null,
		parentSignal: AbortSignal,
		output?: {
			filePath: string;
			maxBytes: number;
		}
	): Promise<void> {
		if (parentSignal.aborted) {
			throw parentSignal.reason || new Error('Backup lease was lost');
		}

		await new Promise<void>((resolve, reject) => {
			const childEnvironment = { ...process.env };
			for (const key of DATABASE_URL_ENV_KEYS) {
				delete childEnvironment[key];
			}
			delete childEnvironment.PGPASSWORD;
			if (password) childEnvironment.PGPASSWORD = password;
			const child = spawn(command, args, {
				env: childEnvironment,
				stdio: ['ignore', output ? 'pipe' : 'ignore', 'pipe']
			});
			let stderr = '';
			let settled = false;
			let abortError: Error | null = null;
			let outputPromise: Promise<void> | null = null;
			let forceKillTimer: NodeJS.Timeout | null = null;
			const timeout = setTimeout(
				() => abort(new Error(`${command} timed out`)),
				this.commandTimeoutMs
			);
			timeout.unref();

			const cleanup = () => {
				clearTimeout(timeout);
				if (forceKillTimer) clearTimeout(forceKillTimer);
				parentSignal.removeEventListener('abort', onParentAbort);
			};
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error);
				else resolve();
			};
			const abort = (error: Error) => {
				if (settled) return;
				if (abortError) return;
				abortError = error;
				child.kill('SIGTERM');
				forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
				forceKillTimer.unref();
			};
			const onParentAbort = () =>
				abort(
					parentSignal.reason instanceof Error
						? parentSignal.reason
						: new Error('Backup lease was lost')
				);

			parentSignal.addEventListener('abort', onParentAbort, {
				once: true
			});
			if (parentSignal.aborted) onParentAbort();
			if (output) {
				if (!child.stdout) {
					abort(new Error(`${command} stdout is unavailable`));
				} else {
					let writtenBytes = 0;
					const limiter = new Transform({
						transform(chunk: Buffer, _encoding, callback) {
							writtenBytes += chunk.length;
							if (writtenBytes > output.maxBytes) {
								callback(
									new Error(
										'Backup больше 49 МБ и не может быть отправлен Telegram-ботом'
									)
								);
								return;
							}
							callback(null, chunk);
						}
					});
					outputPromise = pipeline(
						child.stdout,
						limiter,
						createWriteStream(output.filePath, {
							flags: 'wx',
							mode: 0o600
						})
					).catch(error => {
						abort(
							error instanceof Error ? error : new Error(String(error))
						);
					});
				}
			}
			child.stderr?.on('data', chunk => {
				if (stderr.length < 10_000) {
					stderr += Buffer.from(chunk).toString('utf8');
				}
			});
			child.once('error', error => {
				if (abortError) {
					finish(abortError);
					return;
				}
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					finish(
						new Error(
							`${command} не найден в backend-образе; требуется PostgreSQL client`
						)
					);
					return;
				}
				finish(new Error(`${command} failed: ${error.message}`));
			});
			child.once('close', async (code, signal) => {
				if (settled) return;
				if (outputPromise) await outputPromise;
				if (abortError) {
					finish(abortError);
					return;
				}
				if (code === 0) {
					finish();
					return;
				}
				const detail = stderr.trim().slice(0, 2000);
				finish(
					new Error(
						`${command} завершился с code=${code ?? 'null'} signal=${
							signal || 'none'
						}${detail ? `: ${this.redact(detail, password)}` : ''}`
					)
				);
			});
		});
	}

	private redact(value: string, password: string | null): string {
		return password ? value.split(password).join('[REDACTED]') : value;
	}

	private async cleanupStaleDirectories(): Promise<void> {
		const entries = await readdir(tmpdir(), {
			withFileTypes: true
		}).catch(() => []);
		const staleBefore = Date.now() - 24 * 60 * 60 * 1000;
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
						await rm(path, { recursive: true, force: true }).catch(error =>
							this.logger.warn(
								`Failed to remove stale backup directory ${entry.name}: ${
									error instanceof Error ? error.message : String(error)
								}`
							)
						);
					}
				})
		);
	}

	private formatMoscowDateTime(value: Date): string {
		return value.toLocaleString('ru-RU', {
			timeZone: 'Europe/Moscow',
			day: '2-digit',
			month: '2-digit',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}
}
