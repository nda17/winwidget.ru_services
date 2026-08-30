import { Injectable } from '@nestjs/common';
import { DatabaseRestoreRecoveryActionType } from '@prisma/operations-client';
import { createHash } from 'node:crypto';
import { DatabaseRestoreAclService } from './database-restore-acl.service';
import { DatabaseRestoreArtifactValidatorService } from './database-restore-artifact-validator.service';
import { DatabaseRestoreMigrationManifestService } from './database-restore-migration-manifest.service';
import { DatabaseRestoreProcessService } from './database-restore-process.service';
import type { DatabaseRestoreRecoveryCheckpoint } from './database-restore-recovery-state.service';
import { DatabaseRestoreTarget } from './database-restore.contract';
import { DatabaseRestoreTargetRegistryService } from './database-restore-target-registry.service';
import {
	DatabaseRestoreWriterFenceService,
	type DatabaseRestoreWriterFenceEvidence
} from './database-restore-writer-fence.service';

@Injectable()
export class DatabaseRestoreRecoveryExecutorService {
	constructor(
		private readonly targets: DatabaseRestoreTargetRegistryService,
		private readonly artifacts: DatabaseRestoreArtifactValidatorService,
		private readonly process: DatabaseRestoreProcessService,
		private readonly acl: DatabaseRestoreAclService,
		private readonly manifests: DatabaseRestoreMigrationManifestService,
		private readonly writerFence: DatabaseRestoreWriterFenceService
	) {}

	async execute(input: {
		actionId: string;
		action: DatabaseRestoreRecoveryActionType;
		target: DatabaseRestoreTarget;
		source: string;
		sourceSha256: string;
		safetyBackupSha256: string | null;
		migrationManifestSha: string;
		signal: AbortSignal;
		checkpoint: (
			checkpoint: DatabaseRestoreRecoveryCheckpoint
		) => Promise<void>;
	}) {
		input.signal.throwIfAborted();
		const target = this.targets.get(input.target);
		this.manifests.assertBinding(input.target, input.migrationManifestSha);
		const connection = await this.targets.connection(target);
		const roles: [string, string, string] = [
			target.runtimeRole,
			target.migrationRole,
			target.backupRole
		];
		await input.checkpoint({
			phase: 'FENCING',
			writerFenceRoles: roles
		});
		const fenceEvidence = await this.writerFence.apply(
			connection,
			target,
			input.actionId,
			input.signal
		);
		const artifact = await this.validateSelectedArtifact(
			input,
			connection,
			target
		);
		await input.checkpoint({
			phase: 'FENCED',
			artifactSha256: artifact?.sha256 ?? null,
			writerFenceRoles: fenceEvidence.roles,
			writerFenceAppliedAt: fenceEvidence.verifiedAt,
			writerFenceEvidenceSha256: fenceEvidence.evidenceSha256
		});

		if (artifact) {
			await this.writerFence.verify(
				connection,
				target,
				fenceEvidence.evidenceSha256,
				input.signal
			);
			await input.checkpoint({ phase: 'MUTATING' });
			await this.process.recreateSchema(connection, target, input.signal);
			await this.process.restoreSchema(
				connection,
				target,
				artifact.path,
				input.signal
			);
			await this.acl.reconcileAndVerify(
				connection,
				target,
				input.signal,
				'FENCED'
			);
		}

		await input.checkpoint({ phase: 'VERIFYING' });
		await this.verifyTarget(
			input.target,
			connection,
			target,
			fenceEvidence.evidenceSha256,
			input.signal
		);
		await input.checkpoint({ phase: 'VERIFIED' });
		// Re-run all target-side proofs immediately before the irreversible
		// availability transition. A failed proof leaves every writer NOLOGIN.
		const releaseVerification = await this.verifyTarget(
			input.target,
			connection,
			target,
			fenceEvidence.evidenceSha256,
			input.signal
		);
		await input.checkpoint({
			phase: 'UNFENCING',
			verifiedAt: new Date(),
			migrationLedgerSha256: this.sha256(
				releaseVerification.migrationLedger.trim()
			),
			aclEvidenceSha256: this.sha256(
				JSON.stringify({
					verificationVersion: 1,
					database: target.database,
					schema: target.schema,
					adminRole: target.adminRole,
					migrationRole: target.migrationRole,
					runtimeRole: target.runtimeRole,
					backupRole: target.backupRole,
					acl: target.acl,
					roleMode: 'FENCED'
				})
			),
			verifiedWriterFenceSha256:
				releaseVerification.writerFence.evidenceSha256
		});
		const releaseEvidence = await this.writerFence.release(
			connection,
			target,
			fenceEvidence.evidenceSha256,
			input.signal
		);
		return {
			result: {
				target: input.target,
				action: input.action,
				artifactSha256: artifact?.sha256 ?? null,
				verifiedAt: new Date().toISOString(),
				writerFenceAppliedAt: fenceEvidence.verifiedAt.toISOString(),
				writerFenceReleasedAt: releaseEvidence.verifiedAt.toISOString()
			},
			writerFenceReleasedAt: releaseEvidence.verifiedAt,
			writerFenceReleaseEvidenceSha256: releaseEvidence.evidenceSha256
		};
	}

