import { Injectable } from '@nestjs/common';
import {
	DatabaseRestoreJobPhase,
	DatabaseRestoreJobStatus,
	DatabaseRestoreExecutionOperationType,
	DatabaseRestorePermitStatus,
	OperationalAlertSeverity,
	Prisma
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import {
	OperationalAlertService,
	RecordOperationalAlertInput
} from '../monitoring/operational-alert.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import {
	DATABASE_RESTORE_PHYSICAL_FENCE_UNCONFIRMED,
	DatabaseRestoreTarget
} from './database-restore.contract';
import { DatabaseRestoreCheckpoint } from './database-restore-executor.service';
import { DatabaseRestoreReceiptService } from './database-restore-receipt.service';
import {
	DATABASE_RESTORE_RELEASE_AUTHORIZATION_COMMIT_UNKNOWN,
	DatabaseRestoreReleaseAuthorizationService
} from './database-restore-release-authorization.service';
import type { DatabaseRestoreWriterFenceEvidence } from './database-restore-writer-fence.service';

const RESTORE_LEASE_MS = 60_000;

export interface DatabaseRestoreEventIdentity {
	eventId: string;
	jobId: string;
	target: DatabaseRestoreTarget;
	sourceBackupJobId: string;
	backupProvenanceEnvelopeSha256: string;
	backupProvenanceKeyId: string;
	expectedServicesSha: string;
	migrationManifestSha: string;
}

export interface DatabaseRestoreLease {
	event: DatabaseRestoreEventIdentity;
	leaseToken: string;
	leaseExpiresAt: Date;
	phase: DatabaseRestoreJobPhase;
}

export interface DatabaseRestoreReconciliationLease {
	operationId: string;
	leaseToken: string;
	leaseExpiresAt: Date;
}

export type DatabaseRestoreClaim =
	| { state: 'claimed'; lease: DatabaseRestoreLease }
	| { state: 'busy' }
	| { state: 'unclaimed' };

export type DatabaseRestoreObservation =
	| { state: 'missing' | 'mismatched' }
	| { state: 'queued' }
	| {
			state: 'processing';
			job: ExpirableRestoreJob;
	  }
	| { state: 'terminal'; status: DatabaseRestoreJobStatus };

export interface RecoveredDatabaseRestoreJob {
	id: string;
	target: string;
	status: DatabaseRestoreJobStatus;
	phase: DatabaseRestoreJobPhase | null;
}

export interface ExpirableRestoreJob {
	id: string;
	target: string;
	eventId: string;
	sourceBackupJobId: string;
	backupProvenanceEnvelopeSha256: string;
	backupProvenanceKeyId: string;
	expectedServicesSha: string;
	migrationManifestSha: string;
	status: DatabaseRestoreJobStatus;
	phase: DatabaseRestoreJobPhase | null;
	leaseToken: string | null;
	leaseExpiresAt: Date | null;
}

@Injectable()
export class DatabaseRestoreStateService {
	private readonly instanceId = randomUUID();
	private readonly releaseAuthorizations: DatabaseRestoreReleaseAuthorizationService;

	constructor(
		private readonly prisma: OperationsPrismaService,
		private readonly alerts: OperationalAlertService,
		private readonly receipts: DatabaseRestoreReceiptService = new DatabaseRestoreReceiptService(),
		releaseAuthorizations?: DatabaseRestoreReleaseAuthorizationService
	) {
		this.releaseAuthorizations =
			releaseAuthorizations ??
			new DatabaseRestoreReleaseAuthorizationService(prisma, receipts);
	}

	async claim(
		event: DatabaseRestoreEventIdentity
	): Promise<DatabaseRestoreClaim> {
		const leaseToken = randomUUID();
		const leaseExpiresAt = this.nextLeaseExpiry();
		try {
			return await this.prisma.$transaction(async transaction => {
				const executionLease =
					await transaction.databaseRestoreExecutionLease.updateMany({
						where: {
							id: 'singleton',
							leaseExpiresAt: null
						},
						data: {
							operationType: DatabaseRestoreExecutionOperationType.RESTORE,
							operationId: event.jobId,
							leaseOwner: this.instanceId,
							leaseToken,
							leaseExpiresAt
						}
					});
				if (executionLease.count !== 1) return { state: 'busy' } as const;
				const claimed = await transaction.databaseRestoreJob.updateMany({
					where: {
						id: event.jobId,
						target: event.target,
						eventId: event.eventId,
						sourceBackupJobId: event.sourceBackupJobId,
						backupProvenanceEnvelopeSha256:
							event.backupProvenanceEnvelopeSha256,
						backupProvenanceKeyId: event.backupProvenanceKeyId,
						expectedServicesSha: event.expectedServicesSha,
						migrationManifestSha: event.migrationManifestSha,
						status: DatabaseRestoreJobStatus.QUEUED
					},
					data: {
						status: DatabaseRestoreJobStatus.PROCESSING,
						phase: DatabaseRestoreJobPhase.PREPARING,
						leaseOwner: this.instanceId,
						leaseToken,
						leaseExpiresAt,
						attempts: { increment: 1 },
						startedAt: new Date(),
						finishedAt: null,
						lastError: null
					}
				});
				if (claimed.count !== 1) {
					await transaction.databaseRestoreExecutionLease.updateMany({
						where: { id: 'singleton', leaseToken },
						data: {
							operationType: null,
							operationId: null,
							leaseOwner: null,
							leaseToken: null,
							leaseExpiresAt: null
						}
					});
					return { state: 'unclaimed' } as const;
				}
				return {
					state: 'claimed',
					lease: {
						event,
						leaseToken,
						leaseExpiresAt,
						phase: DatabaseRestoreJobPhase.PREPARING
					}
				};
			});
		} catch (error) {
			if (this.isUniqueConflict(error)) return { state: 'busy' };
			throw error;
		}
	}

	async acquireReconciliation(
		operationId: string
	): Promise<DatabaseRestoreReconciliationLease | null> {
		const leaseToken = randomUUID();
		const leaseExpiresAt = this.nextLeaseExpiry();
		const acquired =
			await this.prisma.databaseRestoreExecutionLease.updateMany({
				where: {
					id: 'singleton',
					OR: [
						{ leaseExpiresAt: null },
						{
							operationType:
								DatabaseRestoreExecutionOperationType.RECONCILIATION,
							leaseExpiresAt: { lte: new Date() }
						}
					]
				},
				data: {
					operationType:
						DatabaseRestoreExecutionOperationType.RECONCILIATION,
					operationId,
					leaseOwner: this.instanceId,
					leaseToken,
					leaseExpiresAt
				}
			});
		return acquired.count === 1
			? { operationId, leaseToken, leaseExpiresAt }
			: null;
	}

