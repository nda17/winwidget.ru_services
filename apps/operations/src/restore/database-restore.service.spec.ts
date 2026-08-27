import { ConfigService } from '@nestjs/config';
import { DatabaseRestoreJobStatus } from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseRestoreService } from './database-restore.service';
import { DatabaseRestoreWorkerService } from './database-restore-worker.service';

const message = (overrides: Record<string, unknown> = {}) => {
	const eventId = randomUUID();
	const jobId = randomUUID();
	return {
		content: Buffer.from(
			JSON.stringify({
				schemaVersion: 1,
				eventId,
				jobId,
				target: 'operations',
				...overrides
			})
		),
		properties: {
			type: 'operations.database-restore.requested.v1',
			messageId: eventId
		}
	};
};

const restoreConfig = (values: Record<string, string>) =>
	({
		get: (key: string) => values[key]
	}) as ConfigService;

describe('DatabaseRestoreService RabbitMQ contract', () => {
	it('starts the restore consumer only in the isolated restore-worker role', async () => {
		const rabbit = {
			consumeDatabaseRestoreJobs: jest.fn().mockResolvedValue(undefined)
		};
		const worker = new DatabaseRestoreWorkerService(
			{ restoreWorkerEnabled: true } as never,
			rabbit as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);

		await worker.onModuleInit();

		expect(rabbit.consumeDatabaseRestoreJobs).toHaveBeenCalledTimes(1);
		expect(worker.isReady()).toBe(true);
	});

	it('does not start restore execution in the regular worker role', async () => {
		const rabbit = { consumeDatabaseRestoreJobs: jest.fn() };
		const worker = new DatabaseRestoreWorkerService(
			{ restoreWorkerEnabled: false } as never,
			rabbit as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);

		await worker.onModuleInit();

		expect(rabbit.consumeDatabaseRestoreJobs).not.toHaveBeenCalled();
		expect(worker.isReady()).toBe(true);
	});

	it('keeps the frontend restore settings contract explicit', () => {
		const service = new DatabaseRestoreService(
			restoreConfig({ DATABASE_RESTORE_ENABLED: 'false' }),
			{} as never,
			{} as never,
			{} as never
		);

		expect(service.getSettings()).toEqual(
			expect.objectContaining({
				enabled: false,
				approved: null,
				allowedFileExtension: '.dump',
				maxFileSizeBytes: 49 * 1024 * 1024
			})
		);
	});

	it('uses the frontend request id as the durable job id', async () => {
		const storage = await mkdtemp(
			join(tmpdir(), 'operations-restore-test-')
		);
		const requestId = randomUUID();
		const now = new Date('2026-08-26T08:00:00.000Z');
		const transaction = {
			databaseRestoreJob: {
				create: jest.fn().mockImplementation(({ data }) => ({
					...data,
					status: DatabaseRestoreJobStatus.QUEUED,
					result: null,
					lastError: null,
					startedAt: null,
					finishedAt: null,
					createdAt: now,
					updatedAt: now
				}))
			}
		};
		const prisma = {
			databaseRestoreJob: {
				findUnique: jest.fn().mockResolvedValue(null)
			},
			$transaction: jest.fn((callback: (value: unknown) => unknown) =>
				callback(transaction)
			)
		};
		const outbox = { enqueue: jest.fn().mockResolvedValue({}) };
		const audit = { recordInTransaction: jest.fn().mockResolvedValue({}) };
		const service = new DatabaseRestoreService(
			restoreConfig({
				DATABASE_RESTORE_ENABLED: 'true',
				DATABASE_RESTORE_STORAGE_DIR: storage
			}),
			prisma as never,
			outbox as never,
			audit as never
		);

		try {
			await expect(
				service.enqueue({
					target: 'operations',
					file: {
						originalname: 'operations.dump',
						size: 6,
						buffer: Buffer.from('PGDMP1')
					},
					confirmation: 'ВОССТАНОВИТЬ OPERATIONS',
					requestId,
					actorId: 'admin-42',
					ip: null,
					userAgent: null
				})
			).resolves.toEqual(
				expect.objectContaining({
					jobId: requestId,
					publicationConfirmed: true
				})
			);
			expect(outbox.enqueue).toHaveBeenCalledWith(
				transaction,
				expect.objectContaining({
					aggregateId: requestId,
					payload: expect.objectContaining({ jobId: requestId })
				})
			);
		} finally {
			await rm(storage, { recursive: true, force: true });
		}
	});

	it('rejects messages outside the exact Operations restore contract', async () => {
		const prisma = {
			databaseRestoreJob: { updateMany: jest.fn() }
		};
		const worker = new DatabaseRestoreWorkerService(
			{} as never,
			{} as never,
			{} as never,
			prisma as never,
			{} as never,
			{} as never
		);
		const invalid = message({ legacyCoreJobId: randomUUID() });

		await expect(worker.handleMessage(invalid as never)).resolves.toBe(
			'reject'
		);
		expect(prisma.databaseRestoreJob.updateMany).not.toHaveBeenCalled();
	});

	it('acks a duplicate delivery when the durable job is no longer queued', async () => {
		const prisma = {
			databaseRestoreJob: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			}
		};
		const worker = new DatabaseRestoreWorkerService(
			{} as never,
			{} as never,
			{} as never,
			prisma as never,
			{} as never,
			{} as never
		);

		await expect(worker.handleMessage(message() as never)).resolves.toBe(
			'ack'
		);
		expect(prisma.databaseRestoreJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: 'QUEUED',
					target: 'operations'
				})
			})
		);
	});
});
