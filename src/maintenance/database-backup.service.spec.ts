import { DatabaseBackupService } from '@/maintenance/database-backup.service';
import { TelegramInfoTransportService } from '@/telegram-bot/telegram-info-transport.service';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

jest.mock('node:child_process', () => ({
	spawn: jest.fn()
}));

describe('DatabaseBackupService', () => {
	const telegramReceipt = {
		messageId: 41,
		chatId: '-1001',
		messageThreadId: 42,
		fileId: 'telegram-file-id',
		fileUniqueId: 'telegram-file-unique-id'
	};
	const createService = (
		values: Record<string, string | undefined>,
		telegram: Pick<TelegramInfoTransportService, 'sendDocument'> = {
			sendDocument: jest.fn().mockResolvedValue(telegramReceipt)
		}
	) =>
		new DatabaseBackupService(
			{
				get: jest.fn((key: string) => values[key])
			} as unknown as ConfigService,
			telegram as TelegramInfoTransportService
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

		const connection = (service as any).getPostgresConnection('core');

		expect(connection.password).toBe('s@cret');
		expect(connection.target).toBe('core');
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

		const connection = (service as any).getPostgresConnection('core');

		expect(connection.url).toContain('primary.example:5432');
		expect(connection.url).not.toContain('pooler.example');
		expect(connection.url).not.toContain('direct-secret');
		expect(connection.password).toBe('direct-secret');
	});

	it('sanitizes the separately configured notification-delivery backup connection', () => {
		const service = createService({
			MODE: 'production',
			DATABASE_BACKUP_URL:
				'postgresql://core:core-secret@core.example:5432/app?schema=public',
			NOTIFICATION_DELIVERY_BACKUP_URL:
				'postgresql://notifications:delivery-secret@notifications.example:5432/winwidget_notification_delivery?schema=delivery&sslmode=require'
		});

		const connection = (service as any).getPostgresConnection(
			'notification-delivery'
		);

		expect(connection).toEqual(
			expect.objectContaining({
				target: 'notification-delivery',
				label: 'Notification Delivery',
				databaseName: 'winwidget_notification_delivery',
				schema: 'delivery',
				password: 'delivery-secret'
			})
		);
		expect(connection.url).toContain(
			'notifications.example:5432/winwidget_notification_delivery'
		);
		expect(connection.url).toContain('sslmode=require');
		expect(connection.url).not.toContain('delivery-secret');
		expect(connection.url).not.toContain('schema=');
	});

	it('backs up only the selected notification-delivery target', async () => {
		const sequence: string[] = [];
		let dumpedPath = '';
		const telegram = {
			sendDocument: jest.fn(
				async (_chatId: string, filePath: string, caption: string) => {
					sequence.push('send:notification-delivery');
					expect((await stat(filePath)).isFile()).toBe(true);
					expect(caption).toContain('База: <b>Notification Delivery</b>');
					expect(caption).toContain(
						`SHA-256: <code>${createHash('sha256')
							.update('delivery-dump')
							.digest('hex')}</code>`
					);
					return telegramReceipt;
				}
			)
		};
		const service = createService(
			{
				MODE: 'production',
				DATABASE_BACKUP_URL:
					'postgresql://core:core-secret@core.example:5432/app?schema=public&sslmode=require',
				NOTIFICATION_DELIVERY_BACKUP_URL:
					'postgresql://notifications:delivery-secret@notifications.example:5432/winwidget_notification_delivery?schema=public&sslmode=require'
			},
			telegram
		);
		jest
			.spyOn(service as any, 'runCommand')
			.mockImplementation(
				async (
					command: 'pg_dump' | 'pg_restore',
					args: string[],
					_password: string | null,
					_signal: AbortSignal,
					output?: { filePath: string }
				) => {
					if (command === 'pg_dump' && output) {
						sequence.push('dump:notification-delivery');
						dumpedPath = output.filePath;
						expect(args.join(' ')).not.toContain('core-secret');
						expect(args.join(' ')).not.toContain('delivery-secret');
						expect(args.join(' ')).toContain('notifications.example:5432');
						expect(args.join(' ')).not.toContain('core.example:5432');
						await writeFile(output.filePath, 'delivery-dump');
						return;
					}

					sequence.push('restore:notification-delivery');
					expect((await stat(args[1])).isFile()).toBe(true);
				}
			);

		const result = await service.createAndSend(
			'job-123',
			'notification-delivery',
			{
				chatId: '-1001',
				messageThreadId: 42,
				trigger: 'SCHEDULED'
			},
			new AbortController().signal
		);

		expect(sequence).toEqual([
			'dump:notification-delivery',
			'restore:notification-delivery',
			'send:notification-delivery'
		]);
		expect(result).toEqual({
			target: 'notification-delivery',
			databaseName: 'winwidget_notification_delivery',
			schema: 'public',
			fileName: expect.stringMatching(
				/^winwidget-notification-delivery-db-.+\.dump$/
			),
			fileSize: Buffer.byteLength('delivery-dump'),
			fileSha256: createHash('sha256')
				.update('delivery-dump')
				.digest('hex'),
			createdAt: expect.any(String),
			telegramSent: true,
			telegramReceipt
		});
		expect(telegram.sendDocument).toHaveBeenCalledTimes(1);
		expect(telegram.sendDocument).toHaveBeenCalledWith(
			'-1001',
			expect.stringContaining('winwidget-notification-delivery-db-'),
			expect.stringContaining('Тип: ежедневный'),
			{
				messageThreadId: 42,
				signal: expect.any(AbortSignal)
			}
		);
		await expect(access(dumpedPath)).rejects.toMatchObject({
			code: 'ENOENT'
		});
	});

	it('returns source metadata for the selected core target', async () => {
		const telegram = {
			sendDocument: jest.fn().mockResolvedValue(telegramReceipt)
		};
		const service = createService(
			{
				MODE: 'development',
				DATABASE_BACKUP_URL:
					'postgresql://core:secret@localhost:5432/app?schema=public'
			},
			telegram
		);
		jest
			.spyOn(service as any, 'runCommand')
			.mockImplementation(
				async (
					command: 'pg_dump' | 'pg_restore',
					_args: string[],
					_password: string | null,
					_signal: AbortSignal,
					output?: { filePath: string }
				) => {
					if (command === 'pg_dump' && output) {
						await writeFile(output.filePath, 'core');
					}
				}
			);

		const result = await service.createAndSend(
			'job-1',
			'core',
			{
				chatId: '-1001',
				messageThreadId: 42,
				trigger: 'MANUAL'
			},
			new AbortController().signal
		);

		expect(result).toEqual({
			target: 'core',
			databaseName: 'app',
			schema: 'public',
			fileName: expect.stringMatching(/^winwidget-db-.+\.dump$/),
			fileSize: 4,
			fileSha256: createHash('sha256').update('core').digest('hex'),
			createdAt: expect.any(String),
			telegramSent: true,
			telegramReceipt
		});
		expect(telegram.sendDocument).toHaveBeenCalledTimes(1);
	});

	it('requires a dedicated URL only for notification-delivery jobs', async () => {
		const service = createService({
			MODE: 'development',
			DATABASE_BACKUP_URL:
				'postgresql://core:secret@localhost:5432/app?schema=public'
		});

		await expect(
			service.createAndSend(
				'job-2',
				'notification-delivery',
				{
					chatId: '-1001',
					messageThreadId: 42,
					trigger: 'SCHEDULED'
				},
				new AbortController().signal
			)
		).rejects.toThrow(
			'NOTIFICATION_DELIVERY_BACKUP_URL is not configured'
		);
		expect(spawn).not.toHaveBeenCalled();
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
		const previousNotificationDeliveryUrl =
			process.env.NOTIFICATION_DELIVERY_BACKUP_URL;
		const previousNotificationDeliveryRuntimeUrl =
			process.env.NOTIFICATION_DELIVERY_DATABASE_URL;
		process.env.DATABASE_URL_PRODUCTION =
			'postgresql://user:full-secret@db.example/app';
		process.env.DATABASE_BACKUP_URL =
			'postgresql://user:backup-secret@db.example/app';
		process.env.NOTIFICATION_DELIVERY_BACKUP_URL =
			'postgresql://user:notification-backup-secret@db.example/app';
		process.env.NOTIFICATION_DELIVERY_DATABASE_URL =
			'postgresql://user:notification-runtime-secret@db.example/app';

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
			expect(options.env.NOTIFICATION_DELIVERY_BACKUP_URL).toBeUndefined();
			expect(
				options.env.NOTIFICATION_DELIVERY_DATABASE_URL
			).toBeUndefined();
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
			if (previousNotificationDeliveryUrl === undefined) {
				delete process.env.NOTIFICATION_DELIVERY_BACKUP_URL;
			} else {
				process.env.NOTIFICATION_DELIVERY_BACKUP_URL =
					previousNotificationDeliveryUrl;
			}
			if (previousNotificationDeliveryRuntimeUrl === undefined) {
				delete process.env.NOTIFICATION_DELIVERY_DATABASE_URL;
			} else {
				process.env.NOTIFICATION_DELIVERY_DATABASE_URL =
					previousNotificationDeliveryRuntimeUrl;
			}
		}
	});

	it('escalates an aborted database command from SIGTERM to SIGKILL', async () => {
		jest.useFakeTimers();
		const service = createService({});
		const child = new EventEmitter() as EventEmitter & {
			stdout: PassThrough;
			stderr: PassThrough;
			kill: jest.Mock;
		};
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = jest.fn(signal => {
			if (signal === 'SIGKILL') {
				child.emit('close', null, signal);
			}
			return true;
		});
		(spawn as unknown as jest.Mock).mockReturnValue(child);
		const controller = new AbortController();
		const shutdownError = new Error('Maintenance worker is shutting down');

		try {
			const execution = (service as any).runCommand(
				'pg_restore',
				['--list', 'backup.dump'],
				null,
				controller.signal
			);
			const rejection = expect(execution).rejects.toBe(shutdownError);
			controller.abort(shutdownError);

			expect(child.kill).toHaveBeenCalledWith('SIGTERM');
			await jest.advanceTimersByTimeAsync(5_000);
			await rejection;
			expect(child.kill).toHaveBeenCalledWith('SIGKILL');
		} finally {
			jest.useRealTimers();
		}
	});

	it('does not spawn a database command for a pre-aborted signal', async () => {
		const service = createService({});
		const controller = new AbortController();
		const shutdownError = new Error('Maintenance worker is shutting down');
		controller.abort(shutdownError);

		await expect(
			(service as any).runCommand('pg_dump', [], null, controller.signal)
		).rejects.toBe(shutdownError);
		expect(spawn).not.toHaveBeenCalled();
	});
});