	async releaseReconciliation(
		lease: DatabaseRestoreReconciliationLease
	): Promise<boolean> {
		const released =
			await this.prisma.databaseRestoreExecutionLease.updateMany({
				where: {
					id: 'singleton',
					operationType:
						DatabaseRestoreExecutionOperationType.RECONCILIATION,
					operationId: lease.operationId,
					leaseOwner: this.instanceId,
					leaseToken: lease.leaseToken,
					leaseExpiresAt: { gt: new Date() }
				},
				data: {
					operationType: null,
					operationId: null,
					leaseOwner: null,
					leaseToken: null,
					leaseExpiresAt: null
				}
			});
		return released.count === 1;
	}

	async hasOtherUnresolvedRecovery(
		target: DatabaseRestoreTarget,
		excludedJobId: string
	): Promise<boolean> {
		const job = await this.prisma.databaseRestoreJob.findFirst({
			where: {
				target,
				id: { not: excludedJobId },
				status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED,
				recoveryResolvedAt: null
			},
			select: { id: true }
		});
		return job !== null;
	}

	async loadClaimedJob(lease: DatabaseRestoreLease): Promise<{
		id: string;
		sourceSha256: string;
		sourceSize: bigint;
		sourceFileName: string;
		sourceBackupJobId: string;
		backupProvenance: string;
		backupProvenanceEnvelopeSha256: string;
		backupProvenanceKeyId: string;
		migrationManifestSha: string;
	}> {
		return this.prisma.databaseRestoreJob.findFirstOrThrow({
			where: {
				id: lease.event.jobId,
				target: lease.event.target,
				eventId: lease.event.eventId,
				sourceBackupJobId: lease.event.sourceBackupJobId,
				backupProvenanceEnvelopeSha256:
					lease.event.backupProvenanceEnvelopeSha256,
				backupProvenanceKeyId: lease.event.backupProvenanceKeyId,
				expectedServicesSha: lease.event.expectedServicesSha,
				migrationManifestSha: lease.event.migrationManifestSha,
				status: DatabaseRestoreJobStatus.PROCESSING,
				leaseToken: lease.leaseToken
			},
			select: {
				id: true,
				sourceSha256: true,
				sourceSize: true,
				sourceFileName: true,
				sourceBackupJobId: true,
				backupProvenance: true,
				backupProvenanceEnvelopeSha256: true,
				backupProvenanceKeyId: true,
				migrationManifestSha: true
			}
		});
	}

	async renew(lease: DatabaseRestoreLease): Promise<boolean> {
		const requestedLeaseExpiresAt = this.nextLeaseExpiry();
		const leaseExpiresAt = await this.prisma.$transaction(
			async transaction => {
				await transaction.databaseRestoreExecutionLease.updateMany({
					where: {
						id: 'singleton',
						operationType: DatabaseRestoreExecutionOperationType.RESTORE,
						operationId: lease.event.jobId,
						leaseToken: lease.leaseToken,
						leaseExpiresAt: {
							gt: new Date(),
							lt: requestedLeaseExpiresAt
						}
					},
					data: { leaseExpiresAt: requestedLeaseExpiresAt }
				});
				const executionLease =
					await transaction.databaseRestoreExecutionLease.findFirst({
						where: {
							id: 'singleton',
							operationType: DatabaseRestoreExecutionOperationType.RESTORE,
							operationId: lease.event.jobId,
							leaseToken: lease.leaseToken,
							leaseExpiresAt: { gt: new Date() }
						},
						select: { leaseExpiresAt: true }
					});
				if (!executionLease?.leaseExpiresAt) return null;
				await transaction.databaseRestoreJob.updateMany({
					where: {
						id: lease.event.jobId,
						target: lease.event.target,
						eventId: lease.event.eventId,
						status: DatabaseRestoreJobStatus.PROCESSING,
						leaseToken: lease.leaseToken,
						leaseExpiresAt: {
							gt: new Date(),
							lt: requestedLeaseExpiresAt
						}
					},
					data: { leaseExpiresAt: requestedLeaseExpiresAt }
				});
				const job = await transaction.databaseRestoreJob.findFirst({
					where: {
						id: lease.event.jobId,
						target: lease.event.target,
						eventId: lease.event.eventId,
						status: DatabaseRestoreJobStatus.PROCESSING,
						leaseToken: lease.leaseToken,
						leaseExpiresAt: { gt: new Date() }
					},
					select: { leaseExpiresAt: true }
				});
				if (!job?.leaseExpiresAt) {
					throw new Error('Database restore lease state diverged');
				}
				return new Date(
					Math.min(
						executionLease.leaseExpiresAt.getTime(),
						job.leaseExpiresAt.getTime()
					)
				);
			}
		);
		if (!leaseExpiresAt) return false;
		lease.leaseExpiresAt = leaseExpiresAt;
		return true;
	}

