import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import {
	DatabaseRestoreJobPhase,
	DatabaseRestoreJobStatus,
	DatabaseRestoreRecoveryActionPhase,
	DatabaseRestoreRecoveryActionStatus,
	DatabaseRestoreRecoveryActionType
} from '@prisma/operations-client';
import type { ConsumeMessage } from 'amqplib';
import {
	OPERATIONS_DATABASE_RESTORE_EVENT_TYPE,
	OPERATIONS_DATABASE_RESTORE_RECOVERY_EVENT_TYPE
} from '../messaging/operations-messaging.constants';
import {
	OperationsConsumeDecision,
	OperationsRabbitMqService
} from '../messaging/operations-rabbitmq.service';
import { DatabaseBackupProvenanceService } from '../maintenance/database-backup-provenance.service';
import { OperationsRuntimeService } from '../runtime/operations-runtime.service';
import { DatabaseRestoreCleanupService } from './database-restore-cleanup.service';
import {
	DATABASE_RESTORE_SERVICES_SHA_PATTERN,
	DATABASE_RESTORE_PHYSICAL_FENCE_UNCONFIRMED,
	DATABASE_RESTORE_SHA256_PATTERN,
	DATABASE_RESTORE_TARGETS,
	DatabaseRestoreTarget
} from './database-restore.contract';
import { DatabaseRestoreExecutorService } from './database-restore-executor.service';
import { DatabaseRestoreMigrationManifestService } from './database-restore-migration-manifest.service';
import { DatabaseRestoreRecoveryService } from './database-restore-recovery.service';
import { DatabaseRestoreRecoveryExecutorService } from './database-restore-recovery-executor.service';
import {
	DatabaseRestoreRecoveryEventIdentity,
	DatabaseRestoreRecoveryLease,
	DatabaseRestoreRecoveryStateService
} from './database-restore-recovery-state.service';
import { DatabaseRestoreService } from './database-restore.service';
import {
	DatabaseRestoreEventIdentity,
	DatabaseRestoreLease,
	DatabaseRestoreStateService
} from './database-restore-state.service';
import type { DatabaseRestoreWriterFenceEvidence } from './database-restore-writer-fence.service';
import { DATABASE_RESTORE_RELEASE_AUTHORIZATION_COMMIT_UNKNOWN } from './database-restore-release-authorization.service';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVENANCE_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
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
		private readonly cleanup: DatabaseRestoreCleanupService,
		private readonly manifests: DatabaseRestoreMigrationManifestService,
		private readonly recoveryState: DatabaseRestoreRecoveryStateService,
		private readonly recoveryExecutor: DatabaseRestoreRecoveryExecutorService,
		private readonly provenance: DatabaseBackupProvenanceService = new DatabaseBackupProvenanceService()
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
		if (
			message.properties.type ===
			OPERATIONS_DATABASE_RESTORE_RECOVERY_EVENT_TYPE
		) {
			return this.handleRecoveryMessage(message);
		}
		let event: DatabaseRestoreEventIdentity;
		try {
			event = this.parseEvent(message);
		} catch {
			return 'reject';
		}
		if (!this.control.isExecutionEnabled()) {
			return this.settleDisabledRestore(event);
		}
		try {
			this.assertCurrentRuntimeBinding(event);
		} catch (error) {
			const failed = await this.state.failQueuedPermanent(event, error);
			if (!failed) return this.settleUnclaimed(event);
			await this.cleanupByJob({
				id: event.jobId,
				status: DatabaseRestoreJobStatus.FAILED,
				phase: DatabaseRestoreJobPhase.PREPARING
			});
			return 'ack';
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

	private async handleRecoveryMessage(
		message: ConsumeMessage
	): Promise<OperationsConsumeDecision> {
		let event: DatabaseRestoreRecoveryEventIdentity;
		try {
			event = this.parseRecoveryEvent(message);
		} catch {
			return 'reject';
		}
		let claim;
		try {
			claim = await this.recoveryState.claim(event);
		} catch (error) {
			if (!this.isPermanentRecoveryEvidenceError(error)) throw error;
			this.logger.error(
				`Database restore recovery evidence rejected actionId=${event.actionId}: ${this.safeError(error)}`
			);
			return 'reject';
		}
		if (claim.state === 'busy') return 'requeue';
		if (claim.state === 'unclaimed') {
			const status = await this.recoveryState.observe(event);
			if (status === 'mismatched') return 'reject';
			if (status === DatabaseRestoreRecoveryActionStatus.RESOLVED) {
				return this.reconcileResolvedEvent(event);
			}
			if (
				status === DatabaseRestoreRecoveryActionStatus.BLOCKED ||
				status === DatabaseRestoreRecoveryActionStatus.EXPIRED
			) {
				return 'ack';
			}
			return 'requeue';
		}
		return this.executeRecoveryClaim(claim.lease);
	}

	private async executeRecoveryClaim(
		lease: DatabaseRestoreRecoveryLease
	): Promise<OperationsConsumeDecision> {
		const controller = new AbortController();
		this.activeControllers.add(controller);
		let leaseDeadlineTimer: NodeJS.Timeout | null = null;
		let renewalRunning = false;
		const armLeaseDeadline = () => {
			if (leaseDeadlineTimer) clearTimeout(leaseDeadlineTimer);
			leaseDeadlineTimer = setTimeout(
				() => {
					controller.abort(
						new Error('Database restore recovery lease expired')
					);
				},
				Math.max(0, lease.leaseExpiresAt.getTime() - Date.now())
			);
			leaseDeadlineTimer.unref();
		};
		armLeaseDeadline();
		const renewalTimer = setInterval(() => {
			if (renewalRunning || controller.signal.aborted) return;
			renewalRunning = true;
			void this.recoveryState
				.renew(lease)
				.then(renewed => {
					if (renewed) armLeaseDeadline();
					else {
						controller.abort(
							new Error('Database restore recovery lease was lost')
						);
					}
				})
				.catch(error => controller.abort(error))
				.finally(() => {
					renewalRunning = false;
				});
		}, RESTORE_LEASE_RENEW_MS);
		renewalTimer.unref();

		let executionCompleted = false;
		try {
			const action = await this.recoveryState.loadClaimedAction(lease);
			const source = await this.control.resolveSealedSourcePath(
				lease.event.jobId
			);
			const execution = await this.recoveryExecutor.execute({
				actionId: lease.event.actionId,
				action: lease.event.action,
				target: lease.event.target,
				source,
				sourceSha256: action.restoreJob.sourceSha256,
				safetyBackupSha256: action.restoreJob.safetyBackupSha256,
				migrationManifestSha: lease.event.migrationManifestSha,
				signal: controller.signal,
				checkpoint: async checkpoint => {
					await this.recoveryState.checkpoint(lease, checkpoint);
					if (
						checkpoint.phase === 'UNFENCING' &&
						!(await this.recoveryState.guardAuthorizedRelease(lease))
					) {
						throw new Error(
							'Database restore recovery release guard rejected LOGIN'
						);
					}
					armLeaseDeadline();
				}
			});
			executionCompleted = true;
			if (!(await this.recoveryState.resolve(lease, execution))) {
				throw new Error(
					'Database restore recovery resolution could not be persisted'
				);
			}
			return 'ack';
		} catch (error) {
			if (
				executionCompleted &&
				(await this.confirmResolvedAfterAmbiguousCommit(lease, error))
			) {
				return 'ack';
			}
			if (await this.reconcileAuthorizedRecovery(lease, error)) {
				return 'ack';
			}
			controller.abort(error);
			const compensation = await this.compensateWriterFence(
				error,
				lease.phase,
				() => this.recoveryState.renew(lease),
				() =>
					this.recoveryExecutor.reapplyFence(
						lease.event.target,
						lease.event.actionId
					),
				true
			);
			if (
				!(await this.recoveryState.block(
					lease,
					compensation.error,
					compensation.evidence
				))
			) {
				throw new Error(
					`Database restore recovery failure could not be persisted: ${this.safeError(compensation.error)}`
				);
			}
			return 'ack';
		} finally {
			clearInterval(renewalTimer);
			if (leaseDeadlineTimer) clearTimeout(leaseDeadlineTimer);
			this.activeControllers.delete(controller);
		}
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
		let executionSource = source;
		let stagingSource: string | undefined;
		let restoreCompleted = false;
		try {
			const job = await this.state.loadClaimedJob(lease);
			controller.signal.throwIfAborted();
			await this.assertClaimedJobProvenance(job, lease.event);
			controller.signal.throwIfAborted();
			const sealed = await this.control.sealSourceArtifact(
				job.id,
				job.sourceSha256,
				job.sourceSize
			);
			executionSource = sealed.sealedPath;
			stagingSource = sealed.stagingPath;
			const result = await this.executor.restore({
				jobId: job.id,
				target: lease.event.target,
				source: executionSource,
				expectedSha256: job.sourceSha256,
				migrationManifestSha: lease.event.migrationManifestSha,
				signal: controller.signal,
				checkpoint: async checkpoint => {
					await this.state.checkpoint(lease, checkpoint);
					if (
						checkpoint.phase === 'UNFENCING' &&
						!(await this.state.guardAuthorizedRelease(lease))
					) {
						throw new Error(
							'Database restore release guard rejected LOGIN'
						);
					}
					armLeaseDeadline();
				}
			});
			restoreCompleted = true;
			if (!(await this.state.succeed(lease, result))) {
				throw new Error(
					'Database restore success checkpoint could not be persisted'
				);
			}
			terminalStatus = DatabaseRestoreJobStatus.SUCCEEDED;
		} catch (error) {
			if (
				restoreCompleted &&
				(await this.confirmSucceededAfterAmbiguousCommit(lease, error))
			) {
				terminalStatus = DatabaseRestoreJobStatus.SUCCEEDED;
			} else {
				if (await this.reconcileAuthorizedRestore(lease, error)) {
					terminalStatus = DatabaseRestoreJobStatus.SUCCEEDED;
				} else {
					controller.abort(error);
					const compensation = await this.compensateWriterFence(
						error,
						lease.phase,
						() => this.state.renew(lease),
						() =>
							this.executor.reapplyFence(
								lease.event.target,
								lease.event.jobId
							),
						false
					);
					const failedStatus = await this.state.fail(
						lease,
						compensation.error,
						compensation.evidence
					);
					if (!failedStatus) {
						throw new Error(
							`Database restore failure checkpoint could not be persisted: ${this.safeError(compensation.error)}`
						);
					}
					terminalStatus = failedStatus;
				}
			}
		} finally {
			clearInterval(renewalTimer);
			if (leaseDeadlineTimer) clearTimeout(leaseDeadlineTimer);
			this.activeControllers.delete(controller);
		}

		await this.cleanup.cleanup({
			id: lease.event.jobId,
			status: terminalStatus,
			phase: lease.phase,
			source: executionSource,
			stagingSource
		});
		return 'ack';
	}

	private async reconcileAuthorizedRestore(
		lease: DatabaseRestoreLease,
		error: unknown
	): Promise<boolean> {
		const authorization = await this.state.confirmReleaseAuthorized(
			lease.event
		);
		if (!authorization) {
			if (
				lease.phase === DatabaseRestoreJobPhase.UNFENCING ||
				lease.phase === DatabaseRestoreJobPhase.UNFENCED ||
				this.safeError(error).includes(
					DATABASE_RESTORE_RELEASE_AUTHORIZATION_COMMIT_UNKNOWN
				)
			) {
				throw error;
			}
			return false;
		}
		lease.phase = DatabaseRestoreJobPhase.UNFENCING;
		const releaseEvidence = await this.executor.reconcileSucceeded(
			lease.event.target,
			lease.event.migrationManifestSha,
			authorization.writerFenceEvidenceSha256,
			async () => {
				if (!(await this.state.guardAuthorizedRelease(lease))) {
					throw new Error(
						'Database restore signed release guard rejected LOGIN'
					);
				}
			}
		);
		if (
			await this.state.finalizeAuthorizedRelease(lease, releaseEvidence)
		) {
			return true;
		}
		if (await this.state.confirmSucceeded(lease.event)) return true;
		throw new Error(
			'Database restore authorized release terminalization is ambiguous'
		);
	}

	private async reconcileAuthorizedRecovery(
		lease: DatabaseRestoreRecoveryLease,
		error: unknown
	): Promise<boolean> {
		const authorization =
			await this.recoveryState.confirmReleaseAuthorized(lease.event);
		if (!authorization) {
			if (
				lease.phase === DatabaseRestoreRecoveryActionPhase.UNFENCING ||
				this.safeError(error).includes(
					DATABASE_RESTORE_RELEASE_AUTHORIZATION_COMMIT_UNKNOWN
				)
			) {
				throw error;
			}
			return false;
		}
		lease.phase = DatabaseRestoreRecoveryActionPhase.UNFENCING;
		const releaseEvidence = await this.recoveryExecutor.reconcileResolved(
			lease.event.target,
			lease.event.migrationManifestSha,
			authorization.writerFenceEvidenceSha256,
			async () => {
				if (!(await this.recoveryState.guardAuthorizedRelease(lease))) {
					throw new Error(
						'Database restore recovery signed release guard rejected LOGIN'
					);
				}
			}
		);
		const resolved = await this.recoveryState.resolve(lease, {
			result: {
				target: lease.event.target,
				action: lease.event.action,
				reconciledFromReleaseAuthorization: true,
				releaseAuthorizationPayloadSha256: authorization.payloadSha256,
				writerFenceReleasedAt: releaseEvidence.verifiedAt.toISOString()
			},
			writerFenceReleasedAt: releaseEvidence.verifiedAt,
			writerFenceReleaseEvidenceSha256: releaseEvidence.evidenceSha256
		});
		if (resolved) return true;
		if (await this.recoveryState.confirmResolved(lease.event)) return true;
		throw new Error(
			'Database restore recovery authorized release terminalization is ambiguous'
		);
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
		if (observation.state === 'terminal') {
			if (observation.status !== DatabaseRestoreJobStatus.SUCCEEDED) {
				return 'ack';
			}
			return this.reconcileSucceededEvent(event);
		}
		return 'requeue';
	}

	private async settleDisabledRestore(
		event: DatabaseRestoreEventIdentity
	): Promise<OperationsConsumeDecision> {
		const observation = await this.state.observe(event);
		if (
			observation.state === 'missing' ||
			observation.state === 'mismatched'
		) {
			return 'reject';
		}
		if (observation.state !== 'terminal') return 'requeue';
		if (observation.status !== DatabaseRestoreJobStatus.SUCCEEDED) {
			return 'ack';
		}
		return this.reconcileSucceededEvent(event);
	}

	private async compensateWriterFence(
		error: unknown,
		phase: DatabaseRestoreJobPhase | DatabaseRestoreRecoveryActionPhase,
		renewLease: () => Promise<boolean>,
		reapply: () => Promise<DatabaseRestoreWriterFenceEvidence>,
		fenceFromPreparing: boolean
	): Promise<{
		error: unknown;
		evidence: DatabaseRestoreWriterFenceEvidence | null;
	}> {
		if (phase === 'PREPARING' && !fenceFromPreparing) {
			return { error, evidence: null };
		}
		try {
			if (!(await renewLease())) {
				throw new Error(
					'exact execution lease was lost before writer fence reapply'
				);
			}
			return { error, evidence: await reapply() };
		} catch (fenceError) {
			return {
				error: new Error(
					`${DATABASE_RESTORE_PHYSICAL_FENCE_UNCONFIRMED}: original=${this.safeError(error)}; compensation=${this.safeError(fenceError)}`
				),
				evidence: null
			};
		}
	}

	private async reconcileSucceededEvent(
		event: DatabaseRestoreEventIdentity
	): Promise<OperationsConsumeDecision> {
		const barrier = await this.state.acquireReconciliation(event.jobId);
		if (!barrier) return 'requeue';
		try {
			if (!(await this.state.confirmSucceeded(event))) {
				this.logger.error(
					`Database restore terminal evidence is incomplete jobId=${event.jobId}`
				);
				return 'reject';
			}
			if (
				await this.state.hasOtherUnresolvedRecovery(
					event.target,
					event.jobId
				)
			) {
				this.logger.warn(
					`Database restore terminal reconciliation skipped because a newer recovery is unresolved target=${event.target} jobId=${event.jobId}`
				);
				return 'ack';
			}
			const authorization =
				await this.state.confirmReleaseAuthorized(event);
			if (!authorization) {
				this.logger.error(
					`Database restore terminal release authorization is missing jobId=${event.jobId}`
				);
				return 'reject';
			}
			await this.executor.reconcileSucceeded(
				event.target,
				event.migrationManifestSha,
				authorization.writerFenceEvidenceSha256,
				async () => {
					if (
						!(await this.state.guardReconciliationRelease(
							barrier,
							event.target,
							event.jobId
						))
					) {
						throw new Error(
							'Database restore terminal reconciliation guard rejected LOGIN'
						);
					}
				}
			);
			return 'ack';
		} finally {
			if (!(await this.state.releaseReconciliation(barrier))) {
				throw new Error(
					'Database restore terminal reconciliation lease could not be released'
				);
			}
		}
	}

	private async reconcileResolvedEvent(
		event: DatabaseRestoreRecoveryEventIdentity
	): Promise<OperationsConsumeDecision> {
		const barrier = await this.state.acquireReconciliation(event.actionId);
		if (!barrier) return 'requeue';
		try {
			if (!(await this.recoveryState.confirmResolved(event))) {
				this.logger.error(
					`Database restore recovery terminal evidence is incomplete actionId=${event.actionId}`
				);
				return 'reject';
			}
			if (
				await this.state.hasOtherUnresolvedRecovery(
					event.target,
					event.jobId
				)
			) {
				this.logger.warn(
					`Database restore recovery reconciliation skipped because a newer recovery is unresolved target=${event.target} jobId=${event.jobId}`
				);
				return 'ack';
			}
			const authorization =
				await this.recoveryState.confirmReleaseAuthorized(event);
			if (!authorization) {
				this.logger.error(
					`Database restore recovery release authorization is missing actionId=${event.actionId}`
				);
				return 'reject';
			}
			await this.recoveryExecutor.reconcileResolved(
				event.target,
				event.migrationManifestSha,
				authorization.writerFenceEvidenceSha256,
				async () => {
					if (
						!(await this.state.guardReconciliationRelease(
							barrier,
							event.target,
							event.jobId
						))
					) {
						throw new Error(
							'Database restore recovery reconciliation guard rejected LOGIN'
						);
					}
				}
			);
			return 'ack';
		} finally {
			if (!(await this.state.releaseReconciliation(barrier))) {
				throw new Error(
					'Database restore recovery reconciliation lease could not be released'
				);
			}
		}
	}

	private async confirmSucceededAfterAmbiguousCommit(
		lease: DatabaseRestoreLease,
		error: unknown
	): Promise<boolean> {
		try {
			const confirmed = await this.state.confirmSucceeded(lease.event);
			if (confirmed) {
				this.logger.warn(
					`Database restore terminal commit confirmed by read-back jobId=${lease.event.jobId}`
				);
			}
			return confirmed;
		} catch (confirmationError) {
			this.logger.error(
				`Database restore terminal commit read-back failed jobId=${lease.event.jobId}: original=${this.safeError(error)} confirmation=${this.safeError(confirmationError)}`
			);
			return false;
		}
	}

	private async confirmResolvedAfterAmbiguousCommit(
		lease: DatabaseRestoreRecoveryLease,
		error: unknown
	): Promise<boolean> {
		try {
			const confirmed = await this.recoveryState.confirmResolved(
				lease.event
			);
			if (confirmed) {
				this.logger.warn(
					`Database restore recovery commit confirmed by read-back actionId=${lease.event.actionId}`
				);
			}
			return confirmed;
		} catch (confirmationError) {
			this.logger.error(
				`Database restore recovery commit read-back failed actionId=${lease.event.actionId}: original=${this.safeError(error)} confirmation=${this.safeError(confirmationError)}`
			);
			return false;
		}
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
		await this.recoveryState.recoverExpired(RESTORE_SWEEP_BATCH_SIZE);
		const recovered = await this.recovery.recoverExpired(
			RESTORE_SWEEP_BATCH_SIZE
		);
		for (const job of recovered) await this.cleanupByJob(job);
		const pendingCleanup = await this.cleanup.pending(
			RESTORE_SWEEP_BATCH_SIZE
		);
		for (const job of pendingCleanup) await this.cleanupByJob(job);
		await this.cleanup.sweepOrphans(RESTORE_SWEEP_BATCH_SIZE);
	}

	private parseRecoveryEvent(
		message: ConsumeMessage
	): DatabaseRestoreRecoveryEventIdentity {
		if (message.content.length > 64 * 1024) {
			throw new Error('Database restore recovery message is invalid');
		}
		const value = JSON.parse(message.content.toString('utf8')) as unknown;
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Database restore recovery event is invalid');
		}
		const record = value as Record<string, unknown>;
		const currentServicesSha = process.env.APP_REVISION?.trim();
		const actions = Object.values(DatabaseRestoreRecoveryActionType);
		if (
			Object.keys(record).sort().join(',') !==
				'action,actionId,eventId,expectedServicesSha,jobId,migrationManifestSha,receiptPayloadSha,schemaVersion,target' ||
			record.schemaVersion !== 1 ||
			typeof record.eventId !== 'string' ||
			!UUID_PATTERN.test(record.eventId) ||
			typeof record.actionId !== 'string' ||
			!UUID_PATTERN.test(record.actionId) ||
			typeof record.jobId !== 'string' ||
			!UUID_PATTERN.test(record.jobId) ||
			typeof record.target !== 'string' ||
			!DATABASE_RESTORE_TARGETS.includes(
				record.target as DatabaseRestoreTarget
			) ||
			typeof record.action !== 'string' ||
			!actions.includes(
				record.action as DatabaseRestoreRecoveryActionType
			) ||
			typeof record.receiptPayloadSha !== 'string' ||
			!DATABASE_RESTORE_SHA256_PATTERN.test(record.receiptPayloadSha) ||
			typeof record.expectedServicesSha !== 'string' ||
			!DATABASE_RESTORE_SERVICES_SHA_PATTERN.test(
				record.expectedServicesSha
			) ||
			record.expectedServicesSha !== currentServicesSha ||
			typeof record.migrationManifestSha !== 'string' ||
			!DATABASE_RESTORE_SHA256_PATTERN.test(record.migrationManifestSha) ||
			message.properties.messageId !== record.eventId
		) {
			throw new Error(
				'Database restore recovery event contract is invalid'
			);
		}
		this.manifests.assertBinding(
			record.target as DatabaseRestoreTarget,
			record.migrationManifestSha as string
		);
		return {
			eventId: record.eventId,
			actionId: record.actionId,
			jobId: record.jobId,
			target: record.target as DatabaseRestoreTarget,
			action: record.action as DatabaseRestoreRecoveryActionType,
			receiptPayloadSha: record.receiptPayloadSha,
			expectedServicesSha: record.expectedServicesSha,
			migrationManifestSha: record.migrationManifestSha
		};
	}

	private async cleanupByJob(job: {
		id: string;
		status: DatabaseRestoreJobStatus;
		phase: DatabaseRestoreJobPhase | null;
		recoveryResolvedAt?: Date | null;
		artifactRetainUntil?: Date | null;
		sourceDeletedAt?: Date | null;
		safetyDeletedAt?: Date | null;
	}): Promise<void> {
		if (
			job.status === DatabaseRestoreJobStatus.RECOVERY_REQUIRED &&
			!job.recoveryResolvedAt
		) {
			return;
		}
		let source: string;
		let stagingSource: string;
		try {
			[source, stagingSource] = await Promise.all([
				this.control.resolveSealedSourcePath(job.id),
				this.control.resolveSourcePath(job.id)
			]);
		} catch (error) {
			await this.cleanup.recordError(job.id, job.status, error);
			return;
		}
		await this.cleanup.cleanup({ ...job, source, stagingSource });
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
				'backupProvenanceEnvelopeSha256,backupProvenanceKeyId,eventId,expectedServicesSha,jobId,migrationManifestSha,schemaVersion,sourceBackupJobId,target' ||
			record.schemaVersion !== 3 ||
			typeof record.eventId !== 'string' ||
			!UUID_PATTERN.test(record.eventId) ||
			typeof record.jobId !== 'string' ||
			!UUID_PATTERN.test(record.jobId) ||
			typeof record.target !== 'string' ||
			!DATABASE_RESTORE_TARGETS.includes(
				record.target as DatabaseRestoreTarget
			) ||
			typeof record.sourceBackupJobId !== 'string' ||
			!UUID_PATTERN.test(record.sourceBackupJobId) ||
			typeof record.backupProvenanceEnvelopeSha256 !== 'string' ||
			!DATABASE_RESTORE_SHA256_PATTERN.test(
				record.backupProvenanceEnvelopeSha256
			) ||
			typeof record.backupProvenanceKeyId !== 'string' ||
			!PROVENANCE_KEY_ID_PATTERN.test(record.backupProvenanceKeyId) ||
			typeof record.expectedServicesSha !== 'string' ||
			!DATABASE_RESTORE_SERVICES_SHA_PATTERN.test(
				record.expectedServicesSha
			) ||
			typeof record.migrationManifestSha !== 'string' ||
			!DATABASE_RESTORE_SHA256_PATTERN.test(record.migrationManifestSha) ||
			message.properties.messageId !== record.eventId
		) {
			throw new Error('Database restore event contract is invalid');
		}
		return {
			eventId: record.eventId,
			jobId: record.jobId,
			target: record.target as DatabaseRestoreTarget,
			sourceBackupJobId: record.sourceBackupJobId,
			backupProvenanceEnvelopeSha256:
				record.backupProvenanceEnvelopeSha256,
			backupProvenanceKeyId: record.backupProvenanceKeyId,
			expectedServicesSha: record.expectedServicesSha,
			migrationManifestSha: record.migrationManifestSha
		};
	}

	private async assertClaimedJobProvenance(
		job: {
			sourceSha256: string;
			sourceSize: bigint;
			sourceFileName: string;
			sourceBackupJobId: string;
			backupProvenance: string;
			backupProvenanceEnvelopeSha256: string;
			backupProvenanceKeyId: string;
			migrationManifestSha: string;
		},
		event: DatabaseRestoreEventIdentity
	): Promise<void> {
		let value: unknown;
		try {
			value = JSON.parse(job.backupProvenance) as unknown;
		} catch {
			throw new Error(
				'Database restore backup provenance JSON is invalid'
			);
		}
		const envelope = await this.provenance.verify(value);
		const signed = value as { envelopeSha256?: unknown };
		const evidence = envelope.evidence;
		if (
			evidence.target !== event.target ||
			evidence.backupJobId !== event.sourceBackupJobId ||
			evidence.backupJobId !== job.sourceBackupJobId ||
			evidence.artifactSha256 !== job.sourceSha256 ||
			BigInt(evidence.fileSize) !== job.sourceSize ||
			evidence.fileName !== job.sourceFileName ||
			evidence.migrationManifestSha !== event.migrationManifestSha ||
			evidence.migrationManifestSha !== job.migrationManifestSha ||
			evidence.servicesSha !== event.expectedServicesSha ||
			evidence.imageRevision !== event.expectedServicesSha ||
			signed.envelopeSha256 !== event.backupProvenanceEnvelopeSha256 ||
			signed.envelopeSha256 !== job.backupProvenanceEnvelopeSha256 ||
			envelope.keyId !== event.backupProvenanceKeyId ||
			envelope.keyId !== job.backupProvenanceKeyId
		) {
			throw new Error(
				'Database restore backup provenance binding is invalid'
			);
		}
	}

	private assertCurrentRuntimeBinding(
		event: DatabaseRestoreEventIdentity
	): void {
		if (event.expectedServicesSha !== process.env.APP_REVISION?.trim()) {
			throw new Error(
				'Database restore event belongs to a different services revision'
			);
		}
		this.manifests.assertBinding(event.target, event.migrationManifestSha);
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

	private isPermanentRecoveryEvidenceError(error: unknown): boolean {
		const message = this.safeError(error);
		return [
			'Database restore recovery initial evidence is invalid',
			'Database restore recovery action is not bound to the signed receipt',
			'Database restore receipt signing key ID is not active',
			'Database restore receipt signature is invalid',
			'Database restore receipt signing is not configured',
			'Database restore receipt signing key is invalid'
		].some(value => message.includes(value));
	}
}
