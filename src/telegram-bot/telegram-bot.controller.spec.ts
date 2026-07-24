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
			controller.sendDatabaseBackup(adminId, undefined, request)
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			controller.sendDatabaseBackup(adminId, 'invalid', request)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(
			scheduledTasksService.enqueueManualDatabaseBackup
		).not.toHaveBeenCalled();
	});

	it('records one audit event only for a newly created job', async () => {
		const { controller, scheduledTasksService, adminEventLogService } =
			createController(true);

		const result = await controller.sendDatabaseBackup(
			adminId,
			idempotencyKey,
			request
		);

		expect(
			scheduledTasksService.enqueueManualDatabaseBackup
		).toHaveBeenCalledWith(adminId, idempotencyKey);
		expect(adminEventLogService.record).toHaveBeenCalledTimes(1);
		expect(result.created).toBe(true);
	});

	it('does not duplicate the audit event for an idempotent replay', async () => {
		const { controller, adminEventLogService } = createController(false);

		const result = await controller.sendDatabaseBackup(
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
			controller.getDatabaseBackupJob(jobId, adminId)
		).resolves.toEqual({ jobId });
		expect(
			scheduledTasksService.getDatabaseBackupJob
		).toHaveBeenCalledWith(jobId, adminId);

		await controller.getLatestActiveManualDatabaseBackup(adminId);
		expect(
			scheduledTasksService.getLatestActiveManualDatabaseBackup
		).toHaveBeenCalledWith(adminId);
	});
});