	async checkpoint(
		lease: DatabaseRestoreLease,
		checkpoint: DatabaseRestoreCheckpoint
	): Promise<void> {
		const nextPhase = this.checkpointPhase(checkpoint);
		const expectedPhase = this.expectedCheckpointPhase(nextPhase);
		if (lease.phase !== expectedPhase) {
			throw new Error('Database restore checkpoint order is invalid');
		}
		if (
			checkpoint.phase === 'UNFENCED' &&
			!(await this.releaseAuthorizations.assertRestore(lease.event))
		) {
			throw new Error(
				'Database restore LOGIN release has no signed authorization'
			);
		}
		const leaseExpiresAt = this.nextLeaseExpiry();
		try {
			await this.prisma.$transaction(async transaction => {
				const executionLease =
					await transaction.databaseRestoreExecutionLease.updateMany({
						where: {
							id: 'singleton',
							operationType: DatabaseRestoreExecutionOperationType.RESTORE,
							operationId: lease.event.jobId,
							leaseToken: lease.leaseToken,
							leaseExpiresAt: { gt: new Date() }
						},
						data: { leaseExpiresAt }
					});
				if (executionLease.count !== 1) {
					throw new Error(
						`Database restore ${checkpoint.phase} checkpoint lost its execution lease`
					);
				}
				const changed = await transaction.databaseRestoreJob.updateMany({
					where: {
						id: lease.event.jobId,
						target: lease.event.target,
						eventId: lease.event.eventId,
						status: DatabaseRestoreJobStatus.PROCESSING,
						phase: expectedPhase,
						leaseToken: lease.leaseToken,
						leaseExpiresAt: { gt: new Date() }
					},
					data: {
						phase: nextPhase,
						leaseExpiresAt,
						...(checkpoint.phase === 'FENCING'
							? {
									writerFenceRoles: checkpoint.writerFenceRoles,
									writerFenceRequestedAt: new Date()
								}
							: {}),
						...(checkpoint.phase === 'FENCED'
							? {
									writerFenceRoles: checkpoint.writerFenceRoles,
									writerFenceAppliedAt: checkpoint.writerFenceAppliedAt,
									writerFenceEvidenceSha256:
										checkpoint.writerFenceEvidenceSha256
								}
							: {}),
						...(checkpoint.phase === 'SAFETY_READY'
							? {
									safetyBackupFileName: checkpoint.safetyBackupFileName,
									safetyBackupSha256: checkpoint.safetyBackupSha256
								}
							: {}),
						...(checkpoint.phase === 'UNFENCED'
							? {
									writerFenceReleasedAt: checkpoint.writerFenceReleasedAt,
									writerFenceReleaseEvidenceSha256:
										checkpoint.writerFenceReleaseEvidenceSha256
								}
							: {})
					}
				});
				if (changed.count !== 1) {
					throw new Error(
						`Database restore ${checkpoint.phase} checkpoint could not be persisted`
					);
				}
				if (checkpoint.phase === 'UNFENCING') {
					await this.releaseAuthorizations.createRestore(
						transaction,
						lease.event.jobId,
						checkpoint
					);
				}
			});
		} catch (error) {
			if (checkpoint.phase === 'UNFENCING') {
				throw new Error(
					`${DATABASE_RESTORE_RELEASE_AUTHORIZATION_COMMIT_UNKNOWN}: ${this.safeError(error)}`
				);
			}
			throw error;
		}
		if (checkpoint.phase === 'UNFENCING') {
			try {
				if (!(await this.confirmReleaseAuthorized(lease.event))) {
					throw new Error('signed read-back returned no authorization');
				}
			} catch (error) {
				throw new Error(
					`${DATABASE_RESTORE_RELEASE_AUTHORIZATION_COMMIT_UNKNOWN}: ${this.safeError(error)}`
				);
			}
		}
		lease.phase = nextPhase;
		lease.leaseExpiresAt = leaseExpiresAt;
	}

	async confirmReleaseAuthorized(event: DatabaseRestoreEventIdentity) {
		return this.releaseAuthorizations.assertRestore(event);
	}

	async guardAuthorizedRelease(lease: DatabaseRestoreLease) {
		const authorization = await this.confirmReleaseAuthorized(lease.event);
		if (!authorization) return null;
		if (
			await this.hasOtherUnresolvedRecovery(
				lease.event.target,
				lease.event.jobId
			)
		) {
			throw new Error(
				'Database restore signed release authorization is blocked by a newer unresolved recovery generation'
			);
		}
		if (!(await this.renew(lease))) {
			throw new Error(
				'Database restore signed release authorization lost its exact execution lease'
			);
		}
		return authorization;
	}

	async guardReconciliationRelease(
		lease: DatabaseRestoreReconciliationLease,
		target: DatabaseRestoreTarget,
		excludedJobId: string
	): Promise<boolean> {
		if (await this.hasOtherUnresolvedRecovery(target, excludedJobId)) {
			return false;
		}
		const leaseExpiresAt = this.nextLeaseExpiry();
		const renewed =
			await this.prisma.databaseRestoreExecutionLease.updateMany({
				where: {
					id: 'singleton',
					operationType:
						DatabaseRestoreExecutionOperationType.RECONCILIATION,
					operationId: lease.operationId,
					leaseOwner: this.instanceId,
					leaseToken: lease.leaseToken,
					leaseExpiresAt: { gt: new Date() }
				},
				data: { leaseExpiresAt }
			});
		if (renewed.count !== 1) return false;
		lease.leaseExpiresAt = leaseExpiresAt;
		return true;
	}

	async finalizeAuthorizedRelease(
		lease: DatabaseRestoreLease,
		releaseEvidence: DatabaseRestoreWriterFenceEvidence
	): Promise<boolean> {
		const authorization = await this.confirmReleaseAuthorized(lease.event);
		if (!authorization) {
			throw new Error(
				'Database restore release authorization is missing during reconciliation'
			);
		}
		if (lease.phase === DatabaseRestoreJobPhase.UNFENCING) {
			await this.checkpoint(lease, {
				phase: 'UNFENCED',
				writerFenceReleasedAt: releaseEvidence.verifiedAt,
				writerFenceReleaseEvidenceSha256: releaseEvidence.evidenceSha256
			});
		}
		if (lease.phase !== DatabaseRestoreJobPhase.UNFENCED) {
			throw new Error(
				'Database restore authorized release phase is invalid'
			);
		}
		return this.succeed(lease, {
			target: lease.event.target,
			reconciledFromReleaseAuthorization: true,
			releaseAuthorizationPayloadSha256: authorization.payloadSha256,
			verifiedAt: authorization.verifiedAt.toISOString(),
			writerFenceAppliedAt:
				authorization.writerFenceAppliedAt.toISOString(),
			writerFenceReleasedAt: releaseEvidence.verifiedAt.toISOString()
		});
	}

