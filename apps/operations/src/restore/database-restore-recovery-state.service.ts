import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	DatabaseRestoreExecutionOperationType,
	DatabaseRestoreJobStatus,
	DatabaseRestoreRecoveryActionPhase,
	DatabaseRestoreRecoveryActionStatus,
	DatabaseRestoreRecoveryActionType,
	OperationalAlertSeverity,
	Prisma
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { AdminEventLogService } from '../admin-event-log/admin-event-log.service';
import { OperationalAlertService } from '../monitoring/operational-alert.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import {
	DATABASE_RESTORE_PHYSICAL_FENCE_UNCONFIRMED,
	DatabaseRestoreTarget
} from './database-restore.contract';
import { DatabaseRestoreReceiptService } from './database-restore-receipt.service';
import {
	DATABASE_RESTORE_RELEASE_AUTHORIZATION_COMMIT_UNKNOWN,
	DatabaseRestoreReleaseAuthorizationService
} from './database-restore-release-authorization.service';
import { DatabaseRestoreTargetRegistryService } from './database-restore-target-registry.service';
import { DatabaseRestoreRecoveryExecutorService } from './database-restore-recovery-executor.service';
import {
	DatabaseRestoreWriterFenceService,
	type DatabaseRestoreWriterFenceEvidence
} from './database-restore-writer-fence.service';

const RECOVERY_LEASE_MS = 60_000;
const DEFAULT_ARTIFACT_RETENTION_HOURS = 7 * 24;

export interface DatabaseRestoreRecoveryEventIdentity {
	eventId: string;
	actionId: string;
	jobId: string;
	target: DatabaseRestoreTarget;
	action: DatabaseRestoreRecoveryActionType;
	receiptPayloadSha: string;
	expectedServicesSha: string;
	migrationManifestSha: string;
}

export interface DatabaseRestoreRecoveryLease {
	event: DatabaseRestoreRecoveryEventIdentity;
	leaseToken: string;
	leaseExpiresAt: Date;
	phase: DatabaseRestoreRecoveryActionPhase;
}

export type DatabaseRestoreRecoveryClaim =
	| { state: 'claimed'; lease: DatabaseRestoreRecoveryLease }
	| { state: 'busy' }
	| { state: 'unclaimed' };

export type DatabaseRestoreRecoveryCheckpoint =
	| {
			phase: 'FENCING';
			writerFenceRoles: [string, string, string];
	  }
	| {
			phase: 'FENCED';
			artifactSha256: string | null;
			writerFenceRoles: [string, string, string];
			writerFenceAppliedAt: Date;
			writerFenceEvidenceSha256: string;
	  }
	| { phase: 'MUTATING' | 'VERIFYING' | 'VERIFIED' }
	| {
			phase: 'UNFENCING';
			verifiedAt: Date;
			migrationLedgerSha256: string;
			aclEvidenceSha256: string;
			verifiedWriterFenceSha256: string;
	  };

type ExpirableRecoveryAction =
	Prisma.DatabaseRestoreRecoveryActionGetPayload<{
		include: { restoreJob: true };
	}>;

@Injectable()
export class DatabaseRestoreRecoveryStateService {
	private readonly instanceId = randomUUID();
	private readonly releaseAuthorizations: DatabaseRestoreReleaseAuthorizationService;

	constructor(
		private readonly config: ConfigService,
		private readonly prisma: OperationsPrismaService,
		private readonly alerts: OperationalAlertService,
		private readonly audit: AdminEventLogService,
		private readonly receipts: DatabaseRestoreReceiptService,
		private readonly targets: DatabaseRestoreTargetRegistryService,
		private readonly writerFence: DatabaseRestoreWriterFenceService,
		private readonly recoveryExecutor?: DatabaseRestoreRecoveryExecutorService,
		releaseAuthorizations?: DatabaseRestoreReleaseAuthorizationService
	) {
		this.releaseAuthorizations =
			releaseAuthorizations ??
			new DatabaseRestoreReleaseAuthorizationService(prisma, receipts);
	}

