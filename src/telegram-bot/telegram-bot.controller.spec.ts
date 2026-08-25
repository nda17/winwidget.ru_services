import type { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import type { ScheduledTasksService } from '@/maintenance/scheduled-tasks.service';
import { TelegramBotController } from '@/telegram-bot/telegram-bot.controller';
import type { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import { BadRequestException } from '@nestjs/common';
import {
	Prisma,
	ScheduledJobRunStatus,
	ScheduledJobRunTrigger
} from '@prisma/client';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';

describe('TelegramBotController manual database backup', () => {
	const adminId = randomUUID();
	const idempotencyKey = randomUUID();
	const request = {} as Request;

	const createController = (created: boolean) => {
		const transaction = {
			transactionMarker: 'manual-backup-audit'
		} as unknown as Prisma.TransactionClient;
		const scheduledTasksService = {
			enqueueManualDatabaseBackup: jest.fn(
				async (target, _adminId, _idempotencyKey, writeAudit) => {
					const result = {
						target,
						jobId: randomUUID(),
						status: ScheduledJobRunStatus.QUEUED,
						queuedAt: '2026-07-24T00:00:00.000Z',
						created
					};
					if (created) await writeAudit(transaction, result);
					return result;
				}
			),
			getLatestActiveManualDatabaseBackup: jest.fn(),
			getDatabaseBackupJob: jest.fn(),
			getDatabaseBackupOverview: jest.fn(),
			getDatabaseBackupJobs: jest.fn()
		} as unknown as ScheduledTasksService;
		const record = jest.fn().mockResolvedValue(undefined);
		const adminEventLogService = {
			record,
			recordInTransaction: jest.fn((_transaction, input) => record(input))
		} as unknown as AdminEventLogService;
		const controller = new TelegramBotController(
			{} as TelegramBotService,
			adminEventLogService,
			scheduledTasksService
		);

		return {
			controller,
			scheduledTasksService,
			adminEventLogService,
			transaction
		};
	};

	it('requires a UUID Idempotency-Key before enqueueing', async () => {
		const { controller, scheduledTasksService } = createController(true);

		await expect(
			controller.sendDatabaseBackup(
				'notification-delivery',
				adminId,
				undefined,
				request
			)
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			controller.sendDatabaseBackup(
				'notification-delivery',
				adminId,
				'invalid',
				request
			)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(
			scheduledTasksService.enqueueManualDatabaseBackup
		).not.toHaveBeenCalled();
	});

	it('records one audit event only for a newly created job', async () => {
		const {
			controller,
			scheduledTasksService,
			adminEventLogService,
			transaction
		} = createController(true);

		const result = await controller.sendDatabaseBackup(
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
			idempotencyKey,
			expect.any(Function)
		);
		expect(adminEventLogService.recordInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.any(Object)
		);
		expect(adminEventLogService.record).toHaveBeenCalledTimes(1);
		expect(result.created).toBe(true);
	});

	it('does not duplicate the audit event for an idempotent replay', async () => {
		const { controller, adminEventLogService } = createController(false);

		const result = await controller.sendDatabaseBackup(
			'notification-delivery',
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
			controller.getDatabaseBackupJob(
				'notification-delivery',
				jobId,
				adminId
			)
		).resolves.toEqual({ jobId });
		expect(
			scheduledTasksService.getDatabaseBackupJob
		).toHaveBeenCalledWith('notification-delivery', jobId, adminId);

		await controller.getLatestActiveManualDatabaseBackup(
			'notification-delivery',
			adminId
		);
		expect(
			scheduledTasksService.getLatestActiveManualDatabaseBackup
		).toHaveBeenCalledWith('notification-delivery', adminId);
	});

	it('keeps Notification Delivery manual jobs isolated by target', async () => {
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
			idempotencyKey,
			expect.any(Function)
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
		).toHaveBeenCalledWith(
			'reporting',
			adminId,
			idempotencyKey,
			expect.any(Function)
		);
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
		).toHaveBeenCalledWith(
			'widgets',
			adminId,
			idempotencyKey,
			expect.any(Function)
		);
		expect(adminEventLogService.record).toHaveBeenCalledWith(
			expect.objectContaining({
				description: expect.stringContaining('Widgets'),
				metadata: expect.objectContaining({ target: 'widgets' })
			})
		);
	});

	it('keeps Platform manual jobs isolated and records the target', async () => {
		const { controller, scheduledTasksService, adminEventLogService } =
			createController(true);

		await controller.sendDatabaseBackup(
			'platform',
			adminId,
			idempotencyKey,
			request
		);

		expect(
			scheduledTasksService.enqueueManualDatabaseBackup
		).toHaveBeenCalledWith(
			'platform',
			adminId,
			idempotencyKey,
			expect.any(Function)
		);
		expect(adminEventLogService.record).toHaveBeenCalledWith(
			expect.objectContaining({
				description: expect.stringContaining('Platform'),
				metadata: expect.objectContaining({ target: 'platform' })
			})
		);
	});

	it('keeps Operations manual jobs isolated and records the target', async () => {
		const { controller, scheduledTasksService, adminEventLogService } =
			createController(true);

		await controller.sendDatabaseBackup(
			'operations',
			adminId,
			idempotencyKey,
			request
		);

		expect(
			scheduledTasksService.enqueueManualDatabaseBackup
		).toHaveBeenCalledWith(
			'operations',
			adminId,
			idempotencyKey,
			expect.any(Function)
		);
		expect(adminEventLogService.record).toHaveBeenCalledWith(
			expect.objectContaining({
				description: expect.stringContaining('Operations'),
				metadata: expect.objectContaining({ target: 'operations' })
			})
		);
	});

	it('exposes the redacted overview and validates history filters', async () => {
		const { controller, scheduledTasksService } = createController(true);
		(
			scheduledTasksService.getDatabaseBackupOverview as jest.Mock
		).mockResolvedValue({ items: [] });
		(
			scheduledTasksService.getDatabaseBackupJobs as jest.Mock
		).mockResolvedValue({ items: [], page: 2, totalPages: 1 });

		await expect(controller.getDatabaseBackupOverview()).resolves.toEqual({
			items: []
		});
		await expect(
			controller.getDatabaseBackupJobs(
				'2',
				'25',
				'identity',
				'MANUAL',
				'SUCCEEDED'
			)
		).resolves.toEqual({ items: [], page: 2, totalPages: 1 });
		expect(
			scheduledTasksService.getDatabaseBackupJobs
		).toHaveBeenCalledWith({
			page: 2,
			limit: 25,
			target: 'identity',
			trigger: ScheduledJobRunTrigger.MANUAL,
			status: ScheduledJobRunStatus.SUCCEEDED
		});
		expect(() => controller.getDatabaseBackupJobs('0', '20')).toThrow(
			BadRequestException
		);
		expect(() => controller.getDatabaseBackupJobs('1', '101')).toThrow(
			BadRequestException
		);
		expect(() =>
			controller.getDatabaseBackupJobs('2147483648', '2')
		).toThrow(BadRequestException);
		expect(() =>
			controller.getDatabaseBackupJobs(
				'1',
				'20',
				'unknown',
				'MANUAL',
				'SUCCEEDED'
			)
		).toThrow(BadRequestException);
		expect(() =>
			controller.getDatabaseBackupJobs(
				'1',
				'20',
				'identity',
				'UNKNOWN',
				'SUCCEEDED'
			)
		).toThrow(BadRequestException);
		expect(() =>
			controller.getDatabaseBackupJobs(
				'1',
				'20',
				'identity',
				'MANUAL',
				'UNKNOWN'
			)
		).toThrow(BadRequestException);
	});
});

describe('TelegramBotController schedule audit', () => {
	it('writes a successful settings audit through the service transaction', async () => {
		const transaction = {
			transactionMarker: 'telegram-settings-audit'
		} as unknown as Prisma.TransactionClient;
		const settings = {
			dailySummaryChatId: '-100123',
			databaseBackupThreadId: 2,
			paymentsThreadId: 3,
			operationalAlertsThreadId: 4,
			databaseBackupEnabled: true,
			databaseBackupTime: '01:45',
			telegramBotTokenConfigured: true,
			telegramBotUsernameConfigured: true
		};
		const telegramBotService = {
			updateSettings: jest.fn(async (_dto, writeAudit) => {
				await writeAudit(transaction, settings);
				return settings;
			})
		} as unknown as TelegramBotService;
		const adminEventLogService = {
			recordInTransaction: jest.fn().mockResolvedValue(undefined)
		} as unknown as AdminEventLogService;
		const controller = new TelegramBotController(
			telegramBotService,
			adminEventLogService,
			{} as ScheduledTasksService
		);
		const adminId = randomUUID();

		await expect(
			controller.updateSettings(
				{ operationalAlertsThreadId: 4 },
				adminId,
				{} as Request
			)
		).resolves.toEqual(settings);
		expect(adminEventLogService.recordInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				adminId,
				action: 'TELEGRAM_BOT_SETTINGS_UPDATE'
			})
		);
	});

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