	async succeed(
		lease: DatabaseRestoreLease,
		result: Prisma.InputJsonValue
	): Promise<boolean> {
		const releaseAuthorization =
			await this.releaseAuthorizations.assertRestore(lease.event);
		if (!releaseAuthorization) {
			throw new Error(
				'Database restore success has no signed release authorization'
			);
		}
		const finishedAt = new Date();
		const artifactRetainUntil = new Date(
			finishedAt.getTime() + this.retentionHours() * 60 * 60_000
		);
		return this.prisma.$transaction(async transaction => {
			const succeeded = await transaction.databaseRestoreJob.updateMany({
				where: {
					id: lease.event.jobId,
					target: lease.event.target,
					eventId: lease.event.eventId,
					status: DatabaseRestoreJobStatus.PROCESSING,
					phase: DatabaseRestoreJobPhase.UNFENCED,
					leaseToken: lease.leaseToken,
					leaseExpiresAt: { gt: new Date() }
				},
				data: {
					status: DatabaseRestoreJobStatus.SUCCEEDED,
					result,
					lastError: null,
					finishedAt,
					artifactRetainUntil,
					leaseOwner: null,
					leaseToken: null,
					leaseExpiresAt: null
				}
			});
			if (succeeded.count !== 1) return false;
			const released =
				await transaction.databaseRestoreExecutionLease.updateMany({
					where: {
						id: 'singleton',
						operationType: DatabaseRestoreExecutionOperationType.RESTORE,
						operationId: lease.event.jobId,
						leaseToken: lease.leaseToken
					},
					data: {
						operationType: null,
						operationId: null,
						leaseOwner: null,
						leaseToken: null,
						leaseExpiresAt: null
					}
				});
			if (released.count !== 1) {
				throw new Error(
					'Database restore execution lease could not be released'
				);
			}
			await this.alerts.resolveInTransaction(
				transaction,
				`database-restore:${lease.event.target}`
			);
			await this.createTerminalReceiptInTransaction(
				transaction,
				lease.event.jobId
			);
			return true;
		});
	}

	async confirmSucceeded(
		event: DatabaseRestoreEventIdentity
	): Promise<boolean> {
		const releaseAuthorization =
			await this.releaseAuthorizations.assertRestore(event);
		if (!releaseAuthorization) return false;
		const job = await this.prisma.databaseRestoreJob.findUnique({
			where: { id: event.jobId },
			include: { terminalReceipt: true }
		});
		const receipt = job?.terminalReceipt;
		if (
			!job ||
			!receipt ||
			job.target !== event.target ||
			job.eventId !== event.eventId ||
			job.sourceBackupJobId !== event.sourceBackupJobId ||
			job.backupProvenanceEnvelopeSha256 !==
				event.backupProvenanceEnvelopeSha256 ||
			job.backupProvenanceKeyId !== event.backupProvenanceKeyId ||
			job.expectedServicesSha !== event.expectedServicesSha ||
			job.migrationManifestSha !== event.migrationManifestSha ||
			job.status !== DatabaseRestoreJobStatus.SUCCEEDED ||
			job.phase !== DatabaseRestoreJobPhase.UNFENCED ||
			!job.finishedAt ||
			receipt.jobId !== job.id ||
			receipt.permitId !== job.permitId ||
			receipt.permitRequestedById !== job.requestedById ||
			receipt.terminalStatus !== job.status ||
			receipt.phase !== job.phase ||
			receipt.target !== job.target ||
			receipt.sourceSha256 !== job.sourceSha256 ||
			receipt.sourceSize !== job.sourceSize ||
			receipt.sourceBackupJobId !== job.sourceBackupJobId ||
			receipt.backupProvenanceEnvelopeSha256 !==
				job.backupProvenanceEnvelopeSha256 ||
			receipt.backupProvenanceKeyId !== job.backupProvenanceKeyId ||
			receipt.safetyBackupSha256 !== job.safetyBackupSha256 ||
			receipt.expectedServicesSha !== job.expectedServicesSha ||
			receipt.migrationManifestSha !== job.migrationManifestSha ||
			receipt.releaseAuthorizationPayloadSha256 !==
				releaseAuthorization.payloadSha256 ||
			receipt.completedAt.getTime() !== job.finishedAt.getTime()
		) {
			return false;
		}
		const resultSha256 =
			job.result === null
				? null
				: this.receipts.sha256(this.receipts.canonicalize(job.result));
		const errorSha256 = job.lastError
			? this.receipts.sha256(job.lastError)
			: null;
		if (
			receipt.resultSha256 !== resultSha256 ||
			receipt.errorSha256 !== errorSha256 ||
			this.receipts.canonicalize(receipt.writerFenceRoles) !==
				this.receipts.canonicalize(job.writerFenceRoles) ||
			receipt.writerFenceRequestedAt?.getTime() !==
				job.writerFenceRequestedAt?.getTime() ||
			receipt.writerFenceAppliedAt?.getTime() !==
				job.writerFenceAppliedAt?.getTime() ||
			receipt.writerFenceReleasedAt?.getTime() !==
				job.writerFenceReleasedAt?.getTime() ||
			receipt.writerFenceEvidenceSha256 !==
				job.writerFenceEvidenceSha256 ||
			receipt.writerFenceReleaseEvidenceSha256 !==
				job.writerFenceReleaseEvidenceSha256
		) {
			return false;
		}
		const payload = this.receipts.canonicalize({
			receiptVersion: 5,
			jobId: receipt.jobId,
			permitId: receipt.permitId,
			permitRequestedById: receipt.permitRequestedById,
			permitApprovedById: receipt.permitApprovedById,
			permitCreatedAt: receipt.permitCreatedAt.toISOString(),
			permitApprovedAt: receipt.permitApprovedAt.toISOString(),
			permitExpiresAt: receipt.permitExpiresAt.toISOString(),
			permitConsumedAt: receipt.permitConsumedAt.toISOString(),
			target: receipt.target,
			terminalStatus: receipt.terminalStatus,
			phase: receipt.phase,
			sourceSha256: receipt.sourceSha256,
			sourceSize: receipt.sourceSize.toString(),
			sourceBackupJobId: receipt.sourceBackupJobId,
			backupProvenanceEnvelopeSha256:
				receipt.backupProvenanceEnvelopeSha256,
			backupProvenanceKeyId: receipt.backupProvenanceKeyId,
			safetyBackupSha256: receipt.safetyBackupSha256,
			expectedServicesSha: receipt.expectedServicesSha,
			migrationManifestSha: receipt.migrationManifestSha,
			writerFenceRoles: receipt.writerFenceRoles,
			writerFenceRequestedAt:
				receipt.writerFenceRequestedAt?.toISOString() ?? null,
			writerFenceAppliedAt:
				receipt.writerFenceAppliedAt?.toISOString() ?? null,
			writerFenceReleasedAt:
				receipt.writerFenceReleasedAt?.toISOString() ?? null,
			writerFenceEvidenceSha256: receipt.writerFenceEvidenceSha256,
			writerFenceReleaseEvidenceSha256:
				receipt.writerFenceReleaseEvidenceSha256,
			releaseAuthorizationPayloadSha256:
				receipt.releaseAuthorizationPayloadSha256,
			resultSha256: receipt.resultSha256,
			errorSha256: receipt.errorSha256,
			completedAt: receipt.completedAt.toISOString()
		});
		this.receipts.assertSignature({
			payload,
			payloadSha256: receipt.payloadSha256,
			signatureHmacSha256: receipt.signatureHmacSha256,
			signatureKeyId: receipt.signatureKeyId
		});
		return true;
	}

