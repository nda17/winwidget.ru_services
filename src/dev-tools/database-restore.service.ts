import { PrismaService } from '@/prisma.service';
import {
	BadRequestException,
	ConflictException,
	Injectable
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DATABASE_RESTORE_MAX_FILE_SIZE_BYTES = 49 * 1024 * 1024;
const CORE_DATABASE_SCHEMA = 'public';
const SERVICE_DATABASE_SCHEMAS = [
	{
		schema: 'notification_delivery',
		label: 'Notification Delivery'
	},
	{ schema: 'campaigns', label: 'Campaigns' },
	{ schema: 'reporting', label: 'Reporting' },
	{ schema: 'widgets', label: 'Widgets' },
	{ schema: 'billing', label: 'Billing' }
] as const;
const REPORTING_PRODUCER_FUNCTION_SIGNATURES = [
	'public.reporting_producers_enabled()',
	'public.reporting_iso_timestamp(timestamp without time zone)',
	'public.reporting_record_projection_event(text,text,text,text,jsonb,boolean)',
	'public.reporting_emit_user_projection(text,boolean)',
	'public.reporting_user_projection_trigger()',
	'public.reporting_auth_identity_projection_trigger()',
	'public.reporting_settings_projection_trigger()'
] as const;

const REPORTING_PRODUCER_FUNCTION_ACL_SQL = `
DO $reporting_restore_acl$
DECLARE
    function_signature TEXT;
    function_oid REGPROCEDURE;
    present_function_count INTEGER;
BEGIN
    SELECT count(*)
    INTO present_function_count
    FROM unnest(ARRAY[
        ${REPORTING_PRODUCER_FUNCTION_SIGNATURES.map(signature => `'${signature}'`).join(',\n        ')}
    ]) AS expected(signature)
    WHERE to_regprocedure(expected.signature) IS NOT NULL;

    IF present_function_count NOT IN (0, ${REPORTING_PRODUCER_FUNCTION_SIGNATURES.length}) THEN
        RAISE EXCEPTION
            'Incomplete Reporting producer function set after restore: % of ${REPORTING_PRODUCER_FUNCTION_SIGNATURES.length}',
            present_function_count;
    END IF;

    FOREACH function_signature IN ARRAY ARRAY[
        ${REPORTING_PRODUCER_FUNCTION_SIGNATURES.map(signature => `'${signature}'`).join(',\n        ')}
    ] LOOP
        function_oid := to_regprocedure(function_signature);
        IF function_oid IS NULL THEN
            CONTINUE;
        END IF;

        EXECUTE format(
            'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC',
            function_oid
        );
        IF EXISTS (
            SELECT 1 FROM pg_roles WHERE rolname = 'winwidget_api_runtime'
        ) THEN
            EXECUTE format(
                'GRANT EXECUTE ON FUNCTION %s TO %I',
                function_oid,
                'winwidget_api_runtime'
            );
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM unnest(ARRAY[
            ${REPORTING_PRODUCER_FUNCTION_SIGNATURES.map(signature => `'${signature}'`).join(',\n            ')}
        ]) AS expected(signature)
        JOIN pg_proc procedure
            ON procedure.oid = to_regprocedure(expected.signature)
        CROSS JOIN LATERAL aclexplode(
            COALESCE(
                procedure.proacl,
                acldefault('f', procedure.proowner)
            )
        ) AS privilege
        WHERE privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
    ) THEN
        RAISE EXCEPTION
            'Reporting producer functions remain executable by PUBLIC after restore';
    END IF;
END
$reporting_restore_acl$;
`;

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
		if ((process.env.MODE || '').trim().toLowerCase() === 'production') {
			throw new ConflictException(
				'Синхронное восстановление основной БД отключено в production. ' +
					'Используйте защищённую очередь восстановления.'
			);
		}

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
		let prismaDisconnected = false;

		try {
			backupPath = await this.writeUploadedBackupFile(file);
			const database = this.getPostgresCommandConnection();
			const tableOfContents = await this.runPostgresCommand('pg_restore', [
				'--list',
				backupPath
			]);
			this.assertCoreBackupTableOfContents(tableOfContents);

			await this.prisma.$disconnect();
			prismaDisconnected = true;
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
			await this.runPostgresCommand('psql', [
				'--no-psqlrc',
				'--set',
				'ON_ERROR_STOP=1',
				'--dbname',
				database.url,
				'--command',
				REPORTING_PRODUCER_FUNCTION_ACL_SQL
			]);

			return {
				restored: true,
				fileName: originalName,
				fileSize: file.size,
				restoredAt: new Date().toISOString()
			};
		} finally {
			try {
				if (prismaDisconnected) {
					await this.prisma.$connect();
				}
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

	private async runPostgresCommand(
		command: string,
		args: string[]
	): Promise<string> {
		try {
			const { stdout } = await execFileAsync(command, args, {
				timeout: this.commandTimeoutMs,
				maxBuffer: 1024 * 1024
			});
			return stdout;
		} catch (error) {
			const message = this.getPostgresCommandErrorMessage(command, error);
			throw new BadRequestException(message);
		}
	}

	private assertCoreBackupTableOfContents(tableOfContents: string): void {
		const entries = tableOfContents
			.split(/\r?\n/)
			.map(entry => entry.trim())
			.filter(entry => entry && !entry.startsWith(';'));
		if (!entries.length) {
			throw new BadRequestException(
				'Файл backup не содержит PostgreSQL TOC'
			);
		}

		const serviceDump = SERVICE_DATABASE_SCHEMAS.find(({ schema }) =>
			entries.some(entry =>
				new RegExp(
					`^\\d+;\\s+\\d+\\s+\\d+\\s+SCHEMA\\s+-\\s+${schema}(\\s|$)`,
					'i'
				).test(entry)
			)
		);
		if (serviceDump) {
			throw new BadRequestException(
				`Dump ${serviceDump.label} нельзя восстанавливать в основную БД`
			);
		}

		const containsCoreSchema = entries.some(entry =>
			new RegExp(
				`^\\d+;\\s+\\d+\\s+\\d+\\s+SCHEMA\\s+-\\s+${CORE_DATABASE_SCHEMA}(\\s|$)`,
				'i'
			).test(entry)
		);
		if (!containsCoreSchema) {
			throw new BadRequestException(
				'Разрешён только dump основной БД со схемой public'
			);
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
		if (schema !== CORE_DATABASE_SCHEMA) {
			throw new BadRequestException(
				'Восстановление разрешено только для основной схемы public'
			);
		}

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
