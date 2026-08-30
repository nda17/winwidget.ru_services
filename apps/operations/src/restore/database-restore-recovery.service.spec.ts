import {
	DatabaseRestoreJobPhase,
	DatabaseRestoreJobStatus
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { DatabaseRestoreRecoveryService } from './database-restore-recovery.service';

const processingJob = (leaseExpiresAt: Date) => ({
	id: randomUUID(),
	target: 'reporting',
	status: DatabaseRestoreJobStatus.PROCESSING,
	phase: DatabaseRestoreJobPhase.PREPARING,
	leaseToken: randomUUID(),
	leaseExpiresAt
});

describe('DatabaseRestoreRecoveryService', () => {
	afterEach(() => jest.useRealTimers());

	it('holds an active redelivery for the bounded wait instead of acking it', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-30T12:00:00.000Z'));
		const state = {
			observe: jest.fn(async () => ({
				state: 'processing',
				job: processingJob(new Date(Date.now() + 60_000))
			})),
			recoverExpiredJob: jest.fn()
		};
		const service = new DatabaseRestoreRecoveryService(state as never);
		const result = service.waitForEventSettlement(
			{
				eventId: randomUUID(),
				jobId: randomUUID(),
				target: 'reporting'
			},
			65_000
		);

		await jest.advanceTimersByTimeAsync(65_000);
		await expect(result).resolves.toEqual(
			expect.objectContaining({ state: 'processing' })
		);
		expect(state.recoverExpiredJob).not.toHaveBeenCalled();
	});

	it('acks responsibility only after an expired lease reaches terminal recovery', async () => {
		const job = processingJob(new Date(Date.now() - 1));
		const state = {
			observe: jest.fn().mockResolvedValue({ state: 'processing', job }),
			recoverExpiredJob: jest.fn().mockResolvedValue({
				id: job.id,
				target: job.target,
				status: DatabaseRestoreJobStatus.FAILED
			})
		};
		const service = new DatabaseRestoreRecoveryService(state as never);

		await expect(
			service.waitForEventSettlement(
				{
					eventId: randomUUID(),
					jobId: job.id,
					target: 'reporting'
				},
				65_000
			)
		).resolves.toEqual({
			state: 'terminal',
			status: DatabaseRestoreJobStatus.FAILED
		});
		expect(state.recoverExpiredJob).toHaveBeenCalledWith(job);
	});

	it('recovers an expired singleton before reporting the slot available', async () => {
		const job = processingJob(new Date(Date.now() - 1));
		const state = {
			findFence: jest
				.fn()
				.mockResolvedValueOnce(job)
				.mockResolvedValueOnce(null),
			recoverExpiredJob: jest.fn().mockResolvedValue({
				id: job.id,
				target: job.target,
				status: DatabaseRestoreJobStatus.FAILED
			})
		};
		const service = new DatabaseRestoreRecoveryService(state as never);

		await expect(
			service.waitForProcessingSlot('reporting', 65_000)
		).resolves.toBe(true);
		expect(state.recoverExpiredJob).toHaveBeenCalledWith(job);
	});

	it('keeps a RECOVERY_REQUIRED target fenced for the bounded wait', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-30T12:00:00.000Z'));
		const state = {
			findFence: jest.fn().mockResolvedValue({
				...processingJob(new Date(Date.now() - 1)),
				status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED,
				leaseToken: null,
				leaseExpiresAt: null
			}),
			recoverExpiredJob: jest.fn()
		};
		const service = new DatabaseRestoreRecoveryService(state as never);
		const result = service.waitForProcessingSlot('reporting', 65_000);

		await jest.advanceTimersByTimeAsync(65_000);
		await expect(result).resolves.toBe(false);
		expect(state.recoverExpiredJob).not.toHaveBeenCalled();
	});

	it('runs startup recovery through the exact expired batch', async () => {
		const beforeMutation = processingJob(new Date(Date.now() - 2));
		const afterMutation = {
			...processingJob(new Date(Date.now() - 1)),
			phase: DatabaseRestoreJobPhase.MUTATING
		};
		const state = {
			findExpired: jest
				.fn()
				.mockResolvedValue([beforeMutation, afterMutation]),
			recoverExpiredJob: jest
				.fn()
				.mockResolvedValueOnce({
					id: beforeMutation.id,
					target: beforeMutation.target,
					status: DatabaseRestoreJobStatus.FAILED
				})
				.mockResolvedValueOnce({
					id: afterMutation.id,
					target: afterMutation.target,
					status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED
				})
		};
		const service = new DatabaseRestoreRecoveryService(state as never);

		await expect(service.recoverExpired(25)).resolves.toEqual([
			expect.objectContaining({
				id: beforeMutation.id,
				status: DatabaseRestoreJobStatus.FAILED
			}),
			expect.objectContaining({
				id: afterMutation.id,
				status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED
			})
		]);
		expect(state.findExpired).toHaveBeenCalledWith(25);
	});
});
