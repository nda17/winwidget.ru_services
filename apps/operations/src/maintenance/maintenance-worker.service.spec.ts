import { Logger } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { OPERATIONS_SCHEDULED_JOB_EVENT_TYPE } from '../messaging/operations-messaging.constants';
import type { BackupJobClaim } from '../scheduled-jobs/scheduled-jobs.service';
import type { ScheduledJobView } from '../scheduled-jobs/scheduled-jobs.types';
import { MaintenanceWorkerService } from './maintenance-worker.service';

function fixture() {
	const now = new Date().toISOString();
	const job: ScheduledJobView = {
		id: randomUUID(),
		jobType: 'OPERATIONS_DATABASE_BACKUP',
		scheduleKey: 'manual:test',
		trigger: 'MANUAL',
		status: 'PROCESSING',
		scheduledFor: now,
		periodStart: null,
		periodEnd: null,
		input: {
			schemaVersion: 1,
			target: 'operations',
			chatId: 'test-chat',
			messageThreadId: 1,
			trigger: 'MANUAL'
		},
		checkpoint: {},
		result: null,
		attempts: 1,
		maxAttempts: 4,
		availableAt: now,
		leaseOwner: 'worker',
		leaseToken: randomUUID(),
		leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
		startedAt: now,
		finishedAt: null,
		lastError: null,
		createdAt: now,
		updatedAt: now
	};
	const claim: BackupJobClaim = {
		status: 'CLAIMED',
		job,
		leaseToken: job.leaseToken!
	};
	const event = {
		schemaVersion: 1,
		eventId: randomUUID(),
		jobId: job.id,
		jobType: job.jobType
	};
	const message = {
		content: Buffer.from(JSON.stringify(event)),
		properties: {
			type: OPERATIONS_SCHEDULED_JOB_EVENT_TYPE,
			messageId: event.eventId
		}
	} as ConsumeMessage;
	const jobs = {
		claimBackup: jest
			.fn<Promise<BackupJobClaim>, unknown[]>()
			.mockResolvedValue(claim),
		renewLease: jest.fn().mockResolvedValue(true),
		complete: jest.fn().mockResolvedValue(true),
		fail: jest.fn().mockResolvedValue(true)
	};
	const backup = {
		createAndSend: jest
			.fn()
			.mockResolvedValue({ telegramReceipt: { fileId: 'test-receipt' } })
	};
	const prisma = {
		telegramBotSettings: { update: jest.fn().mockResolvedValue({}) }
	};
	const alerts = { resolve: jest.fn().mockResolvedValue({}) };
	const runtime = { workerEnabled: true };
	const rabbit = {
		consumeScheduledJobs: jest.fn().mockResolvedValue(undefined)
	};
	const service = new MaintenanceWorkerService(
		runtime as never,
		rabbit as never,
		jobs as never,
		backup as never,
		prisma as never,
		alerts as never
	);
	return {
		service,
		jobs,
		backup,
		prisma,
		alerts,
		runtime,
		rabbit,
		claim,
		job,
		event,
		message
	};
}

