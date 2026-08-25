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
			REPORTING_BACKUP_URL:
				'postgresql://backup:s%40cret@db.example:5432/app?schema=tenant&connection_limit=5&pool_timeout=3&pgbouncer=true&statement_cache_size=0&sslmode=require'
		});

		const connection = (service as any).getPostgresConnection('reporting');

		expect(connection.password).toBe('s@cret');
		expect(connection.target).toBe('reporting');
		expect(connection.schema).toBe('tenant');
		expect(connection.url).toContain('sslmode=require');
		expect(connection.url).not.toContain('s%40cret');
		expect(connection.url).not.toContain('schema=');
		expect(connection.url).not.toContain('connection_limit=');
		expect(connection.url).not.toContain('pool_timeout=');
		expect(connection.url).not.toContain('pgbouncer=');
		expect(connection.url).not.toContain('statement_cache_size=');
	});

	it('sanitizes the separately configured notification-delivery backup connection', () => {
		const service = createService({
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

	it('uses the dedicated least-privilege Reporting backup connection', () => {
		const service = createService({
			REPORTING_BACKUP_URL:
				'postgresql://reporting_backup:reporting-secret@reporting.example:5432/winwidget_reporting?schema=reporting&sslmode=require'
		});

		const connection = (service as any).getPostgresConnection('reporting');

		expect(connection).toEqual(
			expect.objectContaining({
				target: 'reporting',
				label: 'Reporting',
				databaseName: 'winwidget_reporting',
				schema: 'reporting',
				password: 'reporting-secret'
			})
		);
		expect(connection.url).toContain(
			'reporting.example:5432/winwidget_reporting'
		);
		expect(connection.url).not.toContain('reporting-secret');
		expect(connection.url).not.toContain('schema=');
	});

	it('uses the dedicated least-privilege Widgets backup connection', () => {
		const service = createService({
			WIDGETS_BACKUP_URL:
				'postgresql://widgets_backup:widgets-secret@widgets.example:5432/winwidget_widgets?schema=widgets&sslmode=require'
		});

		const connection = (service as any).getPostgresConnection('widgets');

		expect(connection).toEqual(
			expect.objectContaining({
				target: 'widgets',
				label: 'Widgets',
				databaseName: 'winwidget_widgets',
				schema: 'widgets',
				password: 'widgets-secret'
			})
		);
		expect(connection.url).toContain(
			'widgets.example:5432/winwidget_widgets'
		);
		expect(connection.url).not.toContain('widgets-secret');
		expect(connection.url).not.toContain('schema=');
	});

	it('uses the dedicated least-privilege Identity backup connection', () => {
		const service = createService({
			IDENTITY_BACKUP_URL:
				'postgresql://identity_backup:identity-secret@identity.example:5432/winwidget_identity?schema=identity&sslmode=require'
		});

		const connection = (service as any).getPostgresConnection('identity');

		expect(connection).toEqual(
			expect.objectContaining({
				target: 'identity',
				label: 'Identity',
				databaseName: 'winwidget_identity',
				schema: 'identity',
				password: 'identity-secret'
			})
		);
		expect(connection.url).toContain(
			'identity.example:5432/winwidget_identity'
		);
		expect(connection.url).not.toContain('identity-secret');
		expect(connection.url).not.toContain('schema=');
	});

	it('uses the dedicated least-privilege Platform backup connection', () => {
		const service = createService({
			PLATFORM_BACKUP_URL:
				'postgresql://platform_backup:platform-secret@platform.example:5432/winwidget_platform?schema=platform&sslmode=require'
		});

		const connection = (service as any).getPostgresConnection('platform');

		expect(connection).toEqual(
			expect.objectContaining({
				target: 'platform',
				label: 'Platform',
				databaseName: 'winwidget_platform',
				schema: 'platform',
				password: 'platform-secret'
			})
		);
		expect(connection.url).toContain(
			'platform.example:5432/winwidget_platform'
		);
		expect(connection.url).not.toContain('platform-secret');
		expect(connection.url).not.toContain('schema=');
	});

	it('uses the dedicated least-privilege Operations backup connection', () => {
		const service = createService({
			OPERATIONS_BACKUP_URL:
				'postgresql://operations_backup:operations-secret@operations.example:5432/winwidget_operations?schema=operations&sslmode=require'
		});

		const connection = (service as any).getPostgresConnection(
			'operations'
		);

		expect(connection).toEqual(
			expect.objectContaining({
				target: 'operations',
				label: 'Operations',
				databaseName: 'winwidget_operations',
				schema: 'operations',
				password: 'operations-secret'
			})
		);
		expect(connection.url).toContain(
			'operations.example:5432/winwidget_operations'
		);
		expect(connection.url).not.toContain('operations-secret');
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
						expect(args.join(' ')).not.toContain('delivery-secret');
						expect(args.join(' ')).toContain('notifications.example:5432');
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

	it('requires a dedicated URL for each service-owned database', async () => {
		const service = createService({
			MODE: 'development'
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

		await expect(
			service.createAndSend(
				'job-3',
				'reporting',
				{
					chatId: '-1001',
					messageThreadId: 42,
					trigger: 'SCHEDULED'
				},
				new AbortController().signal
			)
		).rejects.toThrow('REPORTING_BACKUP_URL is not configured');

		await expect(
			service.createAndSend(
				'job-4',
				'widgets',
				{
					chatId: '-1001',
					messageThreadId: 42,
					trigger: 'SCHEDULED'
				},
				new AbortController().signal
			)
		).rejects.toThrow('WIDGETS_BACKUP_URL is not configured');
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
		const previousNotificationDeliveryUrl =
			process.env.NOTIFICATION_DELIVERY_BACKUP_URL;
		const previousNotificationDeliveryRuntimeUrl =
			process.env.NOTIFICATION_DELIVERY_DATABASE_URL;
		const previousReportingBackupUrl = process.env.REPORTING_BACKUP_URL;
		const previousReportingRuntimeUrl = process.env.REPORTING_DATABASE_URL;
		const previousWidgetsBackupUrl = process.env.WIDGETS_BACKUP_URL;
		const previousWidgetsRuntimeUrl = process.env.WIDGETS_DATABASE_URL;
		process.env.DATABASE_URL_PRODUCTION =
			'postgresql://user:full-secret@db.example/app';
		process.env.NOTIFICATION_DELIVERY_BACKUP_URL =
			'postgresql://user:notification-backup-secret@db.example/app';
		process.env.NOTIFICATION_DELIVERY_DATABASE_URL =
			'postgresql://user:notification-runtime-secret@db.example/app';
		process.env.REPORTING_BACKUP_URL =
			'postgresql://user:reporting-backup-secret@db.example/app';
		process.env.REPORTING_DATABASE_URL =
			'postgresql://user:reporting-runtime-secret@db.example/app';
		process.env.WIDGETS_BACKUP_URL =
			'postgresql://user:widgets-backup-secret@db.example/app';
		process.env.WIDGETS_DATABASE_URL =
			'postgresql://user:widgets-runtime-secret@db.example/app';

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
			expect(options.env.DATABASE_URL_PRODUCTION).toBeUndefined();
			expect(options.env.DATABASE_URL_DEVELOPMENT).toBeUndefined();
			expect(options.env.DATABASE_URL).toBeUndefined();
			expect(options.env.NOTIFICATION_DELIVERY_BACKUP_URL).toBeUndefined();
			expect(
				options.env.NOTIFICATION_DELIVERY_DATABASE_URL
			).toBeUndefined();
			expect(options.env.REPORTING_BACKUP_URL).toBeUndefined();
			expect(options.env.REPORTING_DATABASE_URL).toBeUndefined();
			expect(options.env.WIDGETS_BACKUP_URL).toBeUndefined();
			expect(options.env.WIDGETS_DATABASE_URL).toBeUndefined();
		} finally {
			if (previousUrl === undefined) {
				delete process.env.DATABASE_URL_PRODUCTION;
			} else {
				process.env.DATABASE_URL_PRODUCTION = previousUrl;
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
			if (previousReportingBackupUrl === undefined) {
				delete process.env.REPORTING_BACKUP_URL;
			} else {
				process.env.REPORTING_BACKUP_URL = previousReportingBackupUrl;
			}
			if (previousReportingRuntimeUrl === undefined) {
				delete process.env.REPORTING_DATABASE_URL;
			} else {
				process.env.REPORTING_DATABASE_URL = previousReportingRuntimeUrl;
			}
			if (previousWidgetsBackupUrl === undefined) {
				delete process.env.WIDGETS_BACKUP_URL;
			} else {
				process.env.WIDGETS_BACKUP_URL = previousWidgetsBackupUrl;
			}
			if (previousWidgetsRuntimeUrl === undefined) {
				delete process.env.WIDGETS_DATABASE_URL;
			} else {
				process.env.WIDGETS_DATABASE_URL = previousWidgetsRuntimeUrl;
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
