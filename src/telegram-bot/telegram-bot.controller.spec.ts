import type { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import type { ScheduledTasksService } from '@/maintenance/scheduled-tasks.service';
import { TelegramBotController } from '@/telegram-bot/telegram-bot.controller';
import type { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import { BadRequestException } from '@nestjs/common';
import { ScheduledJobRunStatus } from '@prisma/client';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';

describe('TelegramBotController manual database backup', () => {
	const adminId = randomUUID();
	const idempotencyKey = randomUUID();
	const request = {} as Request;

	const createController = (created: boolean) => {
		const scheduledTasksService = {
			enqueueManualDatabaseBackup: jest.fn().mockResolvedValue({
				target: 'core',
				jobId: randomUUID(),
				status: ScheduledJobRunStatus.QUEUED,
				queuedAt: '2026-07-24T00:00:00.000Z',
				created
			}),
			getLatestActiveManualDatabaseBackup: jest.fn(),
			getDatabaseBackupJob: jest.fn()
		} as unknown as ScheduledTasksService;
		const adminEventLogService = {
			record: jest.fn().mockResolvedValue(undefined)
		} as unknown as AdminEventLogService;
		const controller = new TelegramBotController(
			{} as TelegramBotService,
			adminEventLogService,
			scheduledTasksService
		);

		return {
			controller,
			scheduledTasksService,
			adminEventLogService
		};
	};

	it('requires a UUID Idempotency-Key before enqueueing', async () => {
		const { controller, scheduledTasksService } = createController(true);

		await expect(
			controller.sendDatabaseBackup('core', adminId, undefined, request)
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			controller.sendDatabaseBackup('core', adminId, 'invalid', request)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(
			scheduledTasksService.enqueueManualDatabaseBackup
		).not.toHaveBeenCalled();
	});

	it('records one audit event only for a newly created job', async () => {
		const { controller, scheduledTasksService, adminEventLogService } =
			createController(true);

		const result = await controller.sendDatabaseBackup(
			'core',
			adminId,
			idempotencyKey,
			request
		);

		expect(
			scheduledTasksService.enqueueManualDatabaseBackup
		).toHaveBeenCalledWith('core', adminId, idempotencyKey);
		expect(adminEventLogService.record).toHaveBeenCalledTimes(1);
		expect(result.created).toBe(true);
	});

	it('does not duplicate the audit event for an idempotent replay', async () => {
		const { controller, adminEventLogService } = createController(false);

		const result = await controller.sendDatabaseBackup(
			'core',
			adminId,
			idempotencyKey,
			request
		);

		expect(adminEventLogService.record).not.toHaveBeenCalled();
		expect(result.created).toBe(false);
	});

	it('scopes status lookups to the current administrator', async () => {
		const { controller, scheduledTasksService } = createController(true);
		const jobId = randomUUID();
		(
			scheduledTasksService.getDatabaseBackupJob as jest.Mock
		).mockResolvedValue({
			jobId
		});

		await expect(
			controller.getDatabaseBackupJob('core', jobId, adminId)
		).resolves.toEqual({ jobId });
		expect(
			scheduledTasksService.getDatabaseBackupJob
		).toHaveBeenCalledWith('core', jobId, adminId);

		await controller.getLatestActiveManualDatabaseBackup('core', adminId);
		expect(
			scheduledTasksService.getLatestActiveManualDatabaseBackup
		).toHaveBeenCalledWith('core', adminId);
	});

	it('keeps Notification Delivery manual jobs isolated from core jobs', async () => {
		const { controller, scheduledTasksService, adminEventLogService } =
			createController(true);

		await controller.sendDatabaseBackup(
			'notification-delivery',
			adminId,
			idempotencyKey,
			request
		);

		expect(
			scheduledTasksService.enqueueManualDatabaseBackup
		).toHaveBeenCalledWith(
			'notification-delivery',
			adminId,
			idempotencyKey
		);
		expect(adminEventLogService.record).toHaveBeenCalledWith(
			expect.objectContaining({
				description: expect.stringContaining('Notification Delivery'),
				metadata: expect.objectContaining({
					target: 'notification-delivery'
				})
			})
		);
	});

	it('keeps Reporting manual jobs isolated and records the target', async () => {
		const { controller, scheduledTasksService, adminEventLogService } =
			createController(true);

		await controller.sendDatabaseBackup(
			'reporting',
			adminId,
			idempotencyKey,
			request
		);

		expect(
			scheduledTasksService.enqueueManualDatabaseBackup
		).toHaveBeenCalledWith('reporting', adminId, idempotencyKey);
		expect(adminEventLogService.record).toHaveBeenCalledWith(
			expect.objectContaining({
				description: expect.stringContaining('Reporting'),
				metadata: expect.objectContaining({ target: 'reporting' })
			})
		);
	});

	it('keeps Widgets manual jobs isolated and records the target', async () => {
		const { controller, scheduledTasksService, adminEventLogService } =
			createController(true);

		await controller.sendDatabaseBackup(
			'widgets',
			adminId,
			idempotencyKey,
			request
		);

		expect(
			scheduledTasksService.enqueueManualDatabaseBackup
		).toHaveBeenCalledWith('widgets', adminId, idempotencyKey);
		expect(adminEventLogService.record).toHaveBeenCalledWith(
			expect.objectContaining({
				description: expect.stringContaining('Widgets'),
				metadata: expect.objectContaining({ target: 'widgets' })
			})
		);
	});
});

describe('TelegramBotController schedule audit', () => {
	it('records a rejected direct backup schedule change without values', async () => {
		const error = new BadRequestException('schedule conflict');
		const telegramBotService = {
			updateSettings: jest.fn().mockRejectedValue(error)
		} as unknown as TelegramBotService;
		const adminEventLogService = {
			record: jest.fn().mockResolvedValue(undefined)
		} as unknown as AdminEventLogService;
		const controller = new TelegramBotController(
			telegramBotService,
			adminEventLogService,
			{} as ScheduledTasksService
		);
		const adminId = randomUUID();

		await expect(
			controller.updateSettings(
				{ databaseBackupTime: '01:48' },
				adminId,
				{} as Request
			)
		).rejects.toBe(error);
		expect(adminEventLogService.record).toHaveBeenCalledWith(
			expect.objectContaining({
				adminId,
				action: 'TELEGRAM_SCHEDULE_SETTINGS_REJECTED',
				metadata: { reasonCode: 'SCHEDULE_VALIDATION_FAILED' }
			})
		);
		expect(
			JSON.stringify(
				(adminEventLogService.record as jest.Mock).mock.calls[0][0]
					.metadata
			)
		).not.toContain('01:48');
	});
});
