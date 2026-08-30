import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import {
	DatabaseRestoreJobPhase,
	DatabaseRestoreJobStatus
} from '@prisma/operations-client';
import type { ConsumeMessage } from 'amqplib';
import { OPERATIONS_DATABASE_RESTORE_EVENT_TYPE } from '../messaging/operations-messaging.constants';
import {
	OperationsConsumeDecision,
	OperationsRabbitMqService
} from '../messaging/operations-rabbitmq.service';
import { OperationsRuntimeService } from '../runtime/operations-runtime.service';
import { DatabaseRestoreCleanupService } from './database-restore-cleanup.service';
import {
	DATABASE_RESTORE_TARGETS,
	DatabaseRestoreTarget
} from './database-restore.contract';
import { DatabaseRestoreExecutorService } from './database-restore-executor.service';
import { DatabaseRestoreRecoveryService } from './database-restore-recovery.service';
import { DatabaseRestoreService } from './database-restore.service';
import {
	DatabaseRestoreEventIdentity,
	DatabaseRestoreLease,
	DatabaseRestoreStateService
} from './database-restore-state.service';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESTORE_LEASE_MS = 60_000;
const RESTORE_LEASE_RENEW_MS = 20_000;
const RESTORE_SETTLEMENT_WAIT_MS = RESTORE_LEASE_MS + 5_000;
const RESTORE_SWEEP_MS = 20_000;
const RESTORE_SWEEP_BATCH_SIZE = 25;

