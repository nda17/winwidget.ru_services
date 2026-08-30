import {
	DatabaseRestoreJobPhase,
	DatabaseRestoreJobStatus
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { DatabaseRestoreRecoveryService } from './database-restore-recovery.service';

const processingJob = (leaseExpiresAt: Date) => ({
	id: randomUUID(),
	target: 'reporting',
	eventId: randomUUID(),
	expectedServicesSha: 'a'.repeat(40),
	migrationManifestSha: 'b'.repeat(64),
	status: DatabaseRestoreJobStatus.PROCESSING,
	phase: DatabaseRestoreJobPhase.PREPARING,
	leaseToken: randomUUID(),
	leaseExpiresAt
});

const recoveryService = (state: unknown) =>
	new DatabaseRestoreRecoveryService(
		{
			confirmReleaseAuthorized: jest.fn().mockResolvedValue(null),
			...(state as Record<string, unknown>)
		} as never,
		{
			get: jest.fn(() => ({ database: 'winwidget_reporting' })),
			connection: jest.fn(async () => ({}))
		} as never,
		{ apply: jest.fn(async () => ({})) } as never,
		{ reconcileSucceeded: jest.fn(async () => ({})) } as never
	);

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
			reserveExpiredJob: jest.fn(),
			recoverReservedExpiredJob: jest.fn()
		};
		const service = recoveryService(state);
		const result = service.waitForEventSettlement(
			{
				eventId: randomUUID(),
				jobId: randomUUID(),
				target: 'reporting',
				expectedServicesSha: 'a'.repeat(40),
				migrationManifestSha: 'b'.repeat(64)
			},
			65_000
		);

		await jest.advanceTimersByTimeAsync(65_000);
		await expect(result).resolves.toEqual(
			expect.objectContaining({ state: 'processing' })
		);
		expect(state.reserveExpiredJob).not.toHaveBeenCalled();
	});

	it('acks responsibility only after an expired lease reaches terminal recovery', async () => {
		const job = processingJob(new Date(Date.now() - 1));
		const state = {
			observe: jest.fn().mockResolvedValue({ state: 'processing', job }),
			reserveExpiredJob: jest.fn().mockResolvedValue(job),
			recoverReservedExpiredJob: jest.fn().mockResolvedValue({
				id: job.id,
				target: job.target,
				status: DatabaseRestoreJobStatus.FAILED
			})
		};
		const service = recoveryService(state);

		await expect(
			service.waitForEventSettlement(
				{
					eventId: randomUUID(),
					jobId: job.id,
					target: 'reporting',
					expectedServicesSha: 'a'.repeat(40),
					migrationManifestSha: 'b'.repeat(64)
				},
				65_000
			)
		).resolves.toEqual({
			state: 'terminal',
			status: DatabaseRestoreJobStatus.FAILED
		});
		expect(state.reserveExpiredJob).toHaveBeenCalledWith(job);
		expect(state.recoverReservedExpiredJob).toHaveBeenCalledWith(
			job,
			null
		);
	});

	it('recovers an expired singleton before reporting the slot available', async () => {
		const job = processingJob(new Date(Date.now() - 1));
		const state = {
			findFence: jest
				.fn()
				.mockResolvedValueOnce(job)
				.mockResolvedValueOnce(null),
			reserveExpiredJob: jest.fn().mockResolvedValue(job),
			recoverReservedExpiredJob: jest.fn().mockResolvedValue({
				id: job.id,
				target: job.target,
				status: DatabaseRestoreJobStatus.FAILED
			})
		};
		const service = recoveryService(state);

		await expect(
			service.waitForProcessingSlot('reporting', 65_000)
		).resolves.toBe(true);
		expect(state.reserveExpiredJob).toHaveBeenCalledWith(job);
		expect(state.recoverReservedExpiredJob).toHaveBeenCalledWith(
			job,
			null
		);
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
			reserveExpiredJob: jest.fn(),
			recoverReservedExpiredJob: jest.fn()
		};
		const service = recoveryService(state);
		const result = service.waitForProcessingSlot('reporting', 65_000);

		await jest.advanceTimersByTimeAsync(65_000);
		await expect(result).resolves.toBe(false);
		expect(state.reserveExpiredJob).not.toHaveBeenCalled();
	});

	it('runs startup recovery through the exact expired batch', async () => {
		const beforeMutation = processingJob(new Date(Date.now() - 2));
		const afterMutation = {
			...processingJob(new Date(Date.now() - 1)),
			phase: DatabaseRestoreJobPhase.MUTATING
		};
		const afterReleased = {
			...processingJob(new Date(Date.now() - 1)),
			phase: DatabaseRestoreJobPhase.UNFENCED
		};
		const calls: string[] = [];
		const state = {
			confirmReleaseAuthorized: jest.fn().mockResolvedValue(null),
			findExpired: jest
				.fn()
				.mockResolvedValue([beforeMutation, afterMutation, afterReleased]),
			reserveExpiredJob: jest.fn(async job => {
				calls.push(`reserve:${job.id}`);
				return {
					...job,
					leaseToken: randomUUID(),
					leaseExpiresAt: new Date(Date.now() + 60_000)
				};
			}),
			recoverReservedExpiredJob: jest.fn(async job => {
				calls.push(`finalize:${job.id}`);
				return {
					id: job.id,
					target: job.target,
					status:
						job.phase === DatabaseRestoreJobPhase.PREPARING
							? DatabaseRestoreJobStatus.FAILED
							: DatabaseRestoreJobStatus.RECOVERY_REQUIRED
				};
			})
		};
		const pendingFenceIds = [afterMutation.id, afterReleased.id];
		const writerFence = {
			apply: jest.fn(async () => {
				calls.push(`fence:${pendingFenceIds.shift()}`);
			})
		};
		const service = new DatabaseRestoreRecoveryService(
			state as never,
			{
				get: jest.fn(() => ({ database: 'winwidget_reporting' })),
				connection: jest.fn(async () => ({}))
			} as never,
			writerFence as never,
			{ reconcileSucceeded: jest.fn(async () => ({})) } as never
		);

		await expect(service.recoverExpired(25)).resolves.toEqual([
			expect.objectContaining({
				id: beforeMutation.id,
				status: DatabaseRestoreJobStatus.FAILED
			}),
			expect.objectContaining({
				id: afterMutation.id,
				status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED
			}),
			expect.objectContaining({
				id: afterReleased.id,
				status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED
			})
		]);
		expect(state.findExpired).toHaveBeenCalledWith(25);
		expect(calls).toEqual([
			`reserve:${beforeMutation.id}`,
			`finalize:${beforeMutation.id}`,
			`reserve:${afterMutation.id}`,
			`fence:${afterMutation.id}`,
			`finalize:${afterMutation.id}`,
			`reserve:${afterReleased.id}`,
			`fence:${afterReleased.id}`,
			`finalize:${afterReleased.id}`
		]);
	});
});