	async claim(
		event: DatabaseRestoreRecoveryEventIdentity
	): Promise<DatabaseRestoreRecoveryClaim> {
		const candidate =
			await this.prisma.databaseRestoreRecoveryAction.findUnique({
				where: { id: event.actionId },
				include: {
					restoreJob: {
						include: {
							terminalReceipt: true,
							recoveryResolutionReceipt: true
						}
					}
				}
			});
		const now = new Date();
		if (
			candidate?.status === DatabaseRestoreRecoveryActionStatus.APPROVED &&
			candidate.expiresAt <= now
		) {
			await this.prisma.databaseRestoreRecoveryAction.updateMany({
				where: {
					id: event.actionId,
					status: DatabaseRestoreRecoveryActionStatus.APPROVED,
					expiresAt: { lte: now },
					phase: null,
					leaseToken: null
				},
				data: { status: DatabaseRestoreRecoveryActionStatus.EXPIRED }
			});
			return { state: 'unclaimed' };
		}
		if (
			!candidate ||
			!this.matches(candidate, event) ||
			candidate.status !== DatabaseRestoreRecoveryActionStatus.APPROVED ||
			candidate.restoreJob.status !==
				DatabaseRestoreJobStatus.RECOVERY_REQUIRED ||
			candidate.restoreJob.recoveryResolvedAt ||
			candidate.restoreJob.recoveryResolutionReceipt
		) {
			return { state: 'unclaimed' };
		}
		this.assertInitialReceipt(
			candidate.restoreJob,
			candidate.restoreJob.terminalReceipt
		);
		if (
			candidate.receiptPayloadSha !==
			candidate.restoreJob.terminalReceipt?.payloadSha256
		) {
			throw new Error(
				'Database restore recovery action is not bound to the signed receipt'
			);
		}
		const leaseToken = randomUUID();
		const leaseExpiresAt = this.nextLeaseExpiry();
		return this.prisma.$transaction(async transaction => {
			const executionLease =
				await transaction.databaseRestoreExecutionLease.updateMany({
					where: {
						id: 'singleton',
						leaseExpiresAt: null
					},
					data: {
						operationType: DatabaseRestoreExecutionOperationType.RECOVERY,
						operationId: event.actionId,
						leaseOwner: this.instanceId,
						leaseToken,
						leaseExpiresAt
					}
				});
			if (executionLease.count !== 1) return { state: 'busy' } as const;
			const action =
				await transaction.databaseRestoreRecoveryAction.updateMany({
					where: {
						id: event.actionId,
						jobId: event.jobId,
						eventId: event.eventId,
						action: event.action,
						receiptPayloadSha: event.receiptPayloadSha,
						status: DatabaseRestoreRecoveryActionStatus.APPROVED,
						expiresAt: { gt: new Date() }
					},
					data: {
						status: DatabaseRestoreRecoveryActionStatus.PROCESSING,
						phase: DatabaseRestoreRecoveryActionPhase.PREPARING,
						leaseOwner: this.instanceId,
						leaseToken,
						leaseExpiresAt,
						attempts: { increment: 1 },
						startedAt: new Date(),
						finishedAt: null,
						lastError: null
					}
				});
			if (action.count !== 1) {
				await this.releaseExecutionLease(
					transaction,
					event.actionId,
					leaseToken
				);
				return { state: 'unclaimed' } as const;
			}
			return {
				state: 'claimed',
				lease: {
					event,
					leaseToken,
					leaseExpiresAt,
					phase: DatabaseRestoreRecoveryActionPhase.PREPARING
				}
			} as const;
		});
	}

	async loadClaimedAction(lease: DatabaseRestoreRecoveryLease) {
		return this.prisma.databaseRestoreRecoveryAction.findFirstOrThrow({
			where: {
				id: lease.event.actionId,
				jobId: lease.event.jobId,
				eventId: lease.event.eventId,
				status: DatabaseRestoreRecoveryActionStatus.PROCESSING,
				leaseToken: lease.leaseToken
			},
			include: {
				restoreJob: { include: { terminalReceipt: true } }
			}
		});
	}

	async renew(lease: DatabaseRestoreRecoveryLease): Promise<boolean> {
		const requestedLeaseExpiresAt = this.nextLeaseExpiry();
		const leaseExpiresAt = await this.prisma.$transaction(
			async transaction => {
				await transaction.databaseRestoreExecutionLease.updateMany({
					where: {
						id: 'singleton',
						operationType: DatabaseRestoreExecutionOperationType.RECOVERY,
						operationId: lease.event.actionId,
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
							operationType:
								DatabaseRestoreExecutionOperationType.RECOVERY,
							operationId: lease.event.actionId,
							leaseToken: lease.leaseToken,
							leaseExpiresAt: { gt: new Date() }
						},
						select: { leaseExpiresAt: true }
					});
				if (!executionLease?.leaseExpiresAt) return null;
				await transaction.databaseRestoreRecoveryAction.updateMany({
					where: {
						id: lease.event.actionId,
						status: DatabaseRestoreRecoveryActionStatus.PROCESSING,
						leaseToken: lease.leaseToken,
						leaseExpiresAt: {
							gt: new Date(),
							lt: requestedLeaseExpiresAt
						}
					},
					data: { leaseExpiresAt: requestedLeaseExpiresAt }
				});
				const action =
					await transaction.databaseRestoreRecoveryAction.findFirst({
						where: {
							id: lease.event.actionId,
							status: DatabaseRestoreRecoveryActionStatus.PROCESSING,
							leaseToken: lease.leaseToken,
							leaseExpiresAt: { gt: new Date() }
						},
						select: { leaseExpiresAt: true }
					});
				if (!action?.leaseExpiresAt) {
					throw new Error(
						'Database restore recovery lease state diverged'
					);
				}
				return new Date(
					Math.min(
						executionLease.leaseExpiresAt.getTime(),
						action.leaseExpiresAt.getTime()
					)
				);
			}
		);
		if (!leaseExpiresAt) return false;
		lease.leaseExpiresAt = leaseExpiresAt;
		return true;
	}

