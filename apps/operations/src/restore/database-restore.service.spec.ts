import { ConfigService } from '@nestjs/config';
import {
	DatabaseRestoreJobStatus,
	OperationalAlertSeverity
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

const restoreWorker = (dependencies: {
	control: unknown;
	prisma: unknown;
	executor?: unknown;
	alerts?: unknown;
}) =>
	new DatabaseRestoreWorkerService(
		{} as never,
		{} as never,
		dependencies.control as never,
		dependencies.prisma as never,
		(dependencies.executor ?? {}) as never,
		(dependencies.alerts ?? {}) as never
	);

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
		const resolveSourcePath = jest.fn();
		const prisma = {
			databaseRestoreJob: { updateMany: jest.fn() }
		};
		const worker = restoreWorker({
			control: { resolveSourcePath },
			prisma
		});
		const invalid = message({ legacyCoreJobId: randomUUID() });

		await expect(worker.handleMessage(invalid as never)).resolves.toBe(
			'reject'
		);
		expect(resolveSourcePath).not.toHaveBeenCalled();
		expect(prisma.databaseRestoreJob.updateMany).not.toHaveBeenCalled();
	});

	it('fails a queued job when its source path cannot be resolved', async () => {
		const jobId = randomUUID();
		const updateMany = jest.fn().mockResolvedValue({ count: 1 });
		const record = jest
			.fn()
			.mockRejectedValue(new Error('alert unavailable'));
		const restore = jest.fn();
		const worker = restoreWorker({
			control: {
				resolveSourcePath: jest
					.fn()
					.mockRejectedValue(new Error('restore path\r\nunavailable'))
			},
			prisma: { databaseRestoreJob: { updateMany } },
			executor: { restore },
			alerts: { record }
		});

		await expect(
			worker.handleMessage(message({ jobId }) as never)
		).resolves.toBe('ack');

		expect(updateMany).toHaveBeenCalledTimes(1);
		const failure = updateMany.mock.calls[0][0];
		expect(failure).toEqual({
			where: {
				id: jobId,
				target: 'operations',
				status: DatabaseRestoreJobStatus.QUEUED
			},
			data: {
				status: DatabaseRestoreJobStatus.FAILED,
				lastError: 'restore path unavailable',
				startedAt: expect.any(Date),
				finishedAt: expect.any(Date)
			}
		});
		expect(failure.data.startedAt).toBe(failure.data.finishedAt);
		expect(record).toHaveBeenCalledWith({
			deduplicationKey: 'database-restore:operations',
			type: 'INTEGRATION_PROBLEM',
			severity: OperationalAlertSeverity.HIGH,
			source: 'operations',
			referenceId: jobId,
			title: 'Не восстановлена база operations',
			message:
				'DEV database restore не запущен: не удалось подготовить путь к исходному dump'
		});
		expect(restore).not.toHaveBeenCalled();
	});

	it('acks a stale path failure without overwriting or alerting', async () => {
		const updateMany = jest.fn().mockResolvedValue({ count: 0 });
		const record = jest.fn();
		const worker = restoreWorker({
			control: {
				resolveSourcePath: jest
					.fn()
					.mockRejectedValue(new Error('restore path unavailable'))
			},
			prisma: { databaseRestoreJob: { updateMany } },
			alerts: { record }
		});

		await expect(worker.handleMessage(message() as never)).resolves.toBe(
			'ack'
		);
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: DatabaseRestoreJobStatus.QUEUED
				}),
				data: expect.objectContaining({
					status: DatabaseRestoreJobStatus.FAILED
				})
			})
		);
		expect(record).not.toHaveBeenCalled();
	});

	it('rethrows a source-path failure when the failure CAS is unavailable', async () => {
		const persistenceError = new Error('failure state unavailable');
		const record = jest.fn();
		const worker = restoreWorker({
			control: {
				resolveSourcePath: jest
					.fn()
					.mockRejectedValue(new Error('restore path unavailable'))
			},
			prisma: {
				databaseRestoreJob: {
					updateMany: jest.fn().mockRejectedValue(persistenceError)
				}
			},
			alerts: { record }
		});

		await expect(worker.handleMessage(message() as never)).rejects.toBe(
			persistenceError
		);
		expect(record).not.toHaveBeenCalled();
	});

	it('resolves the source before claiming and preserves it after a lost claim', async () => {
		const directory = await mkdtemp(
			join(tmpdir(), 'operations-restore-worker-')
		);
		const source = join(directory, 'source.dump');
		await writeFile(source, 'PGDMP-test');
		const calls: string[] = [];
		const restore = jest.fn();
		const record = jest.fn();
		const worker = restoreWorker({
			control: {
				resolveSourcePath: jest.fn().mockImplementation(async () => {
					calls.push('resolve');
					return source;
				})
			},
			prisma: {
				databaseRestoreJob: {
					updateMany: jest.fn().mockImplementation(async () => {
						calls.push('claim');
						return { count: 0 };
					})
				}
			},
			executor: { restore },
			alerts: { record }
		});

		try {
			await expect(worker.handleMessage(message() as never)).resolves.toBe(
				'ack'
			);
			expect(calls).toEqual(['resolve', 'claim']);
			await expect(access(source)).resolves.toBeUndefined();
			expect(restore).not.toHaveBeenCalled();
			expect(record).not.toHaveBeenCalled();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('preserves the source when the processing claim cannot be persisted', async () => {
		const directory = await mkdtemp(
			join(tmpdir(), 'operations-restore-worker-')
		);
		const source = join(directory, 'source.dump');
		await writeFile(source, 'PGDMP-test');
		const claimError = new Error('claim unavailable');
		const worker = restoreWorker({
			control: { resolveSourcePath: jest.fn().mockResolvedValue(source) },
			prisma: {
				databaseRestoreJob: {
					updateMany: jest.fn().mockRejectedValue(claimError)
				}
			}
		});

		try {
			await expect(worker.handleMessage(message() as never)).rejects.toBe(
				claimError
			);
			await expect(access(source)).resolves.toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('executes a winning claim, persists success, and removes its source', async () => {
		const directory = await mkdtemp(
			join(tmpdir(), 'operations-restore-worker-')
		);
		const source = join(directory, 'source.dump');
		await writeFile(source, 'PGDMP-test');
		const jobId = randomUUID();
		const sourceSha256 = 'a'.repeat(64);
		const result = {
			target: 'reporting',
			restoredAt: '2026-08-30T10:00:00Z'
		};
		const calls: string[] = [];
		const update = jest.fn().mockImplementation(async () => {
			calls.push('success');
			return {};
		});
		const restore = jest.fn().mockImplementation(async () => {
			calls.push('execute');
			return result;
		});
		const resolve = jest.fn().mockResolvedValue({ count: 1 });
		const record = jest.fn();
		const worker = restoreWorker({
			control: {
				resolveSourcePath: jest.fn().mockImplementation(async () => {
					calls.push('resolve');
					return source;
				})
			},
			prisma: {
				databaseRestoreJob: {
					updateMany: jest.fn().mockImplementation(async () => {
						calls.push('claim');
						return { count: 1 };
					}),
					findUniqueOrThrow: jest.fn().mockResolvedValue({
						id: jobId,
						sourceSha256
					}),
					update
				}
			},
			executor: { restore },
			alerts: { resolve, record }
		});

		try {
			await expect(
				worker.handleMessage(
					message({ jobId, target: 'reporting' }) as never
				)
			).resolves.toBe('ack');
			expect(calls).toEqual(['resolve', 'claim', 'execute', 'success']);
			expect(restore).toHaveBeenCalledWith({
				jobId,
				target: 'reporting',
				source,
				expectedSha256: sourceSha256
			});
			expect(update).toHaveBeenCalledWith({
				where: { id: jobId },
				data: {
					status: DatabaseRestoreJobStatus.SUCCEEDED,
					result,
					finishedAt: expect.any(Date)
				}
			});
			expect(resolve).toHaveBeenCalledWith('database-restore:reporting');
			expect(record).not.toHaveBeenCalled();
			await expect(access(source)).rejects.toMatchObject({
				code: 'ENOENT'
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('persists a winning claim failure, alerts, and removes its source', async () => {
		const directory = await mkdtemp(
			join(tmpdir(), 'operations-restore-worker-')
		);
		const source = join(directory, 'source.dump');
		await writeFile(source, 'PGDMP-test');
		const jobId = randomUUID();
		const sourceSha256 = 'b'.repeat(64);
		const calls: string[] = [];
		const updateMany = jest
			.fn()
			.mockImplementationOnce(async () => {
				calls.push('claim');
				return { count: 1 };
			})
			.mockImplementationOnce(async () => {
				calls.push('failed');
				return { count: 1 };
			});
		const restore = jest.fn().mockImplementation(async () => {
			calls.push('execute');
			throw new Error('restore failed\r\nnow');
		});
		const record = jest.fn().mockImplementation(async () => {
			calls.push('alert');
			return {};
		});
		const update = jest.fn();
		const worker = restoreWorker({
			control: {
				resolveSourcePath: jest.fn().mockImplementation(async () => {
					calls.push('resolve');
					return source;
				})
			},
			prisma: {
				databaseRestoreJob: {
					updateMany,
					findUniqueOrThrow: jest.fn().mockResolvedValue({
						id: jobId,
						sourceSha256
					}),
					update
				}
			},
			executor: { restore },
			alerts: { record }
		});

		try {
			await expect(
				worker.handleMessage(
					message({ jobId, target: 'reporting' }) as never
				)
			).resolves.toBe('ack');
			expect(calls).toEqual([
				'resolve',
				'claim',
				'execute',
				'failed',
				'alert'
			]);
			expect(updateMany).toHaveBeenNthCalledWith(2, {
				where: {
					id: jobId,
					status: DatabaseRestoreJobStatus.PROCESSING
				},
				data: {
					status: DatabaseRestoreJobStatus.FAILED,
					lastError: 'restore failed now',
					finishedAt: expect.any(Date)
				}
			});
			expect(record).toHaveBeenCalledWith({
				deduplicationKey: 'database-restore:reporting',
				type: 'INTEGRATION_PROBLEM',
				severity: OperationalAlertSeverity.HIGH,
				source: 'operations',
				referenceId: jobId,
				title: 'Не восстановлена база reporting',
				message:
					'DEV database restore завершился ошибкой; проверьте job и safety backup'
			});
			expect(update).not.toHaveBeenCalled();
			await expect(access(source)).rejects.toMatchObject({
				code: 'ENOENT'
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