	async fail(
		lease: DatabaseRestoreLease,
		error: unknown,
		compensationEvidence: DatabaseRestoreWriterFenceEvidence | null = null
	): Promise<DatabaseRestoreJobStatus | null> {
		const status = this.requiresRecovery(lease.phase)
			? DatabaseRestoreJobStatus.RECOVERY_REQUIRED
			: DatabaseRestoreJobStatus.FAILED;
		const lastError = this.safeError(error);
		const physicalFenceUnconfirmed = lastError.includes(
			DATABASE_RESTORE_PHYSICAL_FENCE_UNCONFIRMED
		);
		const finishedAt = new Date();
		const result = await this.prisma.$transaction(async transaction => {
			const failed = await transaction.databaseRestoreJob.updateMany({
				where: {
					id: lease.event.jobId,
					target: lease.event.target,
					eventId: lease.event.eventId,
					status: DatabaseRestoreJobStatus.PROCESSING,
					phase: lease.phase,
					leaseToken: lease.leaseToken,
					leaseExpiresAt: { gt: new Date() }
				},
				data: {
					status,
					...(compensationEvidence
						? {
								phase: DatabaseRestoreJobPhase.FENCED,
								writerFenceRoles: compensationEvidence.roles,
								writerFenceAppliedAt: compensationEvidence.verifiedAt,
								writerFenceEvidenceSha256:
									compensationEvidence.evidenceSha256,
								writerFenceReleasedAt: null,
								writerFenceReleaseEvidenceSha256: null
							}
						: {}),
					lastError,
					finishedAt,
					leaseOwner: null,
					leaseToken: null,
					leaseExpiresAt: null
				}
			});
			if (failed.count !== 1) return null;
			const released =
				await transaction.databaseRestoreExecutionLease.updateMany({
					where: {
						id: 'singleton',
						operationType: DatabaseRestoreExecutionOperationType.RESTORE,
						operationId: lease.event.jobId,
						leaseToken: lease.leaseToken
					},
					data: {
						operationType: null,
						operationId: null,
						leaseOwner: null,
						leaseToken: null,
						leaseExpiresAt: null
					}
				});
			if (released.count !== 1) {
				throw new Error(
					'Database restore execution lease could not be released'
				);
			}
			await this.alerts.recordInTransaction(
				transaction,
				this.failureAlert(
					lease.event.jobId,
					lease.event.target,
					physicalFenceUnconfirmed
						? 'Физическое состояние writer fence не подтверждено; целевая база должна оставаться недоступной до ручной проверки'
						: status === DatabaseRestoreJobStatus.RECOVERY_REQUIRED
							? 'DEV database restore требует ручного восстановления из safety backup'
							: 'DEV database restore завершился до изменения целевой базы',
					{
						lastError,
						writerFenceStatus: physicalFenceUnconfirmed
							? 'UNCONFIRMED'
							: status === DatabaseRestoreJobStatus.RECOVERY_REQUIRED
								? 'FENCED'
								: 'NOT_APPLIED'
					}
				)
			);
			await this.createTerminalReceiptInTransaction(
				transaction,
				lease.event.jobId
			);
			return status;
		});
		if (result && compensationEvidence) {
			lease.phase = DatabaseRestoreJobPhase.FENCED;
		}
		return result;
	}

	async failQueuedWithoutSource(
		event: DatabaseRestoreEventIdentity,
		error: unknown
	): Promise<boolean> {
		const failedAt = new Date();
		const lastError = this.safeError(error);
		return this.prisma.$transaction(async transaction => {
			const failed = await transaction.databaseRestoreJob.updateMany({
				where: {
					id: event.jobId,
					target: event.target,
					eventId: event.eventId,
					sourceBackupJobId: event.sourceBackupJobId,
					backupProvenanceEnvelopeSha256:
						event.backupProvenanceEnvelopeSha256,
					backupProvenanceKeyId: event.backupProvenanceKeyId,
					expectedServicesSha: event.expectedServicesSha,
					migrationManifestSha: event.migrationManifestSha,
					status: DatabaseRestoreJobStatus.QUEUED
				},
				data: {
					status: DatabaseRestoreJobStatus.FAILED,
					phase: DatabaseRestoreJobPhase.PREPARING,
					attempts: { increment: 1 },
					lastError,
					startedAt: failedAt,
					finishedAt: failedAt
				}
			});
			if (failed.count !== 1) return false;
			await this.alerts.recordInTransaction(
				transaction,
				this.failureAlert(
					event.jobId,
					event.target,
					'DEV database restore не запущен: не удалось подготовить путь к исходному dump'
				)
			);
			await this.createTerminalReceiptInTransaction(
				transaction,
				event.jobId
			);
			return true;
		});
	}

	async failQueuedPermanent(
		event: DatabaseRestoreEventIdentity,
		error: unknown
	): Promise<boolean> {
		const failedAt = new Date();
		const lastError = this.safeError(error);
		return this.prisma.$transaction(async transaction => {
			const failed = await transaction.databaseRestoreJob.updateMany({
				where: {
					id: event.jobId,
					target: event.target,
					eventId: event.eventId,
					sourceBackupJobId: event.sourceBackupJobId,
					backupProvenanceEnvelopeSha256:
						event.backupProvenanceEnvelopeSha256,
					backupProvenanceKeyId: event.backupProvenanceKeyId,
					expectedServicesSha: event.expectedServicesSha,
					migrationManifestSha: event.migrationManifestSha,
					status: DatabaseRestoreJobStatus.QUEUED
				},
				data: {
					status: DatabaseRestoreJobStatus.FAILED,
					phase: DatabaseRestoreJobPhase.PREPARING,
					attempts: { increment: 1 },
					lastError,
					startedAt: failedAt,
					finishedAt: failedAt
				}
			});
			if (failed.count !== 1) return false;
			await this.alerts.recordInTransaction(
				transaction,
				this.failureAlert(
					event.jobId,
					event.target,
					'DEV database restore отклонён: immutable revision или migration manifest больше не совпадает',
					{ lastError, writerFenceStatus: 'NOT_APPLIED' }
				)
			);
			await this.createTerminalReceiptInTransaction(
				transaction,
				event.jobId
			);
			return true;
		});
	}

