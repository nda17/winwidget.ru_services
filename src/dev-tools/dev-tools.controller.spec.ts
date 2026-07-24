import type { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import type { DatabaseRestoreService } from '@/dev-tools/database-restore.service';
import { DevToolsController } from '@/dev-tools/dev-tools.controller';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';

describe('DevToolsController database restore', () => {
	const adminId = randomUUID();
	const request = {} as Request;
	const file = {
		buffer: Buffer.from('database-backup'),
		originalname: 'winwidget.dump',
		size: 15
	} as Express.Multer.File;

	const createController = () => {
		const databaseRestoreService = {
			getSettings: jest.fn().mockReturnValue({
				confirmation: 'ВОССТАНОВИТЬ БД'
			}),
			restore: jest.fn().mockResolvedValue({
				restored: true
			})
		} as unknown as DatabaseRestoreService;
		const adminEventLogService = {
			record: jest.fn().mockResolvedValue(undefined)
		} as unknown as AdminEventLogService;

		return {
			controller: new DevToolsController(
				databaseRestoreService,
				adminEventLogService
			),
			databaseRestoreService,
			adminEventLogService
		};
	};

	it('returns restore settings from the DEV-only service', () => {
		const { controller, databaseRestoreService } = createController();

		expect(controller.getDatabaseRestoreSettings()).toEqual({
			confirmation: 'ВОССТАНОВИТЬ БД'
		});
		expect(databaseRestoreService.getSettings).toHaveBeenCalledTimes(1);
	});

	it('preserves audit logging and delegates restore execution', async () => {
		const { controller, databaseRestoreService, adminEventLogService } =
			createController();

		await expect(
			controller.restoreDatabaseBackup(
				file,
				{ confirmation: 'ВОССТАНОВИТЬ БД' },
				adminId,
				request
			)
		).resolves.toEqual({ restored: true });
		expect(adminEventLogService.record).toHaveBeenCalledWith({
			adminId,
			section: 'DEV_TOOLS',
			action: 'DEV_DATABASE_RESTORE',
			description: 'Запущено восстановление базы данных из backup',
			entityType: 'database_backup',
			entityId: file.originalname,
			entityLabel: file.originalname,
			metadata: {
				fileName: file.originalname,
				fileSize: file.size
			},
			request
		});
		expect(databaseRestoreService.restore).toHaveBeenCalledWith(
			file,
			'ВОССТАНОВИТЬ БД'
		);
	});
});
