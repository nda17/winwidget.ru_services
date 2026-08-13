import {
	DATABASE_RESTORE_MAX_FILE_SIZE_BYTES,
	DatabaseRestoreService
} from '@/dev-tools/database-restore.service';
import type { PrismaService } from '@/prisma.service';
import { BadRequestException, ConflictException } from '@nestjs/common';

describe('DatabaseRestoreService', () => {
	const originalMode = process.env.MODE;
	const originalDevelopmentUrl = process.env.DATABASE_URL_DEVELOPMENT;
	const coreTableOfContents = [
		'; Archive created at 2026-07-29 12:00:00 UTC',
		'5; 2615 2200 SCHEMA - public postgres',
		'215; 1259 16401 TABLE public users postgres',
		'216; 0 16401 TABLE DATA public users postgres'
	].join('\n');
	const notificationDeliveryTableOfContents = [
		'; Archive created at 2026-07-29 12:00:00 UTC',
		'5; 2615 2200 SCHEMA - notification_delivery postgres',
		'215; 1259 16401 TABLE notification_delivery delivery_receipts postgres'
	].join('\n');
	const widgetsTableOfContents = [
		'; Archive created at 2026-08-04 12:00:00 UTC',
		'5; 2615 2200 SCHEMA - widgets postgres',
		'215; 1259 16401 TABLE widgets widgets postgres'
	].join('\n');

	const createService = () => {
		const prisma = {
			$disconnect: jest.fn().mockResolvedValue(undefined),
			$connect: jest.fn().mockResolvedValue(undefined)
		} as unknown as PrismaService;

		return {
			service: new DatabaseRestoreService(prisma),
			prisma
		};
	};

	const createFile = (
		overrides: Partial<Express.Multer.File> = {}
	): Express.Multer.File =>
		({
			buffer: Buffer.from('database-backup'),
			originalname: 'winwidget.dump',
			size: 15,
			...overrides
		}) as Express.Multer.File;

	beforeEach(() => {
		process.env.MODE = 'development';
		process.env.DATABASE_URL_DEVELOPMENT =
			'postgresql://postgres:secret@localhost:5432/winwidget?schema=public';
	});

	afterEach(() => {
		jest.restoreAllMocks();
		if (originalMode === undefined) delete process.env.MODE;
		else process.env.MODE = originalMode;
		if (originalDevelopmentUrl === undefined) {
			delete process.env.DATABASE_URL_DEVELOPMENT;
		} else {
			process.env.DATABASE_URL_DEVELOPMENT = originalDevelopmentUrl;
		}
	});

	it('returns the DEV confirmation independently of Telegram settings', () => {
		const { service } = createService();

		expect(service.getSettings()).toEqual({
			confirmation: 'ВОССТАНОВИТЬ БД'
		});
	});

	it('validates confirmation, file presence, size and format', async () => {
		const { service, prisma } = createService();

		await expect(
			service.restore(createFile(), 'incorrect')
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			service.restore(undefined, 'ВОССТАНОВИТЬ БД')
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			service.restore(
				createFile({
					size: DATABASE_RESTORE_MAX_FILE_SIZE_BYTES + 1
				}),
				'ВОССТАНОВИТЬ БД'
			)
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			service.restore(
				createFile({ originalname: 'winwidget.sql' }),
				'ВОССТАНОВИТЬ БД'
			)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(prisma.$disconnect).not.toHaveBeenCalled();
	});

	it('keeps the legacy endpoint fail-closed in production', async () => {
		process.env.MODE = 'production';
		const { service, prisma } = createService();

		await expect(
			service.restore(createFile(), 'ВОССТАНОВИТЬ БД')
		).rejects.toBeInstanceOf(ConflictException);
		expect(prisma.$disconnect).not.toHaveBeenCalled();
	});

	it('restores a valid dump and reconnects the global Prisma client', async () => {
		const { service, prisma } = createService();
		const internals = service as any;
		jest
			.spyOn(internals, 'writeUploadedBackupFile')
			.mockResolvedValue('/tmp/winwidget.dump');
		const runPostgresCommand = jest
			.spyOn(internals, 'runPostgresCommand')
			.mockResolvedValueOnce(coreTableOfContents)
			.mockResolvedValueOnce('')
			.mockResolvedValueOnce('');
		const deleteTempFile = jest
			.spyOn(internals, 'deleteTempFile')
			.mockResolvedValue(undefined);
		const file = createFile();

		await expect(
			service.restore(file, 'ВОССТАНОВИТЬ БД')
		).resolves.toEqual({
			restored: true,
			fileName: file.originalname,
			fileSize: file.size,
			restoredAt: expect.any(String)
		});
		expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
		expect(runPostgresCommand).toHaveBeenNthCalledWith(1, 'pg_restore', [
			'--list',
			'/tmp/winwidget.dump'
		]);
		expect(runPostgresCommand).toHaveBeenNthCalledWith(2, 'pg_restore', [
			'--exit-on-error',
			'--clean',
			'--if-exists',
			'--no-owner',
			'--no-privileges',
			'--schema',
			'public',
			'--dbname',
			'postgresql://postgres:secret@localhost:5432/winwidget',
			'/tmp/winwidget.dump'
		]);
		expect(runPostgresCommand).toHaveBeenNthCalledWith(3, 'psql', [
			'--no-psqlrc',
			'--set',
			'ON_ERROR_STOP=1',
			'--dbname',
			'postgresql://postgres:secret@localhost:5432/winwidget',
			'--command',
			expect.stringContaining('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC')
		]);
		expect(runPostgresCommand.mock.calls[2][1][6]).toContain(
			'public.reporting_record_projection_event(text,text,text,text,jsonb,boolean)'
		);
		expect(runPostgresCommand.mock.calls[2][1][6]).toContain(
			'Incomplete Reporting producer function set after restore: % of 7'
		);
		expect(runPostgresCommand.mock.calls[2][1][6]).not.toContain(
			'public.reporting_widget_projection_trigger()'
		);
		expect(runPostgresCommand.mock.calls[2][1][6]).not.toContain(
			'public.reporting_lead_projection_trigger()'
		);
		expect(runPostgresCommand.mock.calls[2][1][6]).toContain(
			'privilege.grantee = 0'
		);
		expect(prisma.$connect).toHaveBeenCalledTimes(1);
		expect(deleteTempFile).toHaveBeenCalledWith('/tmp/winwidget.dump');
	});

	it('rejects a Notification Delivery dump before destructive restore', async () => {
		const { service, prisma } = createService();
		const internals = service as any;
		jest
			.spyOn(internals, 'writeUploadedBackupFile')
			.mockResolvedValue('/tmp/notification-delivery.dump');
		const runPostgresCommand = jest
			.spyOn(internals, 'runPostgresCommand')
			.mockResolvedValue(notificationDeliveryTableOfContents);
		const deleteTempFile = jest
			.spyOn(internals, 'deleteTempFile')
			.mockResolvedValue(undefined);

		await expect(
			service.restore(createFile(), 'ВОССТАНОВИТЬ БД')
		).rejects.toThrow(
			'Dump Notification Delivery нельзя восстанавливать в основную БД'
		);
		expect(runPostgresCommand).toHaveBeenCalledTimes(1);
		expect(runPostgresCommand).toHaveBeenCalledWith('pg_restore', [
			'--list',
			'/tmp/notification-delivery.dump'
		]);
		expect(prisma.$disconnect).not.toHaveBeenCalled();
		expect(prisma.$connect).not.toHaveBeenCalled();
		expect(deleteTempFile).toHaveBeenCalledWith(
			'/tmp/notification-delivery.dump'
		);
	});

	it('rejects a dump without the core public schema before destructive restore', async () => {
		const { service, prisma } = createService();
		const internals = service as any;
		jest
			.spyOn(internals, 'writeUploadedBackupFile')
			.mockResolvedValue('/tmp/analytics.dump');
		const runPostgresCommand = jest
			.spyOn(internals, 'runPostgresCommand')
			.mockResolvedValue(
				'5; 2615 2200 SCHEMA - analytics postgres\n215; 1259 16401 TABLE analytics metrics postgres'
			);
		jest.spyOn(internals, 'deleteTempFile').mockResolvedValue(undefined);

		await expect(
			service.restore(createFile(), 'ВОССТАНОВИТЬ БД')
		).rejects.toThrow('Разрешён только dump основной БД со схемой public');
		expect(runPostgresCommand).toHaveBeenCalledTimes(1);
		expect(prisma.$disconnect).not.toHaveBeenCalled();
		expect(prisma.$connect).not.toHaveBeenCalled();
	});

	it('rejects a Widgets dump before destructive restore', async () => {
		const { service, prisma } = createService();
		const internals = service as any;
		jest
			.spyOn(internals, 'writeUploadedBackupFile')
			.mockResolvedValue('/tmp/widgets.dump');
		const runPostgresCommand = jest
			.spyOn(internals, 'runPostgresCommand')
			.mockResolvedValue(widgetsTableOfContents);
		jest.spyOn(internals, 'deleteTempFile').mockResolvedValue(undefined);

		await expect(
			service.restore(createFile(), 'ВОССТАНОВИТЬ БД')
		).rejects.toThrow('Dump Widgets нельзя восстанавливать в основную БД');
		expect(runPostgresCommand).toHaveBeenCalledTimes(1);
		expect(prisma.$disconnect).not.toHaveBeenCalled();
		expect(prisma.$connect).not.toHaveBeenCalled();
	});

	it('does not confuse a Core table name with the Widgets schema', () => {
		const { service } = createService();
		const coreWithWidgetsNamedTable = [
			coreTableOfContents,
			'217; 1259 16402 TABLE public widgets postgres'
		].join('\n');

		expect(() =>
			(service as any).assertCoreBackupTableOfContents(
				coreWithWidgetsNamedTable
			)
		).not.toThrow();
	});

	it('releases the in-process guard when preparing the upload fails', async () => {
		const { service } = createService();
		const internals = service as any;
		jest
			.spyOn(internals, 'writeUploadedBackupFile')
			.mockRejectedValueOnce(new Error('write failed'))
			.mockResolvedValueOnce('/tmp/winwidget.dump');
		jest
			.spyOn(internals, 'runPostgresCommand')
			.mockImplementation((_command: string, args: string[]) =>
				Promise.resolve(args.includes('--list') ? coreTableOfContents : '')
			);
		jest.spyOn(internals, 'deleteTempFile').mockResolvedValue(undefined);
		const file = createFile();

		await expect(service.restore(file, 'ВОССТАНОВИТЬ БД')).rejects.toThrow(
			'write failed'
		);
		await expect(
			service.restore(file, 'ВОССТАНОВИТЬ БД')
		).resolves.toMatchObject({ restored: true });
	});

	it('fails closed and reconnects Prisma when producer ACL hardening fails', async () => {
		const { service, prisma } = createService();
		const internals = service as any;
		jest
			.spyOn(internals, 'writeUploadedBackupFile')
			.mockResolvedValue('/tmp/winwidget.dump');
		const runPostgresCommand = jest
			.spyOn(internals, 'runPostgresCommand')
			.mockResolvedValueOnce(coreTableOfContents)
			.mockResolvedValueOnce('')
			.mockRejectedValueOnce(new Error('PUBLIC EXECUTE remains'));
		jest.spyOn(internals, 'deleteTempFile').mockResolvedValue(undefined);

		await expect(
			service.restore(createFile(), 'ВОССТАНОВИТЬ БД')
		).rejects.toThrow('PUBLIC EXECUTE remains');
		expect(runPostgresCommand).toHaveBeenCalledTimes(3);
		expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
		expect(prisma.$connect).toHaveBeenCalledTimes(1);
	});
});
