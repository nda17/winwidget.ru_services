import {
	ScheduledJobRunStatus,
	ScheduledJobRunTrigger
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { ScheduledJobsService } from './scheduled-jobs.service';

const scheduledJob = () => {
	const now = new Date('2026-08-26T08:00:00.000Z');
	return {
		id: randomUUID(),
		jobType: 'OPERATIONS_DATABASE_BACKUP',
		scheduleKey: 'daily:operations:2026-08-26',
		trigger: ScheduledJobRunTrigger.SCHEDULED,
		status: ScheduledJobRunStatus.QUEUED,
		scheduledFor: now,
		periodStart: now,
		periodEnd: new Date('2026-08-27T08:00:00.000Z'),
		input: { schemaVersion: 1 },
		checkpoint: {},
		result: null,
		attempts: 0,
		maxAttempts: 4,
		availableAt: now,
		leaseOwner: null,
		leaseToken: null,
		leaseExpiresAt: null,
		startedAt: null,
		finishedAt: null,
		lastError: null,
		createdAt: now,
		updatedAt: now
	};
};

describe('ScheduledJobsService', () => {
	it('creates the durable job and its publication in one transaction', async () => {
		const job = scheduledJob();
		const transaction = {
			$executeRaw: jest.fn(),
			scheduledJobRun: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue(job)
			}
		};
		const prisma = {
			$transaction: jest.fn((callback: (value: unknown) => unknown) =>
				callback(transaction)
			)
		};
		const outbox = { enqueue: jest.fn().mockResolvedValue({}) };
		const service = new ScheduledJobsService(
			prisma as never,
			outbox as never
		);

		await expect(
			service.enqueueUnique({
				jobType: job.jobType,
				scheduleKey: job.scheduleKey,
				scheduledFor: job.scheduledFor,
				input: job.input
			})
		).resolves.toEqual({
			created: true,
			job: expect.objectContaining({ id: job.id, status: 'QUEUED' })
		});

		expect(outbox.enqueue).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				eventType: 'operations.scheduled-job.requested.v1',
				routingKey: 'operations.scheduled-job.requested.v1',
				aggregateId: job.id,
				payload: expect.objectContaining({
					schemaVersion: 1,
					jobId: job.id,
					jobType: job.jobType
				})
			})
		);
	});
});
