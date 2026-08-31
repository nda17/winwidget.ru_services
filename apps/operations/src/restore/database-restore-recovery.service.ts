import { Injectable } from '@nestjs/common';
import {
	DatabaseRestoreJobPhase,
	DatabaseRestoreJobStatus
} from '@prisma/operations-client';
import {
	DATABASE_RESTORE_TARGETS,
	DatabaseRestoreTarget
} from './database-restore.contract';
import {
	DatabaseRestoreEventIdentity,
	DatabaseRestoreObservation,
	DatabaseRestoreStateService,
	RecoveredDatabaseRestoreJob
} from './database-restore-state.service';
import { DatabaseRestoreTargetRegistryService } from './database-restore-target-registry.service';
import { DatabaseRestoreExecutorService } from './database-restore-executor.service';
import {
	DatabaseRestoreWriterFenceService,
	type DatabaseRestoreWriterFenceEvidence
} from './database-restore-writer-fence.service';

const RESTORE_STATE_POLL_MS = 1_000;

@Injectable()
export class DatabaseRestoreRecoveryService {
	constructor(
		private readonly state: DatabaseRestoreStateService,
		private readonly targets: DatabaseRestoreTargetRegistryService,
		private readonly writerFence: DatabaseRestoreWriterFenceService,
		private readonly executor: DatabaseRestoreExecutorService
	) {}

	async waitForEventSettlement(
		event: DatabaseRestoreEventIdentity,
		timeoutMs: number
	): Promise<DatabaseRestoreObservation> {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			const observation = await this.state.observe(event);
			if (observation.state !== 'processing') return observation;
			const expiresAt = observation.job.leaseExpiresAt?.getTime() ?? 0;
			if (expiresAt <= Date.now()) {
				const recovered = await this.recoverExpiredJob(observation.job);
				if (recovered) {
					return { state: 'terminal', status: recovered.status };
				}
				continue;
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) return observation;
			await this.pause(
				Math.max(
					1,
					Math.min(
						RESTORE_STATE_POLL_MS,
						remaining,
						expiresAt - Date.now()
					)
				)
			);
		}
	}

	async waitForProcessingSlot(
		target: DatabaseRestoreTarget,
		timeoutMs: number
	): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			const fence = await this.state.findFence(target);
			if (!fence) return true;
			if (fence.status === 'PROCESSING') {
				const expiresAt = fence.leaseExpiresAt?.getTime() ?? 0;
				if (expiresAt <= Date.now()) {
					await this.recoverExpiredJob(fence);
					continue;
				}
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) return false;
			await this.pause(Math.min(RESTORE_STATE_POLL_MS, remaining));
		}
	}

	async recoverExpired(
		limit: number
	): Promise<RecoveredDatabaseRestoreJob[]> {
		const expired = await this.state.findExpired(limit);
		const recovered: RecoveredDatabaseRestoreJob[] = [];
		for (const job of expired) {
			const result = await this.recoverExpiredJob(job);
			if (result) recovered.push(result);
		}
		return recovered;
	}

	private async recoverExpiredJob(
		job: Parameters<DatabaseRestoreStateService['reserveExpiredJob']>[0]
	): Promise<RecoveredDatabaseRestoreJob | null> {
		const reserved = await this.state.reserveExpiredJob(job);
		if (!reserved) return null;
		if (
			!DATABASE_RESTORE_TARGETS.includes(
				reserved.target as DatabaseRestoreTarget
			)
		) {
			throw new Error('Expired database restore target is invalid');
		}
		const targetName = reserved.target as DatabaseRestoreTarget;
		const event = {
			eventId: reserved.eventId,
			jobId: reserved.id,
			target: targetName,
			sourceBackupJobId: reserved.sourceBackupJobId,
			backupProvenanceEnvelopeSha256:
				reserved.backupProvenanceEnvelopeSha256,
			backupProvenanceKeyId: reserved.backupProvenanceKeyId,
			expectedServicesSha: reserved.expectedServicesSha,
			migrationManifestSha: reserved.migrationManifestSha
		};
		const authorization = await this.state.confirmReleaseAuthorized(event);
		if (authorization) {
			const lease = {
				event,
				leaseToken: reserved.leaseToken!,
				leaseExpiresAt: reserved.leaseExpiresAt!,
				phase: reserved.phase!
			};
			const releaseEvidence = await this.executor.reconcileSucceeded(
				targetName,
				reserved.migrationManifestSha,
				authorization.writerFenceEvidenceSha256,
				async () => {
					if (!(await this.state.guardAuthorizedRelease(lease))) {
						throw new Error(
							'Database restore expired signed release guard rejected LOGIN'
						);
					}
				}
			);
			const finalized = await this.state.finalizeAuthorizedRelease(
				lease,
				releaseEvidence
			);
			if (!finalized && !(await this.state.confirmSucceeded(event))) {
				throw new Error(
					'Database restore expired authorized release could not be terminalized'
				);
			}
			return {
				id: reserved.id,
				target: reserved.target,
				status: DatabaseRestoreJobStatus.SUCCEEDED,
				phase: DatabaseRestoreJobPhase.UNFENCED
			};
		}
		let compensationEvidence: DatabaseRestoreWriterFenceEvidence | null =
			null;
		if (reserved.phase !== 'PREPARING') {
			const target = this.targets.get(targetName);
			const connection = await this.targets.connection(target);
			compensationEvidence = await this.writerFence.apply(
				connection,
				target,
				reserved.id
			);
		}
		return this.state.recoverReservedExpiredJob(
			reserved,
			compensationEvidence
		);
	}

	private pause(milliseconds: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, milliseconds));
	}
}
