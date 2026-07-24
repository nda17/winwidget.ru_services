import { DatabaseBackupService } from '@/maintenance/database-backup.service';
import { TelegramInfoTransportService } from '@/telegram-bot/telegram-info-transport.service';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

jest.mock('node:child_process', () => ({
	spawn: jest.fn()
}));

describe('DatabaseBackupService', () => {
	const createService = (values: Record<string, string | undefined>) =>
		new DatabaseBackupService(
			{
				get: jest.fn((key: string) => values[key])
			} as unknown as ConfigService,
			{} as TelegramInfoTransportService
		);

	afterEach(() => {
		jest.clearAllMocks();
	});

	it('removes credentials and Prisma-only parameters from the pg_dump URL', () => {
		const service = createService({
			MODE: 'production',
			DATABASE_URL_PRODUCTION:
				'postgresql://backup:s%40cret@db.example:5432/app?schema=tenant&connection_limit=5&pool_timeout=3&pgbouncer=true&statement_cache_size=0&sslmode=require'
		});

		const connection = (service as any).getPostgresConnection();

		expect(connection.password).toBe('s@cret');
		expect(connection.schema).toBe('tenant');
		expect(connection.url).toContain('sslmode=require');
		expect(connection.url).not.toContain('s%40cret');
		expect(connection.url).not.toContain('schema=');
		expect(connection.url).not.toContain('connection_limit=');
		expect(connection.url).not.toContain('pool_timeout=');
		expect(connection.url).not.toContain('pgbouncer=');
		expect(connection.url).not.toContain('statement_cache_size=');
	});

	it('prefers an optional direct backup endpoint over the Prisma pooler URL', () => {
		const service = createService({
			MODE: 'production',
			DATABASE_URL_PRODUCTION:
				'postgresql://app:pooler-secret@pooler.example:6543/app?pgbouncer=true',
			DATABASE_BACKUP_URL:
				'postgresql://backup:direct-secret@primary.example:5432/app?sslmode=require'
		});

		const connection = (service as any).getPostgresConnection();

		expect(connection.url).toContain('primary.example:5432');
		expect(connection.url).not.toContain('pooler.example');
		expect(connection.url).not.toContain('direct-secret');
		expect(connection.password).toBe('direct-secret');
	});

	it('stops pg_dump as soon as streamed output exceeds the disk limit', async () => {
		const service = createService({});
		const directory = await mkdtemp(
			join(tmpdir(), 'winwidget-backup-test-')
		);
		const filePath = join(directory, 'backup.dump');
		const child = new EventEmitter() as EventEmitter & {
			stdout: PassThrough;
			stderr: PassThrough;
			kill: jest.Mock;
		};
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = jest.fn(signal => {
			setImmediate(() => child.emit('close', null, signal));
			return true;
		});
		(spawn as unknown as jest.Mock).mockReturnValue(child);

		try {
			const execution = (service as any).runCommand(
				'pg_dump',
				[],
				'secret',
				new AbortController().signal,
				{ filePath, maxBytes: 3 }
			);
			child.stdout.end(Buffer.from('1234'));

			await expect(execution).rejects.toThrow('Backup больше 49 МБ');
			expect(child.kill).toHaveBeenCalledWith('SIGTERM');
			const file = await stat(filePath);
			expect(file.size).toBeLessThanOrEqual(3);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('passes only PGPASSWORD to the child and removes database URLs from its environment', async () => {
		const service = createService({});
		const child = new EventEmitter() as EventEmitter & {
			stdout: PassThrough;
			stderr: PassThrough;
			kill: jest.Mock;
		};
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = jest.fn().mockReturnValue(true);
		(spawn as unknown as jest.Mock).mockReturnValue(child);
		const previousUrl = process.env.DATABASE_URL_PRODUCTION;
		const previousBackupUrl = process.env.DATABASE_BACKUP_URL;
		process.env.DATABASE_URL_PRODUCTION =
			'postgresql://user:full-secret@db.example/app';
		process.env.DATABASE_BACKUP_URL =
			'postgresql://user:backup-secret@db.example/app';

		try {
			const execution = (service as any).runCommand(
				'pg_restore',
				['--list', 'backup.dump'],
				'password-only',
				new AbortController().signal
			);
			child.emit('close', 0, null);
			await execution;

			const [, args, options] = (spawn as unknown as jest.Mock).mock
				.calls[0];
			expect(args.join(' ')).not.toContain('password-only');
			expect(options.env.PGPASSWORD).toBe('password-only');
			expect(options.env.DATABASE_BACKUP_URL).toBeUndefined();
			expect(options.env.DATABASE_URL_PRODUCTION).toBeUndefined();
			expect(options.env.DATABASE_URL_DEVELOPMENT).toBeUndefined();
			expect(options.env.DATABASE_URL).toBeUndefined();
		} finally {
			if (previousUrl === undefined) {
				delete process.env.DATABASE_URL_PRODUCTION;
			} else {
				process.env.DATABASE_URL_PRODUCTION = previousUrl;
			}
			if (previousBackupUrl === undefined) {
				delete process.env.DATABASE_BACKUP_URL;
			} else {
				process.env.DATABASE_BACKUP_URL = previousBackupUrl;
			}
		}
	});
});