	async observe(
		event: DatabaseRestoreEventIdentity
	): Promise<DatabaseRestoreObservation> {
		const job = await this.prisma.databaseRestoreJob.findUnique({
			where: { id: event.jobId },
			select: {
				id: true,
				target: true,
				eventId: true,
				sourceBackupJobId: true,
				backupProvenanceEnvelopeSha256: true,
				backupProvenanceKeyId: true,
				expectedServicesSha: true,
				migrationManifestSha: true,
				status: true,
				phase: true,
				leaseToken: true,
				leaseExpiresAt: true
			}
		});
		if (!job) return { state: 'missing' };
		if (
			job.target !== event.target ||
			job.eventId !== event.eventId ||
			job.sourceBackupJobId !== event.sourceBackupJobId ||
			job.backupProvenanceEnvelopeSha256 !==
				event.backupProvenanceEnvelopeSha256 ||
			job.backupProvenanceKeyId !== event.backupProvenanceKeyId ||
			job.expectedServicesSha !== event.expectedServicesSha ||
			job.migrationManifestSha !== event.migrationManifestSha
		) {
			return { state: 'mismatched' };
		}
		if (job.status === DatabaseRestoreJobStatus.QUEUED) {
			return { state: 'queued' };
		}
		if (job.status === DatabaseRestoreJobStatus.PROCESSING) {
			return { state: 'processing', job };
		}
		return { state: 'terminal', status: job.status };
	}

	async findFence(
		target: DatabaseRestoreTarget
	): Promise<ExpirableRestoreJob | null> {
		return this.prisma.databaseRestoreJob.findFirst({
			where: {
				OR: [
					{ status: DatabaseRestoreJobStatus.PROCESSING },
					{
						status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED,
						target,
						recoveryResolvedAt: null
					}
				]
			},
			orderBy: { updatedAt: 'asc' },
			select: {
				id: true,
				target: true,
				eventId: true,
				sourceBackupJobId: true,
				backupProvenanceEnvelopeSha256: true,
				backupProvenanceKeyId: true,
				expectedServicesSha: true,
				migrationManifestSha: true,
				status: true,
				phase: true,
				leaseToken: true,
				leaseExpiresAt: true
			}
		});
	}

	async findExpired(limit: number): Promise<ExpirableRestoreJob[]> {
		return this.prisma.databaseRestoreJob.findMany({
			where: {
				status: DatabaseRestoreJobStatus.PROCESSING,
				leaseExpiresAt: { lte: new Date() }
			},
			orderBy: { updatedAt: 'asc' },
			take: limit,
			select: {
				id: true,
				target: true,
				eventId: true,
				sourceBackupJobId: true,
				backupProvenanceEnvelopeSha256: true,
				backupProvenanceKeyId: true,
				expectedServicesSha: true,
				migrationManifestSha: true,
				status: true,
				phase: true,
				leaseToken: true,
				leaseExpiresAt: true
			}
		});
	}

	async reserveExpiredJob(
		job: ExpirableRestoreJob
	): Promise<ExpirableRestoreJob | null> {
		if (
			job.status !== DatabaseRestoreJobStatus.PROCESSING ||
			!job.leaseToken ||
			!job.leaseExpiresAt
		) {
			return null;
		}
		const previousLeaseToken = job.leaseToken;
		const leaseToken = randomUUID();
		const leaseExpiresAt = this.nextLeaseExpiry();
		return this.prisma.$transaction(async transaction => {
			const executionLease =
				await transaction.databaseRestoreExecutionLease.updateMany({
					where: {
						id: 'singleton',
						operationType: DatabaseRestoreExecutionOperationType.RESTORE,
						operationId: job.id,
						leaseToken: previousLeaseToken,
						leaseExpiresAt: { lte: new Date() }
					},
					data: {
						leaseOwner: this.instanceId,
						leaseToken,
						leaseExpiresAt
					}
				});
			if (executionLease.count !== 1) return null;
			const reserved = await transaction.databaseRestoreJob.updateMany({
				where: {
					id: job.id,
					status: DatabaseRestoreJobStatus.PROCESSING,
					phase: job.phase,
					leaseToken: previousLeaseToken,
					leaseExpiresAt: { lte: new Date() }
				},
				data: {
					leaseOwner: this.instanceId,
					leaseToken,
					leaseExpiresAt
				}
			});
			if (reserved.count !== 1) {
				throw new Error(
					'Database restore expired lease reservation diverged'
				);
			}
			return { ...job, leaseToken, leaseExpiresAt };
		});
	}

