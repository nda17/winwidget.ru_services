import { PrismaService } from '@/prisma.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DATABASE_RESTORE_MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024;

@Injectable()
export class DatabaseRestoreService {
	private readonly commandTimeoutMs = 10 * 60 * 1000;
	private readonly confirmation = 'ВОССТАНОВИТЬ БД';
	private restoreInProgress = false;

	constructor(private readonly prisma: PrismaService) {}

	getSettings() {
		return {
			confirmation: this.confirmation
		};
	}

	async restore(
		file: Express.Multer.File | undefined,
		confirmation: string
	) {
		if (this.restoreInProgress) {
			throw new BadRequestException('Восстановление базы уже выполняется');
		}

		if (confirmation !== this.confirmation) {
			throw new BadRequestException(
				`Введите подтверждение: ${this.confirmation}`
			);
		}

		if (!file?.buffer?.length) {
			throw new BadRequestException('Файл backup не передан');
		}

		if (file.size > DATABASE_RESTORE_MAX_FILE_SIZE_BYTES) {
			throw new BadRequestException(
				'Файл backup должен быть меньше 49 МБ'
			);
		}

		const originalName = file.originalname || 'database-backup.dump';
		const extension = originalName.toLowerCase().split('.').pop();

		if (extension !== 'dump') {
			throw new BadRequestException('Загрузите backup в формате .dump');
		}

		this.restoreInProgress = true;
		let backupPath: string | null = null;

		try {
			backupPath = await this.writeUploadedBackupFile(file);
			const database = this.getPostgresCommandConnection();

			await this.prisma.$disconnect();
			await this.runPostgresCommand('pg_restore', [
				'--exit-on-error',
				'--clean',
				'--if-exists',
				'--no-owner',
				'--no-privileges',
				'--schema',
				database.schema,
				'--dbname',
				database.url,
				backupPath
			]);

			return {
				restored: true,
				fileName: originalName,
				fileSize: file.size,
				restoredAt: new Date().toISOString()
			};
		} finally {
			try {
				await this.prisma.$connect();
			} finally {
				if (backupPath) {
					await this.deleteTempFile(backupPath);
				}
				this.restoreInProgress = false;
			}
		}
	}

	private async writeUploadedBackupFile(file: Express.Multer.File) {
		const directory = await this.ensureDatabaseBackupTempDir();
		const safeName = basename(file.originalname || 'database-backup.dump');
		const filePath = join(
			directory,
			`restore-${randomUUID()}-${safeName}`
		);

		await writeFile(filePath, file.buffer);

		return filePath;
	}

	private async ensureDatabaseBackupTempDir() {
		const directory = join(tmpdir(), 'winwidget-db-backups');
		await mkdir(directory, { recursive: true });
		return directory;
	}

	private async deleteTempFile(filePath: string) {
		await unlink(filePath).catch(() => undefined);
	}

	private async runPostgresCommand(command: string, args: string[]) {
		try {
			await execFileAsync(command, args, {
				timeout: this.commandTimeoutMs,
				maxBuffer: 1024 * 1024
			});
		} catch (error) {
			const message = this.getPostgresCommandErrorMessage(command, error);
			throw new BadRequestException(message);
		}
	}

	private getPostgresCommandErrorMessage(command: string, error: unknown) {
		if (this.isMissingExecutableError(error)) {
			return `На сервере не найден ${command}. Установите PostgreSQL client tools (postgresql-client/libpq) или пересоберите backend Docker-образ.`;
		}

		return error instanceof Error
			? error.message
			: 'PostgreSQL command failed';
	}

	private isMissingExecutableError(error: unknown) {
		return (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'ENOENT'
		);
	}

	private getPostgresCommandConnection() {
		const rawDatabaseUrl = this.getDatabaseUrl();
		const url = new URL(rawDatabaseUrl);
		const schema = url.searchParams.get('schema')?.trim() || 'public';

		url.searchParams.delete('schema');

		return {
			url: url.toString(),
			schema
		};
	}

	private getDatabaseUrl() {
		const mode = process.env.MODE?.trim().toLowerCase() ?? 'development';
		const databaseUrlKey =
			mode === 'production'
				? 'DATABASE_URL_PRODUCTION'
				: 'DATABASE_URL_DEVELOPMENT';
		const databaseUrl = process.env[databaseUrlKey]?.trim();

		if (!databaseUrl || databaseUrl === 'change_me') {
			throw new BadRequestException(
				`Не настроена переменная ${databaseUrlKey}`
			);
		}

		return databaseUrl;
	}
}