	async checkpoint(
		lease: DatabaseRestoreRecoveryLease,
		checkpoint: DatabaseRestoreRecoveryCheckpoint
	): Promise<void> {
		const nextPhase = this.checkpointPhase(checkpoint.phase);
		const allowedPrevious = this.allowedPreviousPhases(nextPhase);
		if (!allowedPrevious.includes(lease.phase)) {
			throw new Error(
				'Database restore recovery checkpoint order is invalid'
			);
		}
		const leaseExpiresAt = this.nextLeaseExpiry();
		try {
			await this.prisma.$transaction(async transaction => {
				const executionLease =
					await transaction.databaseRestoreExecutionLease.updateMany({
						where: {
							id: 'singleton',
							operationType:
								DatabaseRestoreExecutionOperationType.RECOVERY,
							operationId: lease.event.actionId,
							leaseToken: lease.leaseToken,
							leaseExpiresAt: { gt: new Date() }
						},
						data: { leaseExpiresAt }
					});
				if (executionLease.count !== 1) {
					throw new Error(
						'Database restore recovery execution lease was lost'
					);
				}
				const changed =
					await transaction.databaseRestoreRecoveryAction.updateMany({
						where: {
							id: lease.event.actionId,
							status: DatabaseRestoreRecoveryActionStatus.PROCESSING,
							phase: { in: allowedPrevious },
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
										artifactSha256: checkpoint.artifactSha256,
										writerFenceRoles: checkpoint.writerFenceRoles,
										writerFenceAppliedAt: checkpoint.writerFenceAppliedAt,
										writerFenceEvidenceSha256:
											checkpoint.writerFenceEvidenceSha256
									}
								: {})
						}
					});
				if (changed.count !== 1) {
					throw new Error(
						`Database restore recovery ${checkpoint.phase} checkpoint could not be persisted`
					);
				}
				if (checkpoint.phase === 'UNFENCING') {
					await this.releaseAuthorizations.createRecovery(
						transaction,
						lease.event.actionId,
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

	async resolve(
		lease: DatabaseRestoreRecoveryLease,
		input: {
			result: Prisma.InputJsonValue;
			writerFenceReleasedAt: Date;
			writerFenceReleaseEvidenceSha256: string;
		}
	): Promise<boolean> {
		const releaseAuthorization = await this.confirmReleaseAuthorized(
			lease.event
		);
		if (!releaseAuthorization) {
			throw new Error(
				'Database restore recovery resolution has no signed release authorization'
			);
		}
		const resolvedAt = new Date();
		return this.prisma.$transaction(async transaction => {
			const current =
				await transaction.databaseRestoreRecoveryAction.findFirst({
					where: {
						id: lease.event.actionId,
						status: DatabaseRestoreRecoveryActionStatus.PROCESSING,
						phase: DatabaseRestoreRecoveryActionPhase.UNFENCING,
						leaseToken: lease.leaseToken,
						leaseExpiresAt: { gt: new Date() }
					},
					include: {
						restoreJob: { include: { terminalReceipt: true } }
					}
				});
			if (!current) return false;
			this.assertInitialReceipt(
				current.restoreJob,
				current.restoreJob.terminalReceipt
			);
			if (
				current.receiptPayloadSha !==
				current.restoreJob.terminalReceipt?.payloadSha256
			) {
				throw new Error(
					'Database restore recovery action is not bound to the signed receipt'
				);
			}
			if (
				!current.writerFenceRoles ||
				!current.writerFenceAppliedAt ||
				!current.writerFenceEvidenceSha256
			) {
				throw new Error(
					'Database restore recovery fence evidence is incomplete'
				);
			}
			const resultSha256 = this.receipts.sha256(
				this.receipts.canonicalize(input.result)
			);
			const payload = this.receipts.canonicalize({
				receiptVersion: 2,
				jobId: current.jobId,
				actionId: current.id,
				target: current.restoreJob.target,
				action: current.action,
				initialReceiptPayloadSha: current.receiptPayloadSha,
				artifactSha256: current.artifactSha256,
				expectedServicesSha: current.restoreJob.expectedServicesSha,
				migrationManifestSha: current.restoreJob.migrationManifestSha,
				writerFenceRoles: current.writerFenceRoles,
				writerFenceAppliedAt: current.writerFenceAppliedAt.toISOString(),
				writerFenceReleasedAt: input.writerFenceReleasedAt.toISOString(),
				writerFenceEvidenceSha256: current.writerFenceEvidenceSha256,
				writerFenceReleaseEvidenceSha256:
					input.writerFenceReleaseEvidenceSha256,
				releaseAuthorizationPayloadSha256:
					releaseAuthorization.payloadSha256,
				resultSha256,
				resolvedAt: resolvedAt.toISOString()
			});
			const signature = this.receipts.sign(payload);
			const changed =
				await transaction.databaseRestoreRecoveryAction.updateMany({
					where: {
						id: current.id,
						status: DatabaseRestoreRecoveryActionStatus.PROCESSING,
						phase: DatabaseRestoreRecoveryActionPhase.UNFENCING,
						leaseToken: lease.leaseToken,
						leaseExpiresAt: { gt: new Date() }
					},
					data: {
						status: DatabaseRestoreRecoveryActionStatus.RESOLVED,
						phase: DatabaseRestoreRecoveryActionPhase.RESOLVED,
						result: input.result,
						lastError: null,
						finishedAt: resolvedAt,
						writerFenceReleasedAt: input.writerFenceReleasedAt,
						writerFenceReleaseEvidenceSha256:
							input.writerFenceReleaseEvidenceSha256,
						leaseOwner: null,
						leaseToken: null,
						leaseExpiresAt: null
					}
				});
			if (changed.count !== 1) return false;
			const retainUntil = new Date(
				resolvedAt.getTime() + this.retentionHours() * 60 * 60_000
			);
			const resolvedJob = await transaction.databaseRestoreJob.updateMany({
				where: {
					id: current.jobId,
					status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED,
					recoveryResolvedAt: null
				},
				data: {
					recoveryResolvedAt: resolvedAt,
					artifactRetainUntil: retainUntil
				}
			});
			if (resolvedJob.count !== 1) {
				throw new Error(
					'Database restore recovery target fence was not released'
				);
			}
			await transaction.databaseRestoreRecoveryReceipt.create({
				data: {
					id: randomUUID(),
					jobId: current.jobId,
					actionId: current.id,
					target: current.restoreJob.target,
					action: current.action,
					initialReceiptPayloadSha: current.receiptPayloadSha,
					artifactSha256: current.artifactSha256,
					expectedServicesSha: current.restoreJob.expectedServicesSha,
					migrationManifestSha: current.restoreJob.migrationManifestSha,
					writerFenceRoles: current.writerFenceRoles,
					writerFenceAppliedAt: current.writerFenceAppliedAt,
					writerFenceReleasedAt: input.writerFenceReleasedAt,
					writerFenceEvidenceSha256: current.writerFenceEvidenceSha256,
					writerFenceReleaseEvidenceSha256:
						input.writerFenceReleaseEvidenceSha256,
					releaseAuthorizationPayloadSha256:
						releaseAuthorization.payloadSha256,
					resultSha256,
					payloadSha256: signature.payloadSha256,
					signatureHmacSha256: signature.signatureHmacSha256,
					signatureKeyId: signature.signatureKeyId,
					resolvedAt
				}
			});
			const released = await this.releaseExecutionLease(
				transaction,
				current.id,
				lease.leaseToken
			);
			if (released !== 1) {
				throw new Error(
					'Database restore recovery execution lease was lost'
				);
			}
			await this.alerts.resolveInTransaction(
				transaction,
				`database-restore:${current.restoreJob.target}`
			);
			await this.audit.recordInTransaction(transaction, {
				adminId: current.approvedById,
				section: 'DEV_TOOLS',
				action: 'DEV_DATABASE_RESTORE_RECOVERY_RESOLVED',
				description: `Recovery action ${current.action} завершён для базы ${current.restoreJob.target}`,
				entityType: 'database_restore_recovery_action',
				entityId: current.id,
				metadata: {
					jobId: current.jobId,
					action: current.action,
					retainedUntil: retainUntil.toISOString()
				}
			});
			return true;
		});
	}

	async confirmResolved(
		event: DatabaseRestoreRecoveryEventIdentity
	): Promise<boolean> {
		const releaseAuthorization =
			await this.confirmReleaseAuthorized(event);
		if (!releaseAuthorization) return false;
		const action =
			await this.prisma.databaseRestoreRecoveryAction.findUnique({
				where: { id: event.actionId },
				include: {
					restoreJob: { include: { terminalReceipt: true } },
					resolutionReceipt: true
				}
			});
		const receipt = action?.resolutionReceipt;
		if (
			!action ||
			!receipt ||
			!this.matches(action, event) ||
			action.status !== DatabaseRestoreRecoveryActionStatus.RESOLVED ||
			action.phase !== DatabaseRestoreRecoveryActionPhase.RESOLVED ||
			!action.finishedAt ||
			!action.restoreJob.recoveryResolvedAt ||
			receipt.actionId !== action.id ||
			receipt.jobId !== action.jobId ||
			receipt.target !== action.restoreJob.target ||
			receipt.action !== action.action ||
			receipt.initialReceiptPayloadSha !== action.receiptPayloadSha ||
			receipt.artifactSha256 !== action.artifactSha256 ||
			receipt.expectedServicesSha !==
				action.restoreJob.expectedServicesSha ||
			receipt.migrationManifestSha !==
				action.restoreJob.migrationManifestSha ||
			receipt.releaseAuthorizationPayloadSha256 !==
				releaseAuthorization.payloadSha256 ||
			receipt.resolvedAt.getTime() !== action.finishedAt.getTime() ||
			receipt.resolvedAt.getTime() !==
				action.restoreJob.recoveryResolvedAt.getTime()
		) {
			return false;
		}
		this.assertInitialReceipt(
			action.restoreJob,
			action.restoreJob.terminalReceipt,
			true
		);
		if (
			action.receiptPayloadSha !==
			action.restoreJob.terminalReceipt?.payloadSha256
		) {
			return false;
		}
		const resultSha256 = this.receipts.sha256(
			this.receipts.canonicalize(action.result)
		);
		if (
			receipt.resultSha256 !== resultSha256 ||
			this.receipts.canonicalize(receipt.writerFenceRoles) !==
				this.receipts.canonicalize(action.writerFenceRoles) ||
			receipt.writerFenceAppliedAt.getTime() !==
				action.writerFenceAppliedAt?.getTime() ||
			receipt.writerFenceReleasedAt.getTime() !==
				action.writerFenceReleasedAt?.getTime() ||
			receipt.writerFenceEvidenceSha256 !==
				action.writerFenceEvidenceSha256 ||
			receipt.writerFenceReleaseEvidenceSha256 !==
				action.writerFenceReleaseEvidenceSha256
		) {
			return false;
		}
		const payload = this.receipts.canonicalize({
			receiptVersion: 2,
			jobId: receipt.jobId,
			actionId: receipt.actionId,
			target: receipt.target,
			action: receipt.action,
			initialReceiptPayloadSha: receipt.initialReceiptPayloadSha,
			artifactSha256: receipt.artifactSha256,
			expectedServicesSha: receipt.expectedServicesSha,
			migrationManifestSha: receipt.migrationManifestSha,
			writerFenceRoles: receipt.writerFenceRoles,
			writerFenceAppliedAt: receipt.writerFenceAppliedAt.toISOString(),
			writerFenceReleasedAt: receipt.writerFenceReleasedAt.toISOString(),
			writerFenceEvidenceSha256: receipt.writerFenceEvidenceSha256,
			writerFenceReleaseEvidenceSha256:
				receipt.writerFenceReleaseEvidenceSha256,
			releaseAuthorizationPayloadSha256:
				receipt.releaseAuthorizationPayloadSha256,
			resultSha256: receipt.resultSha256,
			resolvedAt: receipt.resolvedAt.toISOString()
		});
		this.receipts.assertSignature({
			payload,
			payloadSha256: receipt.payloadSha256,
			signatureHmacSha256: receipt.signatureHmacSha256,
			signatureKeyId: receipt.signatureKeyId
		});
		return true;
	}

	async confirmReleaseAuthorized(
		event: DatabaseRestoreRecoveryEventIdentity
	) {
		const authorization =
			await this.releaseAuthorizations.assertRecovery(event);
		if (!authorization) return null;
		const action =
			await this.prisma.databaseRestoreRecoveryAction.findUnique({
				where: { id: event.actionId },
				include: { restoreJob: { include: { terminalReceipt: true } } }
			});
		if (!action || !this.matches(action, event)) {
			throw new Error(
				'Database restore recovery release authorization event drifted'
			);
		}
		this.assertInitialReceipt(
			action.restoreJob,
			action.restoreJob.terminalReceipt,
			action.status === DatabaseRestoreRecoveryActionStatus.RESOLVED
		);
		return authorization;
	}

	async guardAuthorizedRelease(lease: DatabaseRestoreRecoveryLease) {
		const authorization = await this.confirmReleaseAuthorized(lease.event);
		if (!authorization) return null;
		const newerRecovery = await this.prisma.databaseRestoreJob.findFirst({
			where: {
				target: lease.event.target,
				id: { not: lease.event.jobId },
				status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED,
				recoveryResolvedAt: null
			},
			select: { id: true }
		});
		if (newerRecovery) {
			throw new Error(
				'Database restore recovery release is blocked by a newer unresolved generation'
			);
		}
		if (!(await this.renew(lease))) {
			throw new Error(
				'Database restore recovery signed release authorization lost its exact execution lease'
			);
		}
		return authorization;
	}

	async block(
		lease: DatabaseRestoreRecoveryLease,
		error: unknown,
		compensationEvidence: DatabaseRestoreWriterFenceEvidence | null = null
	): Promise<boolean> {
		const finishedAt = new Date();
		const lastError = this.safeError(error);
		const terminalPhase = compensationEvidence
			? DatabaseRestoreRecoveryActionPhase.FENCED
			: lease.phase;
		const result = await this.prisma.$transaction(async transaction => {
			const changed =
				await transaction.databaseRestoreRecoveryAction.updateMany({
					where: {
						id: lease.event.actionId,
						status: DatabaseRestoreRecoveryActionStatus.PROCESSING,
						phase: lease.phase,
						leaseToken: lease.leaseToken,
						leaseExpiresAt: { gt: new Date() }
					},
					data: {
						status: DatabaseRestoreRecoveryActionStatus.BLOCKED,
						...(compensationEvidence
							? {
									phase: DatabaseRestoreRecoveryActionPhase.FENCED,
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
			if (changed.count !== 1) return false;
			const released = await this.releaseExecutionLease(
				transaction,
				lease.event.actionId,
				lease.leaseToken
			);
			if (released !== 1) {
				throw new Error(
					'Database restore recovery execution lease could not be released'
				);
			}
			await this.recordBlockedInTransaction(
				transaction,
				lease.event,
				lastError,
				terminalPhase
			);
			return true;
		});
		if (result && compensationEvidence) {
			lease.phase = DatabaseRestoreRecoveryActionPhase.FENCED;
		}
		return result;
	}

	async recoverExpired(limit: number): Promise<number> {
		await this.prisma.databaseRestoreRecoveryAction.updateMany({
			where: {
				status: {
					in: [
						DatabaseRestoreRecoveryActionStatus.PENDING_APPROVAL,
						DatabaseRestoreRecoveryActionStatus.APPROVED
					]
				},
				expiresAt: { lte: new Date() },
				phase: null,
				leaseToken: null
			},
			data: { status: DatabaseRestoreRecoveryActionStatus.EXPIRED }
		});
		const expired =
			await this.prisma.databaseRestoreRecoveryAction.findMany({
				where: {
					status: DatabaseRestoreRecoveryActionStatus.PROCESSING,
					leaseExpiresAt: { lte: new Date() }
				},
				orderBy: { updatedAt: 'asc' },
				take: limit,
				include: { restoreJob: true }
			});
		let recovered = 0;
		for (const action of expired) {
			if (!action.eventId || !action.leaseToken) {
				throw new Error(
					'Database restore recovery processing evidence is incomplete'
				);
			}
			const reserved = await this.reserveExpired(action);
			if (!reserved) continue;
			const targetName = reserved.restoreJob
				.target as DatabaseRestoreTarget;
			const target = this.targets.get(targetName);
			const connection = await this.targets.connection(target);
			const event: DatabaseRestoreRecoveryEventIdentity = {
				eventId: reserved.eventId!,
				actionId: reserved.id,
				jobId: reserved.jobId,
				target: reserved.restoreJob.target as DatabaseRestoreTarget,
				action: reserved.action,
				receiptPayloadSha: reserved.receiptPayloadSha,
				expectedServicesSha: reserved.restoreJob.expectedServicesSha,
				migrationManifestSha: reserved.restoreJob.migrationManifestSha
			};
			const authorization = await this.confirmReleaseAuthorized(event);
			if (authorization) {
				const lease: DatabaseRestoreRecoveryLease = {
					event,
					leaseToken: reserved.leaseToken!,
					leaseExpiresAt: reserved.leaseExpiresAt!,
					phase: DatabaseRestoreRecoveryActionPhase.UNFENCING
				};
				if (!this.recoveryExecutor) {
					throw new Error(
						'Database restore recovery executor is unavailable for authorized restart reconciliation'
					);
				}
				const releaseEvidence =
					await this.recoveryExecutor.reconcileResolved(
						targetName,
						reserved.restoreJob.migrationManifestSha,
						authorization.writerFenceEvidenceSha256,
						async () => {
							if (!(await this.guardAuthorizedRelease(lease))) {
								throw new Error(
									'Database restore expired recovery release guard rejected LOGIN'
								);
							}
						}
					);
				const resolved = await this.resolve(lease, {
					result: {
						target: event.target,
						action: event.action,
						reconciledFromReleaseAuthorization: true,
						releaseAuthorizationPayloadSha256: authorization.payloadSha256,
						writerFenceReleasedAt: releaseEvidence.verifiedAt.toISOString()
					},
					writerFenceReleasedAt: releaseEvidence.verifiedAt,
					writerFenceReleaseEvidenceSha256: releaseEvidence.evidenceSha256
				});
				if (!resolved && !(await this.confirmResolved(event))) {
					throw new Error(
						'Database restore expired recovery release could not be terminalized'
					);
				}
				recovered += 1;
				continue;
			}
			const compensationEvidence = await this.writerFence.apply(
				connection,
				target,
				reserved.id
			);
			const changed = await this.prisma.$transaction(async transaction => {
				const blocked =
					await transaction.databaseRestoreRecoveryAction.updateMany({
						where: {
							id: reserved.id,
							status: DatabaseRestoreRecoveryActionStatus.PROCESSING,
							leaseOwner: this.instanceId,
							leaseToken: reserved.leaseToken,
							leaseExpiresAt: { gt: new Date() }
						},
						data: {
							status: DatabaseRestoreRecoveryActionStatus.BLOCKED,
							phase: DatabaseRestoreRecoveryActionPhase.FENCED,
							writerFenceRoles: compensationEvidence.roles,
							writerFenceAppliedAt: compensationEvidence.verifiedAt,
							writerFenceEvidenceSha256:
								compensationEvidence.evidenceSha256,
							writerFenceReleasedAt: null,
							writerFenceReleaseEvidenceSha256: null,
							lastError:
								'Recovery worker lease expired; writer fence remains closed pending a new dual-approved action',
							finishedAt: new Date(),
							leaseOwner: null,
							leaseToken: null,
							leaseExpiresAt: null
						}
					});
				if (blocked.count !== 1) return false;
				const released = await this.releaseExecutionLease(
					transaction,
					reserved.id,
					reserved.leaseToken!
				);
				if (released !== 1) {
					throw new Error(
						'Database restore expired recovery execution lease could not be released'
					);
				}
				await this.recordBlockedInTransaction(
					transaction,
					event,
					'Recovery worker lease expired; writer fence remains closed',
					DatabaseRestoreRecoveryActionPhase.FENCED
				);
				return true;
			});
			if (changed) recovered += 1;
		}
		return recovered;
	}

	private async reserveExpired(
		action: ExpirableRecoveryAction
	): Promise<ExpirableRecoveryAction | null> {
		if (!action.leaseToken || !action.leaseExpiresAt) return null;
		const previousLeaseToken = action.leaseToken;
		const leaseToken = randomUUID();
		const leaseExpiresAt = this.nextLeaseExpiry();
		return this.prisma.$transaction(async transaction => {
			const executionLease =
				await transaction.databaseRestoreExecutionLease.updateMany({
					where: {
						id: 'singleton',
						operationType: DatabaseRestoreExecutionOperationType.RECOVERY,
						operationId: action.id,
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
			const reserved =
				await transaction.databaseRestoreRecoveryAction.updateMany({
					where: {
						id: action.id,
						status: DatabaseRestoreRecoveryActionStatus.PROCESSING,
						phase: action.phase,
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
					'Database restore expired recovery lease reservation diverged'
				);
			}
			return {
				...action,
				leaseOwner: this.instanceId,
				leaseToken,
				leaseExpiresAt
			};
		});
	}

	async observe(event: DatabaseRestoreRecoveryEventIdentity) {
		const action =
			await this.prisma.databaseRestoreRecoveryAction.findUnique({
				where: { id: event.actionId },
				include: { restoreJob: true }
			});
		if (!action || !this.matches(action, event))
			return 'mismatched' as const;
		return action.status;
	}

	private assertInitialReceipt(
		job: any,
		receipt: any,
		allowResolved = false
	): void {
		if (
			job.status !== DatabaseRestoreJobStatus.RECOVERY_REQUIRED ||
			(!allowResolved && job.recoveryResolvedAt) ||
			!receipt ||
			receipt.terminalStatus !==
				DatabaseRestoreJobStatus.RECOVERY_REQUIRED ||
			receipt.jobId !== job.id ||
			receipt.permitId !== job.permitId ||
			receipt.permitRequestedById !== job.requestedById ||
			!receipt.permitApprovedById ||
			receipt.permitApprovedById === receipt.permitRequestedById ||
			receipt.target !== job.target ||
			receipt.sourceSha256 !== job.sourceSha256 ||
			receipt.safetyBackupSha256 !== job.safetyBackupSha256 ||
			receipt.expectedServicesSha !== job.expectedServicesSha ||
			receipt.migrationManifestSha !== job.migrationManifestSha
		) {
			throw new Error(
				'Database restore recovery initial evidence is invalid'
			);
		}
		const payload = this.receipts.canonicalize({
			receiptVersion: 4,
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
				receipt.releaseAuthorizationPayloadSha256 ?? null,
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
	}

	private matches(
		candidate: any,
		event: DatabaseRestoreRecoveryEventIdentity
	) {
		return (
			candidate.id === event.actionId &&
			candidate.jobId === event.jobId &&
			candidate.eventId === event.eventId &&
			candidate.action === event.action &&
			candidate.receiptPayloadSha === event.receiptPayloadSha &&
			candidate.restoreJob.target === event.target &&
			candidate.restoreJob.expectedServicesSha ===
				event.expectedServicesSha &&
			candidate.restoreJob.migrationManifestSha ===
				event.migrationManifestSha
		);
	}

	private async releaseExecutionLease(
		transaction: Prisma.TransactionClient,
		actionId: string,
		leaseToken: string
	): Promise<number> {
		const released =
			await transaction.databaseRestoreExecutionLease.updateMany({
				where: {
					id: 'singleton',
					operationType: DatabaseRestoreExecutionOperationType.RECOVERY,
					operationId: actionId,
					leaseToken
				},
				data: {
					operationType: null,
					operationId: null,
					leaseOwner: null,
					leaseToken: null,
					leaseExpiresAt: null
				}
			});
		return released.count;
	}

	private async recordBlockedInTransaction(
		transaction: Prisma.TransactionClient,
		event: DatabaseRestoreRecoveryEventIdentity,
		lastError: string,
		phase: DatabaseRestoreRecoveryActionPhase
	): Promise<void> {
		const physicalFenceUnconfirmed = lastError.includes(
			DATABASE_RESTORE_PHYSICAL_FENCE_UNCONFIRMED
		);
		const writerFenceStatus = physicalFenceUnconfirmed
			? 'UNCONFIRMED'
			: phase === DatabaseRestoreRecoveryActionPhase.PREPARING
				? 'NOT_APPLIED'
				: 'FENCED';
		await this.alerts.recordInTransaction(transaction, {
			deduplicationKey: `database-restore:${event.target}`,
			type: 'INTEGRATION_PROBLEM',
			severity: OperationalAlertSeverity.HIGH,
			source: 'operations',
			referenceId: event.actionId,
			title: `Recovery базы ${event.target} заблокирован`,
			message: physicalFenceUnconfirmed
				? 'Физическое состояние writer fence не подтверждено; требуется немедленная ручная проверка до нового recovery action'
				: phase === DatabaseRestoreRecoveryActionPhase.PREPARING
					? 'Recovery остановлен до применения writer fence; требуется новый dual-approved action'
					: 'Writer fence остаётся закрытым; требуется новый dual-approved recovery action',
			metadata: {
				jobId: event.jobId,
				action: event.action,
				lastError,
				writerFenceStatus
			}
		});
		await this.audit.recordInTransaction(transaction, {
			section: 'DEV_TOOLS',
			action: 'DEV_DATABASE_RESTORE_RECOVERY_BLOCKED',
			description: `Recovery action ${event.action} заблокирован для базы ${event.target}`,
			entityType: 'database_restore_recovery_action',
			entityId: event.actionId,
			metadata: { jobId: event.jobId, lastError, writerFenceStatus }
		});
	}

	private checkpointPhase(
		phase: DatabaseRestoreRecoveryCheckpoint['phase']
	): DatabaseRestoreRecoveryActionPhase {
		return DatabaseRestoreRecoveryActionPhase[phase];
	}

	private allowedPreviousPhases(
		phase: DatabaseRestoreRecoveryActionPhase
	): DatabaseRestoreRecoveryActionPhase[] {
		switch (phase) {
			case DatabaseRestoreRecoveryActionPhase.FENCING:
				return [DatabaseRestoreRecoveryActionPhase.PREPARING];
			case DatabaseRestoreRecoveryActionPhase.FENCED:
				return [DatabaseRestoreRecoveryActionPhase.FENCING];
			case DatabaseRestoreRecoveryActionPhase.MUTATING:
				return [DatabaseRestoreRecoveryActionPhase.FENCED];
			case DatabaseRestoreRecoveryActionPhase.VERIFYING:
				return [
					DatabaseRestoreRecoveryActionPhase.FENCED,
					DatabaseRestoreRecoveryActionPhase.MUTATING
				];
			case DatabaseRestoreRecoveryActionPhase.VERIFIED:
				return [DatabaseRestoreRecoveryActionPhase.VERIFYING];
			case DatabaseRestoreRecoveryActionPhase.UNFENCING:
				return [DatabaseRestoreRecoveryActionPhase.VERIFIED];
			default:
				throw new Error('Database restore recovery phase is invalid');
		}
	}

	private retentionHours(): number {
		const raw = this.config
			.get<string>('DATABASE_RESTORE_ARTIFACT_RETENTION_HOURS')
			?.trim();
		const value = raw ? Number(raw) : DEFAULT_ARTIFACT_RETENTION_HOURS;
		if (!Number.isSafeInteger(value) || value < 24 || value > 30 * 24) {
			throw new Error(
				'DATABASE_RESTORE_ARTIFACT_RETENTION_HOURS must be between 24 and 720'
			);
		}
		return value;
	}

	private nextLeaseExpiry(): Date {
		return new Date(Date.now() + RECOVERY_LEASE_MS);
	}

	private safeError(error: unknown): string {
		return (error instanceof Error ? error.message : String(error))
			.replace(/[\r\n]+/g, ' ')
			.slice(0, 2_000);
	}
}