	async recoverReservedExpiredJob(
		job: ExpirableRestoreJob,
		compensationEvidence: DatabaseRestoreWriterFenceEvidence | null = null
	): Promise<RecoveredDatabaseRestoreJob | null> {
		if (
			job.status !== DatabaseRestoreJobStatus.PROCESSING ||
			!job.leaseToken ||
			!job.leaseExpiresAt
		) {
			return null;
		}
		const status = this.requiresRecovery(job.phase)
			? DatabaseRestoreJobStatus.RECOVERY_REQUIRED
			: DatabaseRestoreJobStatus.FAILED;
		const lastError =
			status === DatabaseRestoreJobStatus.RECOVERY_REQUIRED
				? 'Restore worker lease expired after target mutation; manual recovery from safety backup is required'
				: 'Restore worker lease expired before target mutation';
		const finishedAt = new Date();
		return this.prisma.$transaction(async transaction => {
			const changed = await transaction.databaseRestoreJob.updateMany({
				where: {
					id: job.id,
					status: DatabaseRestoreJobStatus.PROCESSING,
					phase: job.phase,
					leaseOwner: this.instanceId,
					leaseToken: job.leaseToken,
					leaseExpiresAt: { gt: new Date() }
				},
				data: {
					status,
					...(compensationEvidence
						? {
								phase: DatabaseRestoreJobPhase.FENCED,
								writerFenceRoles: compensationEvidence.roles,
								writerFenceAppliedAt: compensationEvidence.verifiedAt,
								writerFenceEvidenceSha256:
									compensationEvidence.evidenceSha256,
								writerFenceReleasedAt: null,
								writerFenceReleaseEvidenceSha256: null
							}
						: {}),
					lastError,
					finishedAt,
					leaseOwner: null,
					leaseToken: null,
					leaseExpiresAt: null
				}
			});
			if (changed.count !== 1) return null;
			const released =
				await transaction.databaseRestoreExecutionLease.updateMany({
					where: {
						id: 'singleton',
						operationType: DatabaseRestoreExecutionOperationType.RESTORE,
						operationId: job.id,
						leaseOwner: this.instanceId,
						leaseToken: job.leaseToken,
						leaseExpiresAt: { gt: new Date() }
					},
					data: {
						operationType: null,
						operationId: null,
						leaseOwner: null,
						leaseToken: null,
						leaseExpiresAt: null
					}
				});
			if (released.count !== 1) {
				throw new Error(
					'Database restore expired execution lease could not be released'
				);
			}
			await this.alerts.recordInTransaction(
				transaction,
				this.failureAlert(
					job.id,
					job.target,
					status === DatabaseRestoreJobStatus.RECOVERY_REQUIRED
						? 'Истёк lease после начала изменения базы; требуется ручное восстановление из safety backup'
						: 'Истёк lease до начала изменения базы; задание завершено безопасной ошибкой'
				)
			);
			await this.createTerminalReceiptInTransaction(transaction, job.id);
			return {
				id: job.id,
				target: job.target,
				status,
				phase: compensationEvidence
					? DatabaseRestoreJobPhase.FENCED
					: job.phase
			};
		});
	}

	async createTerminalReceiptInTransaction(
		transaction: Prisma.TransactionClient,
		jobId: string
	): Promise<void> {
		const existing =
			await transaction.databaseRestoreTerminalReceipt.findUnique({
				where: { jobId },
				select: { id: true }
			});
		if (existing) return;
		const job = await transaction.databaseRestoreJob.findUniqueOrThrow({
			where: { id: jobId },
			include: { permit: true }
		});
		const releaseAuthorization =
			job.status === DatabaseRestoreJobStatus.SUCCEEDED
				? await transaction.databaseRestoreReleaseAuthorization.findFirst({
						where: {
							operationType: DatabaseRestoreExecutionOperationType.RESTORE,
							operationId: job.id
						}
					})
				: null;
		if (
			!this.isTerminal(job.status) ||
			!job.finishedAt ||
			!job.expectedServicesSha ||
			!job.migrationManifestSha ||
			!job.sourceBackupJobId ||
			!job.backupProvenanceEnvelopeSha256 ||
			!job.backupProvenanceKeyId ||
			job.permit.status !== DatabaseRestorePermitStatus.CONSUMED ||
			job.permit.id !== job.permitId ||
			job.permit.jobId !== job.id ||
			job.permit.requestedById !== job.requestedById ||
			!job.permit.approvedById ||
			!job.permit.approvedAt ||
			!job.permit.consumedAt ||
			(job.status === DatabaseRestoreJobStatus.SUCCEEDED &&
				!releaseAuthorization)
		) {
			throw new Error(
				'Database restore terminal receipt requires a complete terminal job'
			);
		}
		const resultSha256 =
			job.result === null
				? null
				: this.receipts.sha256(this.receipts.canonicalize(job.result));
		const errorSha256 = job.lastError
			? this.receipts.sha256(job.lastError)
			: null;
		const payload = this.receipts.canonicalize({
			receiptVersion: 5,
			jobId: job.id,
			permitId: job.permit.id,
			permitRequestedById: job.permit.requestedById,
			permitApprovedById: job.permit.approvedById,
			permitCreatedAt: job.permit.createdAt.toISOString(),
			permitApprovedAt: job.permit.approvedAt.toISOString(),
			permitExpiresAt: job.permit.expiresAt.toISOString(),
			permitConsumedAt: job.permit.consumedAt.toISOString(),
			target: job.target,
			terminalStatus: job.status,
			phase: job.phase,
			sourceSha256: job.sourceSha256,
			sourceSize: job.sourceSize.toString(),
			sourceBackupJobId: job.sourceBackupJobId,
			backupProvenanceEnvelopeSha256: job.backupProvenanceEnvelopeSha256,
			backupProvenanceKeyId: job.backupProvenanceKeyId,
			safetyBackupSha256: job.safetyBackupSha256,
			expectedServicesSha: job.expectedServicesSha,
			migrationManifestSha: job.migrationManifestSha,
			writerFenceRoles: job.writerFenceRoles ?? null,
			writerFenceRequestedAt:
				job.writerFenceRequestedAt?.toISOString() ?? null,
			writerFenceAppliedAt:
				job.writerFenceAppliedAt?.toISOString() ?? null,
			writerFenceReleasedAt:
				job.writerFenceReleasedAt?.toISOString() ?? null,
			writerFenceEvidenceSha256: job.writerFenceEvidenceSha256 ?? null,
			writerFenceReleaseEvidenceSha256:
				job.writerFenceReleaseEvidenceSha256 ?? null,
			releaseAuthorizationPayloadSha256:
				releaseAuthorization?.payloadSha256 ?? null,
			resultSha256,
			errorSha256,
			completedAt: job.finishedAt.toISOString()
		});
		const signature = this.receipts.sign(payload);
		const closed = await transaction.databaseRestorePermit.updateMany({
			where: {
				id: job.permitId,
				jobId: job.id,
				status: DatabaseRestorePermitStatus.CONSUMED,
				consumedAt: { not: null },
				closedAt: null
			},
			data: {
				status: DatabaseRestorePermitStatus.CLOSED,
				closedAt: job.finishedAt,
				closeReason: `TERMINAL_${job.status}`
			}
		});
		if (closed.count !== 1) {
			throw new Error(
				'Database restore permit could not be auto-closed atomically'
			);
		}
		await transaction.databaseRestoreTerminalReceipt.create({
			data: {
				id: randomUUID(),
				jobId: job.id,
				permitId: job.permit.id,
				permitRequestedById: job.permit.requestedById,
				permitApprovedById: job.permit.approvedById,
				permitCreatedAt: job.permit.createdAt,
				permitApprovedAt: job.permit.approvedAt,
				permitExpiresAt: job.permit.expiresAt,
				permitConsumedAt: job.permit.consumedAt,
				target: job.target,
				terminalStatus: job.status,
				phase: job.phase,
				sourceSha256: job.sourceSha256,
				sourceSize: job.sourceSize,
				sourceBackupJobId: job.sourceBackupJobId,
				backupProvenanceEnvelopeSha256: job.backupProvenanceEnvelopeSha256,
				backupProvenanceKeyId: job.backupProvenanceKeyId,
				safetyBackupSha256: job.safetyBackupSha256,
				expectedServicesSha: job.expectedServicesSha,
				migrationManifestSha: job.migrationManifestSha,
				resultSha256,
				errorSha256,
				writerFenceRoles:
					job.writerFenceRoles == null
						? Prisma.DbNull
						: (job.writerFenceRoles as Prisma.InputJsonValue),
				writerFenceRequestedAt: job.writerFenceRequestedAt,
				writerFenceAppliedAt: job.writerFenceAppliedAt,
				writerFenceReleasedAt: job.writerFenceReleasedAt,
				writerFenceEvidenceSha256: job.writerFenceEvidenceSha256,
				writerFenceReleaseEvidenceSha256:
					job.writerFenceReleaseEvidenceSha256,
				releaseAuthorizationPayloadSha256:
					releaseAuthorization?.payloadSha256 ?? null,
				payloadSha256: signature.payloadSha256,
				signatureHmacSha256: signature.signatureHmacSha256,
				signatureKeyId: signature.signatureKeyId,
				completedAt: job.finishedAt
			}
		});
	}

