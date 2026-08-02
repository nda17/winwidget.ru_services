import type { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import type { DatabaseRestoreQueueService } from '@/dev-tools/database-restore-queue.service';
import type { DatabaseRestoreService } from '@/dev-tools/database-restore.service';
import { DevToolsController } from '@/dev-tools/dev-tools.controller';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';

describe('DevToolsController database restore', () => {
	const adminId = randomUUID();
	const request = {} as Request;
	const jobId = randomUUID();
	const file = {
		buffer: Buffer.from('database-backup'),
		originalname: 'winwidget.dump',
		size: 15
	} as Express.Multer.File;

	const createController = () => {
		const queuedJob = {
			jobId,
			target: 'reporting' as const,
			status: 'QUEUED' as const,
			originalFileName: file.originalname,
			fileSize: file.size,
			sha256: 'a'.repeat(64),
			requestedAt: '2026-07-31T10:00:00.000Z',
			startedAt: null,
			finishedAt: null,
			attempt: 0,
			error: null,
			canCancel: true,
			cancellationPending: false,
			cancellationRequested: false
		};
		const databaseRestoreService = {
			getSettings: jest.fn().mockReturnValue({
				confirmation: 'ВОССТАНОВИТЬ БД'
			}),
			restore: jest.fn().mockResolvedValue({
				restored: true
			})
		} as unknown as DatabaseRestoreService;
		const databaseRestoreQueueService = {
			getSettings: jest.fn().mockResolvedValue({
				enabled: true,
				approved: {
					target: 'reporting',
					jobId,
					expiresAt: '2026-08-02T12:00:00.000Z'
				},
				maxFileSizeBytes: 49 * 1024 * 1024,
				allowedFileExtension: '.dump',
				targets: []
			}),
			getJob: jest.fn().mockResolvedValue({
				jobId,
				target: 'reporting',
				status: 'PROCESSING'
			}),
			enqueue: jest.fn(
				async (
					_target,
					_file,
					_confirmation,
					_requestedBy,
					beforePublish,
					_requestedJobId,
					afterPublish
				) => {
					await beforePublish(queuedJob);
					await afterPublish({
						job: queuedJob,
						manifestStatus: 'QUEUED',
						manifestSignature: 'b'.repeat(64),
						productionPermit: {
							appRevision: 'c'.repeat(40),
							expiresAt: '2026-08-02T12:00:00.000Z',
							runId: 'run-2026-08-02',
							evidence: 'evidence-restore-rehearsal',
							incident: 'incident-2024',
							permitSignature: 'd'.repeat(64)
						}
					});
					return queuedJob;
				}
			),
			cancel: jest.fn(async (_jobId, beforeCancel) => {
				await beforeCancel({
					...queuedJob,
					canCancel: false,
					cancellationPending: true
				});
				return {
					...queuedJob,
					canCancel: false,
					cancellationPending: false,
					cancellationRequested: true
				};
			})
		} as unknown as DatabaseRestoreQueueService;
		const adminEventLogService = {
			record: jest.fn().mockResolvedValue({ id: randomUUID() }),
			recordOnce: jest.fn().mockImplementation(async recordId => ({
				id: recordId
			}))
		} as unknown as AdminEventLogService;

		return {
			controller: new DevToolsController(
				databaseRestoreService,
				databaseRestoreQueueService,
				adminEventLogService
			),
			databaseRestoreService,
			databaseRestoreQueueService,
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

	it('returns async restore settings and delegates DEV-only job reads', async () => {
		const { controller, databaseRestoreQueueService } = createController();

		await expect(
			controller.getDatabaseRestoreQueueSettings()
		).resolves.toEqual({
			enabled: true,
			approved: {
				target: 'reporting',
				jobId,
				expiresAt: '2026-08-02T12:00:00.000Z'
			},
			maxFileSizeBytes: 49 * 1024 * 1024,
			allowedFileExtension: '.dump',
			targets: []
		});
		await expect(controller.getDatabaseRestoreJob(jobId)).resolves.toEqual(
			{
				jobId,
				target: 'reporting',
				status: 'PROCESSING'
			}
		);
		expect(databaseRestoreQueueService.getSettings).toHaveBeenCalledTimes(
			1
		);
		expect(databaseRestoreQueueService.getJob).toHaveBeenCalledWith(jobId);
	});

	it('audits an async target restore before queue publication', async () => {
		const {
			controller,
			databaseRestoreQueueService,
			adminEventLogService
		} = createController();

		await expect(
			controller.enqueueDatabaseRestore(
				'reporting',
				file,
				{
					confirmation: 'ВОССТАНОВИТЬ REPORTING',
					requestId: jobId
				},
				adminId,
				request
			)
		).resolves.toMatchObject({
			jobId,
			target: 'reporting',
			status: 'QUEUED'
		});
		expect(databaseRestoreQueueService.enqueue).toHaveBeenCalledWith(
			'reporting',
			file,
			'ВОССТАНОВИТЬ REPORTING',
			adminId,
			expect.any(Function),
			jobId,
			expect.any(Function)
		);
		expect(adminEventLogService.record).toHaveBeenCalledWith({
			adminId,
			section: 'DEV_TOOLS',
			action: 'DEV_DATABASE_RESTORE',
			description:
				'DEV запросил восстановление базы reporting через защищённую очередь',
			entityType: 'database_restore_job',
			entityId: jobId,
			entityLabel: file.originalname,
			metadata: {
				jobId,
				target: 'reporting',
				requestedStatus: 'QUEUED',
				queuePublication: 'PENDING',
				fileName: file.originalname,
				fileSize: file.size,
				sha256: 'a'.repeat(64)
			},
			request
		});
		expect(adminEventLogService.recordOnce).toHaveBeenCalledWith(
			`database_restore_publish_${jobId}`,
			{
				adminId,
				section: 'DEV_TOOLS',
				action: 'DEV_DATABASE_RESTORE_PUBLISHED',
				description:
					'Подписанное задание восстановления базы reporting опубликовано в защищённую очередь',
				entityType: 'database_restore_job',
				entityId: jobId,
				entityLabel: file.originalname,
				metadata: {
					jobId,
					target: 'reporting',
					publishedStatus: 'QUEUED',
					queuePublication: 'CONFIRMED',
					manifestSignature: 'b'.repeat(64),
					appRevision: 'c'.repeat(40),
					permitExpiresAt: '2026-08-02T12:00:00.000Z',
					runId: 'run-2026-08-02',
					evidence: 'evidence-restore-rehearsal',
					incident: 'incident-2024'
				},
				request
			}
		);
	});

	it('audits cancellation after reservation and before acceptance', async () => {
		const {
			controller,
			databaseRestoreQueueService,
			adminEventLogService
		} = createController();

		await expect(
			controller.cancelDatabaseRestoreJob(jobId, adminId, request)
		).resolves.toMatchObject({
			jobId,
			canCancel: false,
			cancellationPending: false,
			cancellationRequested: true
		});
		expect(databaseRestoreQueueService.cancel).toHaveBeenCalledWith(
			jobId,
			expect.any(Function)
		);
		expect(adminEventLogService.record).toHaveBeenCalledWith({
			adminId,
			section: 'DEV_TOOLS',
			action: 'DEV_DATABASE_RESTORE',
			description:
				'DEV запросил отмену восстановления базы reporting до начала защищённой фазы',
			entityType: 'database_restore_job',
			entityId: jobId,
			entityLabel: file.originalname,
			metadata: {
				jobId,
				target: 'reporting',
				status: 'QUEUED',
				fileName: file.originalname,
				sha256: 'a'.repeat(64),
				cancellationRequested: true
			},
			request
		});
	});

	it('fails before queue publication when audit persistence fails', async () => {
		const { controller, adminEventLogService } = createController();
		jest.spyOn(adminEventLogService, 'record').mockResolvedValueOnce(null);

		await expect(
			controller.enqueueDatabaseRestore(
				'reporting',
				file,
				{ confirmation: 'ВОССТАНОВИТЬ REPORTING' },
				adminId,
				request
			)
		).rejects.toThrow(
			'Не удалось записать восстановление в журнал событий'
		);
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
			description:
				'DEV запросил legacy-восстановление основной базы из backup',
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
