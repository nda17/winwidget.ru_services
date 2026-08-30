import { Injectable } from '@nestjs/common';
import {
	DatabaseRestoreExecutionOperationType,
	DatabaseRestoreJobStatus,
	DatabaseRestorePermitStatus,
	DatabaseRestoreRecoveryActionStatus,
	DatabaseRestoreRecoveryActionType,
	Prisma
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { DatabaseRestoreTarget } from './database-restore.contract';
import { DatabaseRestoreReceiptService } from './database-restore-receipt.service';

export const DATABASE_RESTORE_RELEASE_AUTHORIZATION_COMMIT_UNKNOWN =
	'DATABASE_RESTORE_RELEASE_AUTHORIZATION_COMMIT_UNKNOWN';

export interface DatabaseRestoreReleaseVerification {
	verifiedAt: Date;
	migrationLedgerSha256: string;
	aclEvidenceSha256: string;
	verifiedWriterFenceSha256: string;
}

export interface DatabaseRestoreReleaseAuthorizationEvidence {
	id: string;
	operationType: DatabaseRestoreExecutionOperationType;
	operationId: string;
	jobId: string;
	actionId: string | null;
	target: string;
	expectedServicesSha: string;
	migrationManifestSha: string;
	payloadSha256: string;
	verifiedAt: Date;
	writerFenceAppliedAt: Date;
	writerFenceEvidenceSha256: string;
}

interface DatabaseRestoreReleaseAuthorizationPayload {
	operationType: DatabaseRestoreExecutionOperationType;
	operationId: string;
	jobId: string;
	actionId: string | null;
	permitId: string | null;
	eventId: string;
	target: string;
	recoveryAction: DatabaseRestoreRecoveryActionType | null;
	initialReceiptPayloadSha256: string | null;
	sourceSha256: string;
	artifactSha256: string | null;
	expectedServicesSha: string;
	migrationManifestSha: string;
	requestedById: string;
	approvedById: string;
	approvedAt: Date;
	approvalEvidenceSha256: string;
	writerFenceRoles: unknown;
	writerFenceAppliedAt: Date;
	writerFenceEvidenceSha256: string;
	verifiedAt: Date;
	migrationLedgerSha256: string;
	aclEvidenceSha256: string;
	verifiedWriterFenceSha256: string;
	authorizedAt: Date;
}

@Injectable()
export class DatabaseRestoreReleaseAuthorizationService {
	constructor(
		private readonly prisma: OperationsPrismaService,
		private readonly receipts: DatabaseRestoreReceiptService
	) {}

	async createRestore(
		transaction: Prisma.TransactionClient,
		jobId: string,
		verification: DatabaseRestoreReleaseVerification
	): Promise<void> {
		this.assertVerification(verification);
		const job = await transaction.databaseRestoreJob.findUnique({
			where: { id: jobId },
			include: { permit: true }
		});
		if (
			!job ||
			job.status !== DatabaseRestoreJobStatus.PROCESSING ||
			job.phase !== 'UNFENCING' ||
			!job.writerFenceRoles ||
			!job.writerFenceAppliedAt ||
			!job.writerFenceEvidenceSha256 ||
			!job.safetyBackupSha256 ||
			!/^[0-9a-f]{64}$/.test(job.safetyBackupSha256) ||
			job.permit.status !== DatabaseRestorePermitStatus.CONSUMED ||
			job.permit.requestedById !== job.requestedById ||
			!job.permit.approvedById ||
			!job.permit.approvedAt ||
			!job.permit.consumedAt
		) {
			throw new Error(
				'Database restore release authorization evidence is incomplete'
			);
		}
		if (
			verification.verifiedWriterFenceSha256 !==
			job.writerFenceEvidenceSha256
		) {
			throw new Error(
				'Database restore release generation evidence drifted'
			);
		}
		const approvalEvidenceSha256 = this.receipts.sha256(
			this.receipts.canonicalize({
				approvalVersion: 1,
				permitId: job.permit.id,
				jobId: job.id,
				target: job.target,
				sourceSha256: job.sourceSha256,
				expectedServicesSha: job.expectedServicesSha,
				migrationManifestSha: job.migrationManifestSha,
				requestedById: job.permit.requestedById,
				approvedById: job.permit.approvedById,
				createdAt: job.permit.createdAt.toISOString(),
				approvedAt: job.permit.approvedAt.toISOString(),
				expiresAt: job.permit.expiresAt.toISOString(),
				consumedAt: job.permit.consumedAt.toISOString()
			})
		);
		const authorizedAt = this.authorizationTime(verification.verifiedAt);
		const record = {
			operationType: DatabaseRestoreExecutionOperationType.RESTORE,
			operationId: job.id,
			jobId: job.id,
			actionId: null,
			permitId: job.permitId,
			eventId: job.eventId,
			target: job.target,
			recoveryAction: null,
			initialReceiptPayloadSha256: null,
			sourceSha256: job.sourceSha256,
			artifactSha256: job.safetyBackupSha256,
			expectedServicesSha: job.expectedServicesSha,
			migrationManifestSha: job.migrationManifestSha,
			requestedById: job.permit.requestedById,
			approvedById: job.permit.approvedById,
			approvedAt: job.permit.approvedAt,
			approvalEvidenceSha256,
			writerFenceRoles: job.writerFenceRoles,
			writerFenceAppliedAt: job.writerFenceAppliedAt,
			writerFenceEvidenceSha256: job.writerFenceEvidenceSha256,
			...verification,
			authorizedAt
		};
		const signature = this.receipts.sign(this.payload(record));
		await transaction.databaseRestoreReleaseAuthorization.create({
			data: {
				id: randomUUID(),
				...record,
				writerFenceRoles: record.writerFenceRoles as Prisma.InputJsonValue,
				...signature
			}
		});
	}

	async createRecovery(
		transaction: Prisma.TransactionClient,
		actionId: string,
		verification: DatabaseRestoreReleaseVerification
	): Promise<void> {
		this.assertVerification(verification);
		const action =
			await transaction.databaseRestoreRecoveryAction.findUnique({
				where: { id: actionId },
				include: { restoreJob: { include: { terminalReceipt: true } } }
			});
		if (
			!action ||
			action.status !== DatabaseRestoreRecoveryActionStatus.PROCESSING ||
			action.phase !== 'UNFENCING' ||
			!action.eventId ||
			!action.approvedById ||
			!action.approvedAt ||
			!action.writerFenceRoles ||
			!action.writerFenceAppliedAt ||
			!action.writerFenceEvidenceSha256 ||
			!action.restoreJob.terminalReceipt ||
			action.receiptPayloadSha !==
				action.restoreJob.terminalReceipt.payloadSha256
		) {
			throw new Error(
				'Database restore recovery release authorization evidence is incomplete'
			);
		}
		if (
			verification.verifiedWriterFenceSha256 !==
			action.writerFenceEvidenceSha256
		) {
			throw new Error(
				'Database restore recovery release generation evidence drifted'
			);
		}
		const approvalEvidenceSha256 = this.receipts.sha256(
			this.receipts.canonicalize({
				approvalVersion: 1,
				actionId: action.id,
				jobId: action.jobId,
				eventId: action.eventId,
				action: action.action,
				initialReceiptPayloadSha256: action.receiptPayloadSha,
				requestedById: action.requestedById,
				approvedById: action.approvedById,
				createdAt: action.createdAt.toISOString(),
				approvedAt: action.approvedAt.toISOString(),
				expiresAt: action.expiresAt.toISOString()
			})
		);
		const authorizedAt = this.authorizationTime(verification.verifiedAt);
		const record = {
			operationType: DatabaseRestoreExecutionOperationType.RECOVERY,
			operationId: action.id,
			jobId: action.jobId,
			actionId: action.id,
			permitId: null,
			eventId: action.eventId,
			target: action.restoreJob.target,
			recoveryAction: action.action,
			initialReceiptPayloadSha256: action.receiptPayloadSha,
			sourceSha256: action.restoreJob.sourceSha256,
			artifactSha256: action.artifactSha256,
			expectedServicesSha: action.restoreJob.expectedServicesSha,
			migrationManifestSha: action.restoreJob.migrationManifestSha,
			requestedById: action.requestedById,
			approvedById: action.approvedById,
			approvedAt: action.approvedAt,
			approvalEvidenceSha256,
			writerFenceRoles: action.writerFenceRoles,
			writerFenceAppliedAt: action.writerFenceAppliedAt,
			writerFenceEvidenceSha256: action.writerFenceEvidenceSha256,
			...verification,
			authorizedAt
		};
		const signature = this.receipts.sign(this.payload(record));
		await transaction.databaseRestoreReleaseAuthorization.create({
			data: {
				id: randomUUID(),
				...record,
				writerFenceRoles: record.writerFenceRoles as Prisma.InputJsonValue,
				...signature
			}
		});
	}

	async assertRestore(input: {
		jobId: string;
		eventId: string;
		target: DatabaseRestoreTarget;
		expectedServicesSha: string;
		migrationManifestSha: string;
	}): Promise<DatabaseRestoreReleaseAuthorizationEvidence | null> {
		const authorization =
			await this.prisma.databaseRestoreReleaseAuthorization.findFirst({
				where: {
					operationType: DatabaseRestoreExecutionOperationType.RESTORE,
					operationId: input.jobId
				},
				include: { restoreJob: { include: { permit: true } } }
			});
		if (!authorization) return null;
		const job = authorization.restoreJob;
		const permit = job.permit;
		if (
			!(
				(job.status === DatabaseRestoreJobStatus.PROCESSING &&
					(job.phase === 'UNFENCING' || job.phase === 'UNFENCED')) ||
				(job.status === DatabaseRestoreJobStatus.SUCCEEDED &&
					job.phase === 'UNFENCED')
			) ||
			authorization.jobId !== input.jobId ||
			authorization.actionId !== null ||
			authorization.permitId !== permit.id ||
			authorization.eventId !== input.eventId ||
			authorization.target !== input.target ||
			authorization.target !== job.target ||
			authorization.sourceSha256 !== job.sourceSha256 ||
			!authorization.artifactSha256 ||
			!/^[0-9a-f]{64}$/.test(authorization.artifactSha256) ||
			authorization.artifactSha256 !== job.safetyBackupSha256 ||
			authorization.expectedServicesSha !== input.expectedServicesSha ||
			authorization.expectedServicesSha !== job.expectedServicesSha ||
			authorization.migrationManifestSha !== input.migrationManifestSha ||
			authorization.migrationManifestSha !== job.migrationManifestSha ||
			permit.requestedById !== job.requestedById ||
			authorization.requestedById !== permit.requestedById ||
			authorization.approvedById !== permit.approvedById ||
			!permit.approvedAt ||
			!permit.consumedAt ||
			authorization.approvedAt.getTime() !== permit.approvedAt.getTime() ||
			!(
				[
					DatabaseRestorePermitStatus.CONSUMED,
					DatabaseRestorePermitStatus.CLOSED
				] as DatabaseRestorePermitStatus[]
			).includes(permit.status) ||
			!job.writerFenceRoles ||
			!job.writerFenceAppliedAt ||
			!job.writerFenceEvidenceSha256 ||
			this.receipts.canonicalize(authorization.writerFenceRoles) !==
				this.receipts.canonicalize(job.writerFenceRoles) ||
			authorization.writerFenceAppliedAt.getTime() !==
				job.writerFenceAppliedAt.getTime() ||
			authorization.writerFenceEvidenceSha256 !==
				job.writerFenceEvidenceSha256 ||
			authorization.verifiedWriterFenceSha256 !==
				authorization.writerFenceEvidenceSha256
		) {
			throw new Error(
				'Database restore release authorization binding drifted'
			);
		}
		const approvalEvidenceSha256 = this.receipts.sha256(
			this.receipts.canonicalize({
				approvalVersion: 1,
				permitId: permit.id,
				jobId: job.id,
				target: job.target,
				sourceSha256: job.sourceSha256,
				expectedServicesSha: job.expectedServicesSha,
				migrationManifestSha: job.migrationManifestSha,
				requestedById: permit.requestedById,
				approvedById: permit.approvedById,
				createdAt: permit.createdAt.toISOString(),
				approvedAt: permit.approvedAt.toISOString(),
				expiresAt: permit.expiresAt.toISOString(),
				consumedAt: permit.consumedAt.toISOString()
			})
		);
		this.assertSigned(authorization, approvalEvidenceSha256);
		return this.evidence(authorization);
	}

	async assertRecovery(input: {
		actionId: string;
		jobId: string;
		eventId: string;
		target: DatabaseRestoreTarget;
		action: DatabaseRestoreRecoveryActionType;
		receiptPayloadSha: string;
		expectedServicesSha: string;
		migrationManifestSha: string;
	}): Promise<DatabaseRestoreReleaseAuthorizationEvidence | null> {
		const authorization =
			await this.prisma.databaseRestoreReleaseAuthorization.findFirst({
				where: {
					operationType: DatabaseRestoreExecutionOperationType.RECOVERY,
					operationId: input.actionId
				},
				include: {
					restoreJob: { include: { terminalReceipt: true } },
					recoveryActionRecord: true
				}
			});
		if (!authorization) return null;
		const action = authorization.recoveryActionRecord;
		const job = authorization.restoreJob;
		const expectedArtifactSha256 =
			action?.action === DatabaseRestoreRecoveryActionType.VERIFY_AS_IS
				? null
				: action?.action ===
					  DatabaseRestoreRecoveryActionType.ROLL_BACK_SAFETY
					? job.safetyBackupSha256
					: job.sourceSha256;
		if (
			!action ||
			job.status !== DatabaseRestoreJobStatus.RECOVERY_REQUIRED ||
			!(
				(action.status ===
					DatabaseRestoreRecoveryActionStatus.PROCESSING &&
					action.phase === 'UNFENCING' &&
					!job.recoveryResolvedAt) ||
				(action.status === DatabaseRestoreRecoveryActionStatus.RESOLVED &&
					action.phase === 'RESOLVED' &&
					Boolean(job.recoveryResolvedAt))
			) ||
			action.jobId !== job.id ||
			action.eventId !== input.eventId ||
			authorization.actionId !== input.actionId ||
			authorization.jobId !== input.jobId ||
			authorization.permitId !== null ||
			authorization.eventId !== input.eventId ||
			authorization.target !== input.target ||
			authorization.target !== job.target ||
			authorization.recoveryAction !== input.action ||
			authorization.recoveryAction !== action.action ||
			authorization.initialReceiptPayloadSha256 !==
				input.receiptPayloadSha ||
			authorization.initialReceiptPayloadSha256 !==
				action.receiptPayloadSha ||
			authorization.initialReceiptPayloadSha256 !==
				job.terminalReceipt?.payloadSha256 ||
			authorization.sourceSha256 !== job.sourceSha256 ||
			authorization.artifactSha256 !== action.artifactSha256 ||
			authorization.artifactSha256 !== expectedArtifactSha256 ||
			authorization.expectedServicesSha !== input.expectedServicesSha ||
			authorization.expectedServicesSha !== job.expectedServicesSha ||
			authorization.migrationManifestSha !== input.migrationManifestSha ||
			authorization.migrationManifestSha !== job.migrationManifestSha ||
			authorization.requestedById !== action.requestedById ||
			authorization.approvedById !== action.approvedById ||
			!action.eventId ||
			!action.approvedAt ||
			authorization.approvedAt.getTime() !== action.approvedAt.getTime() ||
			!action.writerFenceRoles ||
			!action.writerFenceAppliedAt ||
			!action.writerFenceEvidenceSha256 ||
			this.receipts.canonicalize(authorization.writerFenceRoles) !==
				this.receipts.canonicalize(action.writerFenceRoles) ||
			authorization.writerFenceAppliedAt.getTime() !==
				action.writerFenceAppliedAt.getTime() ||
			authorization.writerFenceEvidenceSha256 !==
				action.writerFenceEvidenceSha256 ||
			authorization.verifiedWriterFenceSha256 !==
				authorization.writerFenceEvidenceSha256
		) {
			throw new Error(
				'Database restore recovery release authorization binding drifted'
			);
		}
		const approvalEvidenceSha256 = this.receipts.sha256(
			this.receipts.canonicalize({
				approvalVersion: 1,
				actionId: action.id,
				jobId: action.jobId,
				eventId: action.eventId,
				action: action.action,
				initialReceiptPayloadSha256: action.receiptPayloadSha,
				requestedById: action.requestedById,
				approvedById: action.approvedById,
				createdAt: action.createdAt.toISOString(),
				approvedAt: action.approvedAt.toISOString(),
				expiresAt: action.expiresAt.toISOString()
			})
		);
		this.assertSigned(authorization, approvalEvidenceSha256);
		return this.evidence(authorization);
	}

	private assertSigned(
		authorization: DatabaseRestoreReleaseAuthorizationPayload & {
			approvalEvidenceSha256: string;
			payloadSha256: string;
			signatureHmacSha256: string;
			signatureKeyId: string;
		},
		approvalEvidenceSha256: string
	): void {
		if (authorization.approvalEvidenceSha256 !== approvalEvidenceSha256) {
			throw new Error(
				'Database restore release approval evidence drifted'
			);
		}
		this.receipts.assertSignature({
			payload: this.payload(authorization),
			payloadSha256: authorization.payloadSha256,
			signatureHmacSha256: authorization.signatureHmacSha256,
			signatureKeyId: authorization.signatureKeyId
		});
	}

	private payload(
		input: DatabaseRestoreReleaseAuthorizationPayload
	): string {
		return this.receipts.canonicalize({
			releaseAuthorizationVersion: 1,
			operationType: input.operationType,
			operationId: input.operationId,
			jobId: input.jobId,
			actionId: input.actionId,
			permitId: input.permitId,
			eventId: input.eventId,
			target: input.target,
			recoveryAction: input.recoveryAction,
			initialReceiptPayloadSha256: input.initialReceiptPayloadSha256,
			sourceSha256: input.sourceSha256,
			artifactSha256: input.artifactSha256,
			expectedServicesSha: input.expectedServicesSha,
			migrationManifestSha: input.migrationManifestSha,
			requestedById: input.requestedById,
			approvedById: input.approvedById,
			approvedAt: input.approvedAt.toISOString(),
			approvalEvidenceSha256: input.approvalEvidenceSha256,
			writerFenceRoles: input.writerFenceRoles,
			writerFenceAppliedAt: input.writerFenceAppliedAt.toISOString(),
			writerFenceEvidenceSha256: input.writerFenceEvidenceSha256,
			verifiedAt: input.verifiedAt.toISOString(),
			migrationLedgerSha256: input.migrationLedgerSha256,
			aclEvidenceSha256: input.aclEvidenceSha256,
			verifiedWriterFenceSha256: input.verifiedWriterFenceSha256,
			authorizedAt: input.authorizedAt.toISOString()
		});
	}

	private evidence(input: {
		id: string;
		operationType: DatabaseRestoreExecutionOperationType;
		operationId: string;
		jobId: string;
		actionId: string | null;
		target: string;
		expectedServicesSha: string;
		migrationManifestSha: string;
		payloadSha256: string;
		verifiedAt: Date;
		writerFenceAppliedAt: Date;
		writerFenceEvidenceSha256: string;
	}): DatabaseRestoreReleaseAuthorizationEvidence {
		return {
			id: input.id,
			operationType: input.operationType,
			operationId: input.operationId,
			jobId: input.jobId,
			actionId: input.actionId,
			target: input.target,
			expectedServicesSha: input.expectedServicesSha,
			migrationManifestSha: input.migrationManifestSha,
			payloadSha256: input.payloadSha256,
			verifiedAt: input.verifiedAt,
			writerFenceAppliedAt: input.writerFenceAppliedAt,
			writerFenceEvidenceSha256: input.writerFenceEvidenceSha256
		};
	}

	private authorizationTime(verifiedAt: Date): Date {
		return new Date(Math.max(Date.now(), verifiedAt.getTime()));
	}

	private assertVerification(
		verification: DatabaseRestoreReleaseVerification
	): void {
		for (const value of [
			verification.migrationLedgerSha256,
			verification.aclEvidenceSha256,
			verification.verifiedWriterFenceSha256
		]) {
			if (!/^[0-9a-f]{64}$/.test(value)) {
				throw new Error(
					'Database restore release verification evidence is invalid'
				);
			}
		}
	}
}