	private isTerminal(status: DatabaseRestoreJobStatus): boolean {
		switch (status) {
			case DatabaseRestoreJobStatus.SUCCEEDED:
			case DatabaseRestoreJobStatus.FAILED:
			case DatabaseRestoreJobStatus.RECOVERY_REQUIRED:
			case DatabaseRestoreJobStatus.CANCELLED:
				return true;
			default:
				return false;
		}
	}

	private checkpointPhase(
		checkpoint: DatabaseRestoreCheckpoint
	): DatabaseRestoreJobPhase {
		switch (checkpoint.phase) {
			case 'FENCING':
				return DatabaseRestoreJobPhase.FENCING;
			case 'FENCED':
				return DatabaseRestoreJobPhase.FENCED;
			case 'SAFETY_READY':
				return DatabaseRestoreJobPhase.SAFETY_READY;
			case 'MUTATING':
				return DatabaseRestoreJobPhase.MUTATING;
			case 'VERIFIED':
				return DatabaseRestoreJobPhase.VERIFIED;
			case 'UNFENCING':
				return DatabaseRestoreJobPhase.UNFENCING;
			case 'UNFENCED':
				return DatabaseRestoreJobPhase.UNFENCED;
		}
	}

	private expectedCheckpointPhase(
		phase: DatabaseRestoreJobPhase
	): DatabaseRestoreJobPhase {
		switch (phase) {
			case DatabaseRestoreJobPhase.FENCING:
				return DatabaseRestoreJobPhase.PREPARING;
			case DatabaseRestoreJobPhase.FENCED:
				return DatabaseRestoreJobPhase.FENCING;
			case DatabaseRestoreJobPhase.SAFETY_READY:
				return DatabaseRestoreJobPhase.FENCED;
			case DatabaseRestoreJobPhase.MUTATING:
				return DatabaseRestoreJobPhase.SAFETY_READY;
			case DatabaseRestoreJobPhase.VERIFIED:
				return DatabaseRestoreJobPhase.MUTATING;
			case DatabaseRestoreJobPhase.UNFENCING:
				return DatabaseRestoreJobPhase.VERIFIED;
			case DatabaseRestoreJobPhase.UNFENCED:
				return DatabaseRestoreJobPhase.UNFENCING;
			default:
				throw new Error('Database restore checkpoint phase is invalid');
		}
	}

	private requiresRecovery(
		phase: DatabaseRestoreJobPhase | null
	): boolean {
		return (
			phase === null ||
			phase === DatabaseRestoreJobPhase.FENCING ||
			phase === DatabaseRestoreJobPhase.FENCED ||
			phase === DatabaseRestoreJobPhase.SAFETY_READY ||
			phase === DatabaseRestoreJobPhase.MUTATING ||
			phase === DatabaseRestoreJobPhase.VERIFIED ||
			phase === DatabaseRestoreJobPhase.UNFENCING ||
			phase === DatabaseRestoreJobPhase.UNFENCED
		);
	}

	private failureAlert(
		jobId: string,
		target: string,
		message: string,
		metadata?: Record<string, string>
	): RecordOperationalAlertInput {
		return {
			deduplicationKey: `database-restore:${target}`,
			type: 'INTEGRATION_PROBLEM',
			severity: OperationalAlertSeverity.HIGH,
			source: 'operations',
			referenceId: jobId,
			title: `Не восстановлена база ${target}`,
			message,
			...(metadata ? { metadata } : {})
		};
	}

	private nextLeaseExpiry(): Date {
		return new Date(Date.now() + RESTORE_LEASE_MS);
	}

	private retentionHours(): number {
		const raw =
			process.env.DATABASE_RESTORE_ARTIFACT_RETENTION_HOURS?.trim();
		const value = raw ? Number(raw) : 7 * 24;
		if (!Number.isSafeInteger(value) || value < 24 || value > 30 * 24) {
			throw new Error(
				'DATABASE_RESTORE_ARTIFACT_RETENTION_HOURS must be between 24 and 720'
			);
		}
		return value;
	}

	private isUniqueConflict(error: unknown): boolean {
		return (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			(error as { code?: unknown }).code === 'P2002'
		);
	}

	private safeError(error: unknown): string {
		return (error instanceof Error ? error.message : String(error))
			.replace(/[\r\n]+/g, ' ')
			.slice(0, 2_000);
	}
}