@Injectable()
export class DatabaseRestoreWorkerService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(DatabaseRestoreWorkerService.name);
	private readonly activeControllers = new Set<AbortController>();
	private ready = false;
	private sweepTimer: NodeJS.Timeout | null = null;
	private sweepRunning = false;

	constructor(
		private readonly runtime: OperationsRuntimeService,
		private readonly rabbit: OperationsRabbitMqService,
		private readonly control: DatabaseRestoreService,
		private readonly state: DatabaseRestoreStateService,
		private readonly recovery: DatabaseRestoreRecoveryService,
		private readonly executor: DatabaseRestoreExecutorService,
		private readonly cleanup: DatabaseRestoreCleanupService
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.runtime.restoreWorkerEnabled) return;
		await this.sweep();
		this.sweepTimer = setInterval(() => {
			void this.runSweep();
		}, RESTORE_SWEEP_MS);
		this.sweepTimer.unref();
		try {
			await this.rabbit.consumeDatabaseRestoreJobs(message =>
				this.handleMessage(message)
			);
			this.ready = true;
		} catch (error) {
			this.clearSweepTimer();
			throw error;
		}
	}

	async onApplicationShutdown(): Promise<void> {
		this.ready = false;
		this.clearSweepTimer();
		for (const controller of this.activeControllers) {
			controller.abort(
				new Error('Database restore worker is shutting down')
			);
		}
	}

	isReady(): boolean {
		return !this.runtime.restoreWorkerEnabled || this.ready;
	}

	async handleMessage(
		message: ConsumeMessage
	): Promise<OperationsConsumeDecision> {
		let event: DatabaseRestoreEventIdentity;
		try {
			event = this.parseEvent(message);
		} catch {
			return 'reject';
		}

		let source: string;
		try {
			source = await this.control.resolveSourcePath(event.jobId);
		} catch (error) {
			const failed = await this.state.failQueuedWithoutSource(
				event,
				error
			);
			if (!failed) return this.settleUnclaimed(event);
			await this.cleanup.recordError(
				event.jobId,
				DatabaseRestoreJobStatus.FAILED,
				error
			);
			this.logger.error(
				`Database restore source path failed jobId=${event.jobId}`
			);
			return 'ack';
		}

		for (let attempt = 0; attempt < 3; attempt += 1) {
			const claim = await this.state.claim(event);
			if (claim.state === 'claimed') {
				return this.executeClaim(claim.lease, source);
			}
			if (claim.state === 'busy') {
				if (
					!(await this.recovery.waitForProcessingSlot(
						event.target,
						RESTORE_SETTLEMENT_WAIT_MS
					))
				) {
					return 'requeue';
				}
				continue;
			}
			const decision = await this.settleUnclaimed(event);
			if (decision !== 'requeue') return decision;
			if (
				!(await this.recovery.waitForProcessingSlot(
					event.target,
					RESTORE_SETTLEMENT_WAIT_MS
				))
			) {
				return 'requeue';
			}
		}
		return 'requeue';
	}

	private async executeClaim(
		lease: DatabaseRestoreLease,
		source: string
	): Promise<OperationsConsumeDecision> {
		const controller = new AbortController();
		this.activeControllers.add(controller);
		let leaseDeadlineTimer: NodeJS.Timeout | null = null;
		let renewalRunning = false;
		const armLeaseDeadline = () => {
			if (leaseDeadlineTimer) clearTimeout(leaseDeadlineTimer);
			leaseDeadlineTimer = setTimeout(
				() => {
					controller.abort(new Error('Database restore lease expired'));
				},
				Math.max(0, lease.leaseExpiresAt.getTime() - Date.now())
			);
			leaseDeadlineTimer.unref();
		};
		armLeaseDeadline();
		const renewalTimer = setInterval(() => {
			if (renewalRunning || controller.signal.aborted) return;
			renewalRunning = true;
			void this.state
				.renew(lease)
				.then(renewed => {
					if (renewed) armLeaseDeadline();
					else {
						controller.abort(new Error('Database restore lease was lost'));
					}
				})
				.catch(error => {
					this.logger.error(
						`Database restore lease renewal failed jobId=${lease.event.jobId}: ${this.safeError(error)}`
					);
					controller.abort(error);
				})
				.finally(() => {
					renewalRunning = false;
				});
		}, RESTORE_LEASE_RENEW_MS);
		renewalTimer.unref();

		let terminalStatus: DatabaseRestoreJobStatus;
		try {
			const job = await this.state.loadClaimedJob(lease);
			controller.signal.throwIfAborted();
			const result = await this.executor.restore({
				jobId: job.id,
				target: lease.event.target,
				source,
				expectedSha256: job.sourceSha256,
				signal: controller.signal,
				checkpoint: async checkpoint => {
					await this.state.checkpoint(lease, checkpoint);
					armLeaseDeadline();
				}
			});
			if (!(await this.state.succeed(lease, result))) {
				throw new Error(
					'Database restore success checkpoint could not be persisted'
				);
			}
			terminalStatus = DatabaseRestoreJobStatus.SUCCEEDED;
		} catch (error) {
			controller.abort(error);
			const failedStatus = await this.state.fail(lease, error);
			if (!failedStatus) {
				throw new Error(
					`Database restore failure checkpoint could not be persisted: ${this.safeError(error)}`
				);
			}
			terminalStatus = failedStatus;
		} finally {
			clearInterval(renewalTimer);
			if (leaseDeadlineTimer) clearTimeout(leaseDeadlineTimer);
			this.activeControllers.delete(controller);
		}

		await this.cleanup.cleanup({
			id: lease.event.jobId,
			status: terminalStatus,
			phase: lease.phase,
			source
		});
		return 'ack';
	}

	private async settleUnclaimed(
		event: DatabaseRestoreEventIdentity
	): Promise<OperationsConsumeDecision> {
		const observation = await this.recovery.waitForEventSettlement(
			event,
			RESTORE_SETTLEMENT_WAIT_MS
		);
		if (
			observation.state === 'missing' ||
			observation.state === 'mismatched'
		) {
			return 'reject';
		}
		if (observation.state === 'terminal') return 'ack';
		return 'requeue';
	}

	private async runSweep(): Promise<void> {
		if (this.sweepRunning) return;
		this.sweepRunning = true;
		try {
			await this.sweep();
		} catch (error) {
			this.logger.error(
				`Database restore recovery sweep failed: ${this.safeError(error)}`
			);
		} finally {
			this.sweepRunning = false;
		}
	}

	private async sweep(): Promise<void> {
		const recovered = await this.recovery.recoverExpired(
			RESTORE_SWEEP_BATCH_SIZE
		);
		for (const job of recovered) await this.cleanupByJob(job);
		const pendingCleanup = await this.cleanup.pending(
			RESTORE_SWEEP_BATCH_SIZE
		);
		for (const job of pendingCleanup) await this.cleanupByJob(job);
	}

	private async cleanupByJob(job: {
		id: string;
		status: DatabaseRestoreJobStatus;
		phase: DatabaseRestoreJobPhase | null;
	}): Promise<void> {
		if (job.status === DatabaseRestoreJobStatus.RECOVERY_REQUIRED) return;
		let source: string;
		try {
			source = await this.control.resolveSourcePath(job.id);
		} catch (error) {
			await this.cleanup.recordError(job.id, job.status, error);
			return;
		}
		await this.cleanup.cleanup({ ...job, source });
	}

	private parseEvent(
		message: ConsumeMessage
	): DatabaseRestoreEventIdentity {
		if (
			message.properties.type !== OPERATIONS_DATABASE_RESTORE_EVENT_TYPE ||
			message.content.length > 64 * 1024
		) {
			throw new Error('Database restore message is invalid');
		}
		const value = JSON.parse(message.content.toString('utf8')) as unknown;
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Database restore event is invalid');
		}
		const record = value as Record<string, unknown>;
		if (
			Object.keys(record).sort().join(',') !==
				'eventId,jobId,schemaVersion,target' ||
			record.schemaVersion !== 1 ||
			typeof record.eventId !== 'string' ||
			!UUID_PATTERN.test(record.eventId) ||
			typeof record.jobId !== 'string' ||
			!UUID_PATTERN.test(record.jobId) ||
			typeof record.target !== 'string' ||
			!DATABASE_RESTORE_TARGETS.includes(
				record.target as DatabaseRestoreTarget
			) ||
			message.properties.messageId !== record.eventId
		) {
			throw new Error('Database restore event contract is invalid');
		}
		return {
			eventId: record.eventId,
			jobId: record.jobId,
			target: record.target as DatabaseRestoreTarget
		};
	}

	private clearSweepTimer(): void {
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.sweepTimer = null;
	}

	private safeError(error: unknown): string {
		return (error instanceof Error ? error.message : String(error))
			.replace(/[\r\n]+/g, ' ')
			.slice(0, 2_000);
	}
}
