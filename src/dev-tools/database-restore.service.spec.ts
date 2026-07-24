import {
	DATABASE_RESTORE_MAX_FILE_SIZE_BYTES,
	DatabaseRestoreService
} from '@/dev-tools/database-restore.service';
import type { PrismaService } from '@/prisma.service';
import { BadRequestException } from '@nestjs/common';

describe('DatabaseRestoreService', () => {
	const originalMode = process.env.MODE;
	const originalDevelopmentUrl = process.env.DATABASE_URL_DEVELOPMENT;

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
			'postgresql://postgres:secret@localhost:5432/winwidget?schema=custom';
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

	it('restores a valid dump and reconnects the global Prisma client', async () => {
		const { service, prisma } = createService();
		const internals = service as any;
		jest
			.spyOn(internals, 'writeUploadedBackupFile')
			.mockResolvedValue('/tmp/winwidget.dump');
		const runPostgresCommand = jest
			.spyOn(internals, 'runPostgresCommand')
			.mockResolvedValue(undefined);
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
		expect(runPostgresCommand).toHaveBeenCalledWith('pg_restore', [
			'--exit-on-error',
			'--clean',
			'--if-exists',
			'--no-owner',
			'--no-privileges',
			'--schema',
			'custom',
			'--dbname',
			'postgresql://postgres:secret@localhost:5432/winwidget',
			'/tmp/winwidget.dump'
		]);
		expect(prisma.$connect).toHaveBeenCalledTimes(1);
		expect(deleteTempFile).toHaveBeenCalledWith('/tmp/winwidget.dump');
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
			.mockResolvedValue(undefined);
		jest.spyOn(internals, 'deleteTempFile').mockResolvedValue(undefined);
		const file = createFile();

		await expect(service.restore(file, 'ВОССТАНОВИТЬ БД')).rejects.toThrow(
			'write failed'
		);
		await expect(
			service.restore(file, 'ВОССТАНОВИТЬ БД')
		).resolves.toMatchObject({ restored: true });
	});
});