describe('MaintenanceWorkerService durable backup outcomes', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		jest
			.spyOn(Logger.prototype, 'warn')
			.mockImplementation(() => undefined);
	});
	afterEach(() => {
		expect(jest.getTimerCount()).toBe(0);
		jest.restoreAllMocks();
		jest.useRealTimers();
	});

	it.each([
		['DEFERRED', 'ack'],
		['TERMINAL', 'ack'],
		['REQUEUE', 'requeue'],
		['REJECT', 'reject']
	] as const)(
		'maps %s to %s without running a backup',
		async (status, decision) => {
			const f = fixture();
			f.jobs.claimBackup.mockResolvedValue({ status });
			await expect(f.service.handleScheduledJob(f.message)).resolves.toBe(
				decision
			);
			expect(f.backup.createAndSend).not.toHaveBeenCalled();
			expect(f.jobs.complete).not.toHaveBeenCalled();
			expect(f.jobs.fail).not.toHaveBeenCalled();
			expect(f.jobs.claimBackup).toHaveBeenCalledWith(
				{
					eventId: f.event.eventId,
					jobId: f.job.id,
					jobType: f.job.jobType
				},
				expect.any(String),
				60_000
			);
		}
	);

	it('cannot acknowledge busy redelivery before its durable scheduling transaction returns', async () => {
		const f = fixture();
		let release!: (value: BackupJobClaim) => void;
		f.jobs.claimBackup.mockImplementation(
			() =>
				new Promise(resolve => {
					release = resolve;
				})
		);
		let settled = false;
		const handled = f.service.handleScheduledJob(f.message).then(value => {
			settled = true;
			return value;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(f.backup.createAndSend).not.toHaveBeenCalled();
		release({ status: 'DEFERRED' });
		await expect(handled).resolves.toBe('ack');
	});

	it('requeues unavailable/unknown scheduling outcomes', async () => {
		const f = fixture();
		f.jobs.claimBackup.mockRejectedValue(
			new Error('Outbox transaction unavailable')
		);
		await expect(f.service.handleScheduledJob(f.message)).resolves.toBe(
			'requeue'
		);
		expect(f.backup.createAndSend).not.toHaveBeenCalled();
	});

	it('acknowledges an externally completed backup only after the leased completion succeeds', async () => {
		const f = fixture();
		await expect(f.service.handleScheduledJob(f.message)).resolves.toBe(
			'ack'
		);
		expect(f.backup.createAndSend).toHaveBeenCalledWith(
			f.job.id,
			'operations',
			expect.objectContaining({ backupJobCreatedAt: f.job.createdAt }),
			expect.any(AbortSignal)
		);
		expect(f.jobs.complete).toHaveBeenCalledWith(
			f.job.id,
			f.job.leaseToken,
			expect.objectContaining({
				telegramReceipt: { fileId: 'test-receipt' }
			})
		);
		expect(f.jobs.fail).not.toHaveBeenCalled();
		expect(f.alerts.resolve).toHaveBeenCalledWith(
			'database-backup:operations'
		);
	});

	it('requeues when completion loses the lease instead of acknowledging the external result', async () => {
		const f = fixture();
		f.jobs.complete.mockResolvedValue(false);
		await expect(f.service.handleScheduledJob(f.message)).resolves.toBe(
			'requeue'
		);
		expect(f.jobs.fail).not.toHaveBeenCalled();
		expect(f.alerts.resolve).not.toHaveBeenCalled();
	});

	it.each(['false', 'throw'] as const)(
		'requeues when completion errors and failure CAS returns %s',
		async result => {
			const f = fixture();
			f.jobs.complete.mockRejectedValue(
				new Error('Unknown completion outcome')
			);
			if (result === 'false') f.jobs.fail.mockResolvedValue(false);
			else f.jobs.fail.mockRejectedValue(new Error('DB unavailable'));
			await expect(f.service.handleScheduledJob(f.message)).resolves.toBe(
				'requeue'
			);
		}
	);

	it.each([
		['true', 'ack'],
		['false', 'requeue'],
		['throw', 'requeue']
	] as const)(
		'after backup failure, failure CAS %s yields %s',
		async (result, decision) => {
			const f = fixture();
			f.backup.createAndSend.mockRejectedValue(new Error('Backup failed'));
			if (result === 'throw')
				f.jobs.fail.mockRejectedValue(new Error('DB unavailable'));
			else f.jobs.fail.mockResolvedValue(result === 'true');
			await expect(f.service.handleScheduledJob(f.message)).resolves.toBe(
				decision
			);
			expect(f.jobs.complete).not.toHaveBeenCalled();
		}
	);

	it.each([
		['true', 'ack'],
		['false', 'requeue'],
		['throw', 'requeue']
	] as const)(
		'invalid stored backup input also requires durable failure: %s → %s',
		async (result, decision) => {
			const f = fixture();
			f.job.input = { schemaVersion: 1, target: 'widgets' };
			if (result === 'throw')
				f.jobs.fail.mockRejectedValue(new Error('DB unavailable'));
			else f.jobs.fail.mockResolvedValue(result === 'true');
			await expect(f.service.handleScheduledJob(f.message)).resolves.toBe(
				decision
			);
			expect(f.backup.createAndSend).not.toHaveBeenCalled();
		}
	);

	it.each(['lost', 'unavailable'] as const)(
		'aborts external work and requeues when lease renewal is %s',
		async mode => {
			const f = fixture();
			if (mode === 'lost') f.jobs.renewLease.mockResolvedValue(false);
			else f.jobs.renewLease.mockRejectedValue(new Error('Unavailable'));
			f.jobs.fail.mockResolvedValue(false);
			let signal!: AbortSignal;
			f.backup.createAndSend.mockImplementation(
				(_id, _target, _input, value: AbortSignal) => {
					signal = value;
					return new Promise((_resolve, reject) => {
						signal.addEventListener(
							'abort',
							() => reject(new Error('Aborted')),
							{ once: true }
						);
					});
				}
			);
			const handled = f.service.handleScheduledJob(f.message);
			await jest.advanceTimersByTimeAsync(20_000);
			await expect(handled).resolves.toBe('requeue');
			expect(signal.aborted).toBe(true);
			expect(f.jobs.complete).not.toHaveBeenCalled();
		}
	);

	it.each([
		'event-type',
		'event-id',
		'unknown-field',
		'invalid-json'
	] as const)(
		'rejects invalid %s before accessing a job',
		async invalid => {
			const f = fixture();
			if (invalid === 'event-type') f.message.properties.type = 'other';
			if (invalid === 'event-id')
				f.message.properties.messageId = randomUUID();
			if (invalid === 'unknown-field')
				f.message.content = Buffer.from(
					JSON.stringify({ ...f.event, target: 'widgets' })
				);
			if (invalid === 'invalid-json') f.message.content = Buffer.from('{');
			await expect(f.service.handleScheduledJob(f.message)).resolves.toBe(
				'reject'
			);
			expect(f.jobs.claimBackup).not.toHaveBeenCalled();
		}
	);

	it('uses the existing push consumer and does not start a polling recovery loop', async () => {
		const f = fixture();
		await f.service.onModuleInit();
		expect(f.rabbit.consumeScheduledJobs).toHaveBeenCalledTimes(1);
		expect(f.service.isReady()).toBe(true);
		expect(jest.getTimerCount()).toBe(0);
	});
});
