import {
	DATABASE_RESTORE_MAX_FILE_SIZE_BYTES,
	DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION,
	parseAndVerifyDatabaseRestoreJobManifest,
	parseAndVerifyDatabaseRestoreGlobalGate,
	parseAndVerifyDatabaseRestorePublishReceipt,
	parseAndVerifyDatabaseRestoreTargetLock,
	parseAndVerifyDatabaseRestoreTransitionGate,
	signDatabaseRestoreGlobalGate,
	signDatabaseRestoreJobPayload,
	signDatabaseRestoreProductionPermit,
	signDatabaseRestoreTargetLock
} from '@/dev-tools/database-restore-queue.contract';
import {
	type DatabaseRestoreBeforeCancel,
	type DatabaseRestoreBeforePublish,
	DatabaseRestoreQueueService
} from '@/dev-tools/database-restore-queue.service';
import {
	BadRequestException,
	ConflictException,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('DatabaseRestoreQueueService', () => {
	const originalStorageDir = process.env.DATABASE_RESTORE_STORAGE_DIR;
	const originalQueueSecret = process.env.DATABASE_RESTORE_QUEUE_SECRET;
	const originalMode = process.env.MODE;
	const originalProductionEnabled =
		process.env.DATABASE_RESTORE_PRODUCTION_ENABLED;
	const originalProductionPermit =
		process.env.DATABASE_RESTORE_PRODUCTION_PERMIT;
	const originalAppRevision = process.env.APP_REVISION;
	const queueSecret = 'restore-queue-test-secret-32-characters';
	const appRevision = 'c'.repeat(40);
	let storageDir: string;
	let service: DatabaseRestoreQueueService;
	let beforePublish: jest.MockedFunction<DatabaseRestoreBeforePublish>;

	const createFile = (
		overrides: Partial<Express.Multer.File> = {}
	): Express.Multer.File => {
		const buffer = overrides.buffer ?? Buffer.from('database-backup');
		return {
			buffer,
			originalname: 'reporting.dump',
			size: buffer.length,
			...overrides
		} as Express.Multer.File;
	};

	beforeEach(async () => {
		storageDir = await mkdtemp(join(tmpdir(), 'winwidget-restore-queue-'));
		process.env.DATABASE_RESTORE_STORAGE_DIR = storageDir;
		process.env.DATABASE_RESTORE_QUEUE_SECRET = queueSecret;
		process.env.MODE = 'development';
		delete process.env.DATABASE_RESTORE_PRODUCTION_ENABLED;
		delete process.env.DATABASE_RESTORE_PRODUCTION_PERMIT;
		process.env.APP_REVISION = appRevision;
		service = new DatabaseRestoreQueueService();
		beforePublish = jest.fn().mockResolvedValue(undefined);
	});

	afterEach(async () => {
		jest.restoreAllMocks();
		await rm(storageDir, { recursive: true, force: true });
		if (originalStorageDir === undefined) {
			delete process.env.DATABASE_RESTORE_STORAGE_DIR;
		} else {
			process.env.DATABASE_RESTORE_STORAGE_DIR = originalStorageDir;
		}
		if (originalQueueSecret === undefined) {
			delete process.env.DATABASE_RESTORE_QUEUE_SECRET;
		} else {
			process.env.DATABASE_RESTORE_QUEUE_SECRET = originalQueueSecret;
		}
		if (originalMode === undefined) delete process.env.MODE;
		else process.env.MODE = originalMode;
		if (originalProductionEnabled === undefined) {
			delete process.env.DATABASE_RESTORE_PRODUCTION_ENABLED;
		} else {
			process.env.DATABASE_RESTORE_PRODUCTION_ENABLED =
				originalProductionEnabled;
		}
		if (originalProductionPermit === undefined) {
			delete process.env.DATABASE_RESTORE_PRODUCTION_PERMIT;
		} else {
			process.env.DATABASE_RESTORE_PRODUCTION_PERMIT =
				originalProductionPermit;
		}
		if (originalAppRevision === undefined) delete process.env.APP_REVISION;
		else process.env.APP_REVISION = originalAppRevision;
	});

	it('returns target-specific settings with a safe payload limit', async () => {
		await expect(service.getSettings()).resolves.toEqual({
			enabled: true,
			approved: null,
			maxFileSizeBytes: 49 * 1024 * 1024,
			allowedFileExtension: '.dump',
			targets: [
				{
					id: 'core',
					label: 'Основная БД',
					confirmation: 'ВОССТАНОВИТЬ CORE'
				},
				{
					id: 'notification-delivery',
					label: 'Notification Delivery',
					confirmation: 'ВОССТАНОВИТЬ NOTIFICATION DELIVERY'
				},
				{
					id: 'campaigns',
					label: 'Campaigns',
					confirmation: 'ВОССТАНОВИТЬ CAMPAIGNS'
				},
				{
					id: 'reporting',
					label: 'Reporting',
					confirmation: 'ВОССТАНОВИТЬ REPORTING'
				},
				{
					id: 'widgets',
					label: 'Widgets',
					confirmation: 'ВОССТАНОВИТЬ WIDGETS'
				},
				{
					id: 'billing',
					label: 'Billing',
					confirmation: 'ВОССТАНОВИТЬ BILLING'
				}
			]
		});
	});

	it('keeps new production restores disabled while reads and safe cancellation remain available', async () => {
		process.env.MODE = 'production';
		delete process.env.DATABASE_RESTORE_PRODUCTION_ENABLED;

		await expect(service.getSettings()).resolves.toMatchObject({
			enabled: false,
			approved: null
		});
		await expect(
			service.enqueue(
				'reporting',
				createFile(),
				'ВОССТАНОВИТЬ REPORTING',
				'clrestoreadmin123',
				beforePublish
			)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
		expect(beforePublish).not.toHaveBeenCalled();

		process.env.DATABASE_RESTORE_PRODUCTION_ENABLED = ' true ';
		await expect(service.getSettings()).resolves.toMatchObject({
			enabled: false,
			approved: null
		});

		process.env.DATABASE_RESTORE_PRODUCTION_ENABLED = 'true';
		await expect(service.getSettings()).resolves.toMatchObject({
			enabled: false,
			approved: null
		});
		const jobId = '00000000-0000-4000-8000-000000000210';
		const expiresAt = new Date(Date.now() + 60_000).toISOString();
		const permit = signDatabaseRestoreProductionPermit(
			{
				version: DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION,
				kind: 'DATABASE_RESTORE_PRODUCTION_PERMIT',
				appRevision,
				target: 'reporting',
				jobId,
				expiresAt,
				runId: 'run-2026-08-02',
				evidence: 'four-target-rehearsal-evidence',
				incident: 'incident-2024'
			},
			queueSecret
		);
		process.env.DATABASE_RESTORE_PRODUCTION_PERMIT =
			JSON.stringify(permit);
		await expect(service.getSettings()).resolves.toMatchObject({
			enabled: true,
			approved: { target: 'reporting', jobId, expiresAt }
		});
		const afterPublish = jest.fn().mockResolvedValue({
			auditEventId: `database_restore_publish_${jobId}`
		});
		const job = await service.enqueue(
			'reporting',
			createFile(),
			'ВОССТАНОВИТЬ REPORTING',
			'clrestoreadmin123',
			beforePublish,
			jobId,
			afterPublish
		);
		expect(job).toMatchObject({
			status: 'QUEUED',
			target: 'reporting',
			publicationConfirmed: true
		});
		expect(afterPublish).toHaveBeenCalledWith(
			expect.objectContaining({
				job: expect.objectContaining({ jobId, target: 'reporting' }),
				manifestStatus: 'QUEUED',
				manifestSignature: expect.stringMatching(/^[0-9a-f]{64}$/),
				productionPermit: expect.objectContaining({
					appRevision,
					expiresAt,
					runId: 'run-2026-08-02',
					evidence: 'four-target-rehearsal-evidence',
					incident: 'incident-2024'
				})
			})
		);
		expect(
			parseAndVerifyDatabaseRestorePublishReceipt(
				await readFile(
					join(storageDir, 'receipts', `${jobId}.json`),
					'utf8'
				),
				queueSecret
			)
		).toMatchObject({
			jobId,
			target: 'reporting',
			manifestStatus: 'QUEUED',
			auditEventId: `database_restore_publish_${jobId}`,
			appRevision,
			permitSignature: permit.signature
		});
		expect(
			JSON.parse(
				await readFile(
					join(storageDir, 'permits', `${jobId}.consumed.json`),
					'utf8'
				)
			)
		).toEqual(permit);
		await expect(
			readFile(join(storageDir, 'permits', 'active.json'), 'utf8')
		).rejects.toMatchObject({ code: 'ENOENT' });
		expect(
			parseAndVerifyDatabaseRestoreGlobalGate(
				await readFile(join(storageDir, 'locks', 'global.lock'), 'utf8'),
				queueSecret
			)
		).toMatchObject({ jobId, target: 'reporting' });
		await expect(service.getSettings()).resolves.toMatchObject({
			enabled: false,
			approved: { target: 'reporting', jobId, expiresAt }
		});

		process.env.DATABASE_RESTORE_PRODUCTION_ENABLED = 'false';
		await expect(service.getSettings()).resolves.toMatchObject({
			enabled: false,
			approved: null
		});
		await expect(service.getJob(job.jobId)).resolves.toMatchObject({
			jobId: job.jobId,
			canCancel: true,
			publicationConfirmed: true
		});
		await expect(
			service.cancel(job.jobId, jest.fn().mockResolvedValue(undefined))
		).resolves.toMatchObject({
			jobId: job.jobId,
			cancellationRequested: true
		});

		await expect(
			service.enqueue(
				'core',
				createFile({ originalname: 'core.dump' }),
				'ВОССТАНОВИТЬ CORE',
				'clrestoreadmin123',
				beforePublish,
				undefined,
				afterPublish
			)
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('retries the exact production publication after the manifest was made durable', async () => {
		process.env.MODE = 'production';
		process.env.DATABASE_RESTORE_PRODUCTION_ENABLED = 'true';
		const jobId = '00000000-0000-4000-8000-000000000212';
		const permit = signDatabaseRestoreProductionPermit(
			{
				version: DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION,
				kind: 'DATABASE_RESTORE_PRODUCTION_PERMIT',
				appRevision,
				target: 'reporting',
				jobId,
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
				runId: 'run-publication-recovery',
				evidence: 'restore-publication-crash-boundary',
				incident: 'incident-2024'
			},
			queueSecret
		);
		process.env.DATABASE_RESTORE_PRODUCTION_PERMIT =
			JSON.stringify(permit);
		const file = createFile();
		const failedPublish = jest
			.fn()
			.mockRejectedValue(new Error('simulated audit persistence failure'));

		await expect(
			service.enqueue(
				'reporting',
				file,
				'ВОССТАНОВИТЬ REPORTING',
				'clrestoreadmin123',
				beforePublish,
				jobId,
				failedPublish
			)
		).rejects.toThrow('simulated audit persistence failure');
		await expect(service.getJob(jobId)).resolves.toMatchObject({
			jobId,
			status: 'QUEUED',
			publicationConfirmed: false
		});
		await expect(
			readFile(join(storageDir, 'receipts', `${jobId}.json`), 'utf8')
		).rejects.toMatchObject({ code: 'ENOENT' });
		expect(
			parseAndVerifyDatabaseRestoreGlobalGate(
				await readFile(join(storageDir, 'locks', 'global.lock'), 'utf8'),
				queueSecret
			)
		).toMatchObject({ jobId, target: 'reporting' });

		const confirmed = await service.enqueue(
			'reporting',
			file,
			'ВОССТАНОВИТЬ REPORTING',
			'clrestoreadmin123',
			beforePublish,
			jobId,
			jest.fn().mockResolvedValue({
				auditEventId: `database_restore_publish_${jobId}`
			})
		);
		expect(confirmed).toMatchObject({
			jobId,
			status: 'QUEUED',
			publicationConfirmed: true
		});
		expect(beforePublish).toHaveBeenCalledTimes(1);
		await expect(
			readFile(join(storageDir, 'permits', 'active.json'), 'utf8')
		).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('fails closed for tampered, stale, expired or mismatched production permits', async () => {
		process.env.MODE = 'production';
		process.env.DATABASE_RESTORE_PRODUCTION_ENABLED = 'true';
		const jobId = '00000000-0000-4000-8000-000000000211';
		const createPermit = (
			overrides: Partial<
				Parameters<typeof signDatabaseRestoreProductionPermit>[0]
			> = {}
		) =>
			signDatabaseRestoreProductionPermit(
				{
					version: DATABASE_RESTORE_PRODUCTION_PERMIT_VERSION,
					kind: 'DATABASE_RESTORE_PRODUCTION_PERMIT',
					appRevision,
					target: 'reporting',
					jobId,
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
					runId: 'run-2026-08-02',
					evidence: 'four-target-rehearsal-evidence',
					incident: 'incident-2024',
					...overrides
				},
				queueSecret
			);
		const valid = createPermit();
		process.env.DATABASE_RESTORE_PRODUCTION_PERMIT = JSON.stringify({
			...valid,
			target: 'core'
		});
		await expect(service.getSettings()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);

		process.env.DATABASE_RESTORE_PRODUCTION_PERMIT = JSON.stringify(
			createPermit({ appRevision: 'd'.repeat(40) })
		);
		await expect(service.getSettings()).rejects.toThrow('другой ревизии');

		process.env.DATABASE_RESTORE_PRODUCTION_PERMIT = JSON.stringify(
			createPermit({
				expiresAt: new Date(Date.now() - 1_000).toISOString()
			})
		);
		await expect(
			service.enqueue(
				'reporting',
				createFile(),
				'ВОССТАНОВИТЬ REPORTING',
				'clrestoreadmin123',
				beforePublish,
				jobId,
				jest.fn().mockResolvedValue({ auditEventId: 'publish-audit' })
			)
		).rejects.toThrow('permit истёк');

		process.env.DATABASE_RESTORE_PRODUCTION_PERMIT = JSON.stringify(valid);
		await expect(
			service.enqueue(
				'core',
				createFile({ originalname: 'core.dump' }),
				'ВОССТАНОВИТЬ CORE',
				'clrestoreadmin123',
				beforePublish,
				jobId,
				jest.fn().mockResolvedValue({ auditEventId: 'publish-audit' })
			)
		).rejects.toBeInstanceOf(ConflictException);
		expect(await readdir(join(storageDir, 'locks'))).toEqual([]);
		expect(await readdir(join(storageDir, 'permits'))).toEqual([]);
	});

	it('atomically stages the dump and signed queued manifest', async () => {
		const file = createFile();

		const job = await service.enqueue(
			'reporting',
			file,
			'ВОССТАНОВИТЬ REPORTING',
			'clrestoreadmin123',
			beforePublish
		);

		expect(job).toEqual({
			jobId: expect.any(String),
			target: 'reporting',
			status: 'QUEUED',
			originalFileName: file.originalname,
			fileSize: file.size,
			sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			requestedAt: expect.any(String),
			startedAt: null,
			finishedAt: null,
			attempt: 0,
			error: null,
			canCancel: true,
			cancellationPending: false,
			cancellationRequested: false,
			publicationConfirmed: false
		});
		expect(
			await readFile(join(storageDir, 'uploads', `${job.jobId}.dump`))
		).toEqual(file.buffer);
		const rawManifest = await readFile(
			join(storageDir, 'queued', `${job.jobId}.json`),
			'utf8'
		);
		expect(rawManifest).not.toContain('ВОССТАНОВИТЬ');
		const manifest = parseAndVerifyDatabaseRestoreJobManifest(
			rawManifest,
			queueSecret
		);
		expect(manifest).toMatchObject({
			jobId: job.jobId,
			target: 'reporting',
			status: 'QUEUED',
			uploadFileName: `${job.jobId}.dump`,
			requestedBy: 'clrestoreadmin123'
		});
		expect(beforePublish).toHaveBeenCalledWith(job);
		expect(
			parseAndVerifyDatabaseRestoreTargetLock(
				await readFile(
					join(storageDir, 'locks', 'reporting.lock'),
					'utf8'
				),
				queueSecret
			)
		).toMatchObject({
			target: 'reporting',
			jobId: job.jobId,
			createdAt: job.requestedAt
		});
		expect(
			parseAndVerifyDatabaseRestoreTransitionGate(
				await readFile(
					join(storageDir, 'gates', `${job.jobId}.cancellable`),
					'utf8'
				),
				queueSecret
			)
		).toMatchObject({
			kind: 'DATABASE_RESTORE_TRANSITION_GATE',
			target: 'reporting',
			jobId: job.jobId,
			createdAt: job.requestedAt
		});
		await expect(service.getJob(job.jobId)).resolves.toEqual(job);
		expect(await readdir(join(storageDir, 'processing'))).toEqual([]);
		expect(await readdir(join(storageDir, 'terminal'))).toEqual([]);
	});

	it('uses an exact client requestId and handles a repeated identical request idempotently', async () => {
		const requestId = '00000000-0000-4000-8000-000000000111';
		const file = createFile();
		const job = await service.enqueue(
			'reporting',
			file,
			'ВОССТАНОВИТЬ REPORTING',
			'clrestoreadmin123',
			beforePublish,
			requestId
		);

		expect(job.jobId).toBe(requestId);
		const duplicateAudit = jest.fn().mockResolvedValue(undefined);
		await expect(
			service.enqueue(
				'reporting',
				file,
				'ВОССТАНОВИТЬ REPORTING',
				'clrestoreadmin123',
				duplicateAudit,
				requestId
			)
		).resolves.toEqual(job);
		expect(duplicateAudit).not.toHaveBeenCalled();
		expect(beforePublish).toHaveBeenCalledTimes(1);

		await expect(
			service.enqueue(
				'reporting',
				createFile({ buffer: Buffer.from('another-backup') }),
				'ВОССТАНОВИТЬ REPORTING',
				'clrestoreadmin123',
				duplicateAudit,
				requestId
			)
		).rejects.toBeInstanceOf(ConflictException);
		await expect(
			service.enqueue(
				'core',
				createFile({ originalname: 'core.dump' }),
				'ВОССТАНОВИТЬ CORE',
				'clrestoreadmin123',
				duplicateAudit,
				'not-a-request-id'
			)
		).rejects.toBeInstanceOf(BadRequestException);
	});

	it('never lets a concurrent duplicate delete the winning request artifacts', async () => {
		const requestId = '00000000-0000-4000-8000-000000000112';
		const file = createFile();
		let releaseAudit!: () => void;
		let markAuditEntered!: () => void;
		const auditEntered = new Promise<void>(resolve => {
			markAuditEntered = resolve;
		});
		const heldAudit = jest.fn(async () => {
			markAuditEntered();
			await new Promise<void>(resolve => {
				releaseAudit = resolve;
			});
		});

		const winningRequest = service.enqueue(
			'reporting',
			file,
			'ВОССТАНОВИТЬ REPORTING',
			'clrestoreadmin123',
			heldAudit,
			requestId
		);
		await auditEntered;

		try {
			await expect(
				service.enqueue(
					'reporting',
					file,
					'ВОССТАНОВИТЬ REPORTING',
					'clrestoreadmin123',
					jest.fn().mockResolvedValue(undefined),
					requestId
				)
			).rejects.toBeInstanceOf(ConflictException);
			expect(
				await readFile(
					join(storageDir, 'queued', `.${requestId}.staged`),
					'utf8'
				)
			).toContain(requestId);
		} finally {
			releaseAudit();
		}

		const job = await winningRequest;
		await expect(service.getJob(requestId)).resolves.toEqual(job);
		expect(await readdir(join(storageDir, 'queued'))).toEqual([
			`${requestId}.json`
		]);
		expect(await readdir(join(storageDir, 'uploads'))).toEqual([
			`${requestId}.dump`
		]);
		expect(heldAudit).toHaveBeenCalledTimes(1);
	});

	it('atomically requests cancellation while the job is still cancellable', async () => {
		const job = await service.enqueue(
			'reporting',
			createFile(),
			'ВОССТАНОВИТЬ REPORTING',
			'clrestoreadmin123',
			beforePublish
		);
		const beforeCancel: jest.MockedFunction<DatabaseRestoreBeforeCancel> =
			jest.fn(async pendingJob => {
				expect(pendingJob).toMatchObject({
					jobId: job.jobId,
					canCancel: false,
					cancellationPending: true,
					cancellationRequested: false
				});
				expect(await readdir(join(storageDir, 'gates'))).toEqual([
					`${job.jobId}.cancel-pending`
				]);
				await expect(service.getJob(job.jobId)).resolves.toMatchObject({
					canCancel: false,
					cancellationPending: true,
					cancellationRequested: false
				});
			});

		await expect(
			service.cancel(job.jobId, beforeCancel)
		).resolves.toMatchObject({
			jobId: job.jobId,
			status: 'QUEUED',
			canCancel: false,
			cancellationPending: false,
			cancellationRequested: true
		});
		expect(beforeCancel).toHaveBeenCalledTimes(1);
		expect(await readdir(join(storageDir, 'gates'))).toEqual([
			`${job.jobId}.cancelled`
		]);
		await expect(service.getJob(job.jobId)).resolves.toMatchObject({
			canCancel: false,
			cancellationPending: false,
			cancellationRequested: true
		});
	});

	it('does not cross a destructive transition or bypass cancellation audit', async () => {
		const job = await service.enqueue(
			'campaigns',
			createFile({ originalname: 'campaigns.dump' }),
			'ВОССТАНОВИТЬ CAMPAIGNS',
			'clrestoreadmin123',
			beforePublish
		);
		const failingAudit = jest
			.fn()
			.mockRejectedValue(new Error('audit unavailable'));

		await expect(service.cancel(job.jobId, failingAudit)).rejects.toThrow(
			'audit unavailable'
		);
		expect(await readdir(join(storageDir, 'gates'))).toEqual([
			`${job.jobId}.cancellable`
		]);

		await rename(
			join(storageDir, 'gates', `${job.jobId}.cancellable`),
			join(storageDir, 'gates', `${job.jobId}.destructive`)
		);
		const lateAudit = jest.fn().mockResolvedValue(undefined);
		await expect(
			service.cancel(job.jobId, lateAudit)
		).rejects.toBeInstanceOf(ConflictException);
		expect(lateAudit).not.toHaveBeenCalled();
		await expect(service.getJob(job.jobId)).resolves.toMatchObject({
			canCancel: false,
			cancellationPending: false,
			cancellationRequested: false
		});
	});

	it('blocks a new job while a signed durable fence remains', async () => {
		const missingJobId = '00000000-0000-4000-8000-000000000001';
		await expect(service.getJob(missingJobId)).rejects.toBeInstanceOf(
			NotFoundException
		);
		await writeFile(
			join(storageDir, 'fences', 'reporting.json'),
			JSON.stringify(
				signDatabaseRestoreTargetLock(
					{
						version: 1,
						target: 'reporting',
						jobId: missingJobId,
						createdAt: '2026-07-31T10:00:00.000Z'
					},
					queueSecret
				)
			)
		);

		await expect(
			service.enqueue(
				'reporting',
				createFile(),
				'ВОССТАНОВИТЬ REPORTING',
				'clrestoreadmin123',
				beforePublish
			)
		).rejects.toBeInstanceOf(ConflictException);
		expect(beforePublish).not.toHaveBeenCalled();
	});

	it('validates target, confirmation, size and safe dump name', async () => {
		await expect(
			service.enqueue(
				'unknown',
				createFile(),
				'ВОССТАНОВИТЬ REPORTING',
				'clrestoreadmin123',
				beforePublish
			)
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			service.enqueue(
				'reporting',
				createFile(),
				'ВОССТАНОВИТЬ CORE',
				'clrestoreadmin123',
				beforePublish
			)
		).rejects.toThrow('ВОССТАНОВИТЬ REPORTING');
		await expect(
			service.enqueue(
				'reporting',
				createFile({ originalname: '../reporting.dump' }),
				'ВОССТАНОВИТЬ REPORTING',
				'clrestoreadmin123',
				beforePublish
			)
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			service.enqueue(
				'reporting',
				createFile({ size: 999 }),
				'ВОССТАНОВИТЬ REPORTING',
				'clrestoreadmin123',
				beforePublish
			)
		).rejects.toThrow('не совпадает');
		await expect(
			service.enqueue(
				'reporting',
				createFile({
					size: DATABASE_RESTORE_MAX_FILE_SIZE_BYTES + 1
				}),
				'ВОССТАНОВИТЬ REPORTING',
				'clrestoreadmin123',
				beforePublish
			)
		).rejects.toThrow('меньше 50 МБ');
	});

	it('fails closed for missing config and invalid job ids', async () => {
		process.env.DATABASE_RESTORE_QUEUE_SECRET = 'short';
		await expect(
			service.enqueue(
				'core',
				createFile(),
				'ВОССТАНОВИТЬ CORE',
				'clrestoreadmin123',
				beforePublish
			)
		).rejects.toBeInstanceOf(ServiceUnavailableException);

		process.env.DATABASE_RESTORE_QUEUE_SECRET = queueSecret;
		process.env.DATABASE_RESTORE_STORAGE_DIR = 'relative/restore-queue';
		await expect(service.getJob('not-a-uuid')).rejects.toBeInstanceOf(
			BadRequestException
		);
		await expect(
			service.getJob('00000000-0000-4000-8000-000000000001')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('prefers terminal state and rejects a tampered manifest', async () => {
		const job = await service.enqueue(
			'campaigns',
			createFile({ originalname: 'campaigns.dump' }),
			'ВОССТАНОВИТЬ CAMPAIGNS',
			'clrestoreadmin123',
			beforePublish
		);
		const queuedPath = join(storageDir, 'queued', `${job.jobId}.json`);
		const queued = parseAndVerifyDatabaseRestoreJobManifest(
			await readFile(queuedPath, 'utf8'),
			queueSecret
		);
		const queuedPayload = { ...queued };
		delete (queuedPayload as Partial<typeof queued>).signature;
		const terminal = signDatabaseRestoreJobPayload(
			{
				...queuedPayload,
				status: 'FAILED_FENCED',
				startedAt: '2026-07-31T10:01:00.000Z',
				finishedAt: '2026-07-31T10:02:00.000Z',
				attempt: 1,
				error: {
					code: 'RESTORE_VERIFY_FAILED',
					message: 'Проверка после восстановления не пройдена'
				},
				result: null
			},
			queueSecret
		);
		await writeFile(
			join(storageDir, 'terminal', `${job.jobId}.json`),
			JSON.stringify(terminal)
		);

		await expect(service.getJob(job.jobId)).resolves.toMatchObject({
			status: 'FAILED_FENCED',
			attempt: 1,
			error: { code: 'RESTORE_VERIFY_FAILED' }
		});

		const tampered = { ...terminal, target: 'reporting' };
		await writeFile(
			join(storageDir, 'terminal', `${job.jobId}.json`),
			JSON.stringify(tampered)
		);
		await expect(service.getJob(job.jobId)).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
	});

	it('returns not found when every queue directory misses', async () => {
		await expect(
			service.getJob('00000000-0000-4000-8000-000000000001')
		).rejects.toBeInstanceOf(NotFoundException);
	});

	it('does not publish a destructive job when audit persistence fails', async () => {
		const failingAudit: jest.MockedFunction<DatabaseRestoreBeforePublish> =
			jest.fn(async job => {
				expect(
					await readFile(
						join(storageDir, 'queued', `.${job.jobId}.staged`),
						'utf8'
					)
				).toContain(job.jobId);
				expect(
					await readFile(join(storageDir, 'locks', 'core.lock'), 'utf8')
				).toContain(job.jobId);
				throw new Error('audit unavailable');
			});

		await expect(
			service.enqueue(
				'core',
				createFile({ originalname: 'core.dump' }),
				'ВОССТАНОВИТЬ CORE',
				'clrestoreadmin123',
				failingAudit
			)
		).rejects.toThrow('audit unavailable');
		expect(failingAudit).toHaveBeenCalledTimes(1);
		expect(await readdir(join(storageDir, 'uploads'))).toEqual([]);
		expect(await readdir(join(storageDir, 'queued'))).toEqual([]);
		expect(await readdir(join(storageDir, 'locks'))).toEqual([]);
		expect(await readdir(join(storageDir, 'gates'))).toEqual([]);
	});

	it('allows only one nonterminal restore job globally', async () => {
		const firstJob = await service.enqueue(
			'reporting',
			createFile({ originalname: 'reporting-first.dump' }),
			'ВОССТАНОВИТЬ REPORTING',
			'clrestoreadmin123',
			beforePublish
		);
		const duplicateAudit: jest.MockedFunction<DatabaseRestoreBeforePublish> =
			jest.fn().mockResolvedValue(undefined);

		await expect(
			service.enqueue(
				'core',
				createFile({ originalname: 'core-second.dump' }),
				'ВОССТАНОВИТЬ CORE',
				'clrestoreadmin123',
				duplicateAudit
			)
		).rejects.toBeInstanceOf(ConflictException);
		expect(duplicateAudit).not.toHaveBeenCalled();
		expect(await readdir(join(storageDir, 'queued'))).toEqual([
			`${firstJob.jobId}.json`
		]);
		expect(await readdir(join(storageDir, 'uploads'))).toEqual([
			`${firstJob.jobId}.dump`
		]);
		expect(await readdir(join(storageDir, 'locks'))).toEqual([
			'global.lock',
			'reporting.lock'
		]);
	});

	it('removes only its own global gate when the locks directory fsync fails after link', async () => {
		const internals = service as any;
		const originalSyncDirectory = internals.syncDirectory.bind(service);
		jest
			.spyOn(internals, 'syncDirectory')
			.mockRejectedValueOnce(new Error('simulated locks fsync failure'))
			.mockImplementation(originalSyncDirectory);

		await expect(
			service.enqueue(
				'reporting',
				createFile(),
				'ВОССТАНОВИТЬ REPORTING',
				'clrestoreadmin123',
				beforePublish
			)
		).rejects.toThrow('simulated locks fsync failure');

		expect(beforePublish).not.toHaveBeenCalled();
		expect(await readdir(join(storageDir, 'locks'))).toEqual([]);
		expect(await readdir(join(storageDir, 'uploads'))).toEqual([]);
		expect(await readdir(join(storageDir, 'queued'))).toEqual([]);
	});

	it('preserves a replacement global gate when fsync failure cleanup loses ownership', async () => {
		const foreignJobId = '00000000-0000-4000-8000-000000000119';
		const foreignGate = signDatabaseRestoreGlobalGate(
			{
				version: 1,
				kind: 'DATABASE_RESTORE_GLOBAL_GATE',
				target: 'core',
				jobId: foreignJobId,
				createdAt: new Date().toISOString()
			},
			queueSecret
		);
		const internals = service as any;
		const originalSyncDirectory = internals.syncDirectory.bind(service);
		jest
			.spyOn(internals, 'syncDirectory')
			.mockImplementationOnce(async () => {
				const replacementPath = join(
					storageDir,
					'locks',
					'.replacement-global.lock'
				);
				await writeFile(replacementPath, JSON.stringify(foreignGate));
				await rename(
					replacementPath,
					join(storageDir, 'locks', 'global.lock')
				);
				throw new Error('simulated locks fsync ownership race');
			})
			.mockImplementation(originalSyncDirectory);

		await expect(
			service.enqueue(
				'reporting',
				createFile(),
				'ВОССТАНОВИТЬ REPORTING',
				'clrestoreadmin123',
				beforePublish
			)
		).rejects.toThrow('требуется ручная сверка');

		expect(beforePublish).not.toHaveBeenCalled();
		expect(
			parseAndVerifyDatabaseRestoreGlobalGate(
				await readFile(join(storageDir, 'locks', 'global.lock'), 'utf8'),
				queueSecret
			)
		).toEqual(foreignGate);
	});

	it('cleans the staged upload if publishing its manifest fails', async () => {
		const internals = service as any;
		const originalWrite = internals.writeDurableFile.bind(service);
		jest
			.spyOn(internals, 'writeDurableFile')
			.mockImplementationOnce(originalWrite)
			.mockRejectedValueOnce(new Error('manifest write failed'));

		await expect(
			service.enqueue(
				'notification-delivery',
				createFile({ originalname: 'notification.dump' }),
				'ВОССТАНОВИТЬ NOTIFICATION DELIVERY',
				'clrestoreadmin123',
				beforePublish
			)
		).rejects.toThrow('manifest write failed');
		expect(await readdir(join(storageDir, 'uploads'))).toEqual([]);
		expect(await readdir(join(storageDir, 'queued'))).toEqual([]);
	});
});