	async reapplyFence(
		targetName: DatabaseRestoreTarget,
		operationId: string
	): Promise<DatabaseRestoreWriterFenceEvidence> {
		const target = this.targets.get(targetName);
		const connection = await this.targets.connection(target);
		return this.writerFence.apply(connection, target, operationId);
	}

	async reconcileResolved(
		targetName: DatabaseRestoreTarget,
		migrationManifestSha: string,
		generationMarker: string,
		beforeRelease: () => Promise<void>
	): Promise<DatabaseRestoreWriterFenceEvidence> {
		const target = this.targets.get(targetName);
		this.manifests.assertBinding(targetName, migrationManifestSha);
		const connection = await this.targets.connection(target);
		const ledger = await this.process.readMigrationLedger(
			connection,
			target
		);
		this.manifests.assertDatabaseLedger(targetName, ledger);
		await this.acl.verify(connection, target, undefined, 'EITHER');
		await beforeRelease();
		return this.writerFence.ensureReleased(
			connection,
			target,
			generationMarker
		);
	}

	private async validateSelectedArtifact(
		input: {
			action: DatabaseRestoreRecoveryActionType;
			target: DatabaseRestoreTarget;
			source: string;
			sourceSha256: string;
			safetyBackupSha256: string | null;
			signal: AbortSignal;
		},
		connection: Awaited<
			ReturnType<DatabaseRestoreTargetRegistryService['connection']>
		>,
		target: ReturnType<DatabaseRestoreTargetRegistryService['get']>
	): Promise<{ path: string; sha256: string } | null> {
		if (input.action === DatabaseRestoreRecoveryActionType.VERIFY_AS_IS) {
			return null;
		}
		const path =
			input.action === DatabaseRestoreRecoveryActionType.ROLL_BACK_SAFETY
				? `${input.source}.safety`
				: input.source;
		const expectedSha256 =
			input.action === DatabaseRestoreRecoveryActionType.ROLL_BACK_SAFETY
				? input.safetyBackupSha256
				: input.sourceSha256;
		if (!expectedSha256) {
			throw new Error(
				'Approved recovery artifact has no recorded SHA-256'
			);
		}
		const sha256 = await this.artifacts.sha256(path);
		this.artifacts.assertChecksum(sha256, expectedSha256);
		const tableOfContents = await this.process.listDump(
			path,
			connection.password,
			input.signal
		);
		this.artifacts.assertTableOfContents(tableOfContents, target);
		const ledger = await this.process.extractMigrationLedger(
			path,
			target,
			input.signal
		);
		this.manifests.assertDumpLedger(input.target, target.schema, ledger);
		return { path, sha256 };
	}

	private async verifyTarget(
		targetName: DatabaseRestoreTarget,
		connection: Awaited<
			ReturnType<DatabaseRestoreTargetRegistryService['connection']>
		>,
		target: ReturnType<DatabaseRestoreTargetRegistryService['get']>,
		generationMarker: string,
		signal: AbortSignal
	): Promise<{
		migrationLedger: string;
		writerFence: DatabaseRestoreWriterFenceEvidence;
	}> {
		const ledger = await this.process.readMigrationLedger(
			connection,
			target,
			signal
		);
		this.manifests.assertDatabaseLedger(targetName, ledger);
		await this.acl.verify(connection, target, signal, 'FENCED');
		return {
			migrationLedger: ledger,
			writerFence: await this.writerFence.verify(
				connection,
				target,
				generationMarker,
				signal
			)
		};
	}

	private sha256(value: string): string {
		return createHash('sha256').update(value).digest('hex');
	}
}
