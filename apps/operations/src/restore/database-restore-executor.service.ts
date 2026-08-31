import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseRestoreTarget } from './database-restore.contract';
import { DatabaseRestoreAclService } from './database-restore-acl.service';
import { DatabaseRestoreArtifactValidatorService } from './database-restore-artifact-validator.service';
import { DatabaseRestoreProcessService } from './database-restore-process.service';
import { DatabaseRestoreMigrationManifestService } from './database-restore-migration-manifest.service';
import { DatabaseRestoreTargetRegistryService } from './database-restore-target-registry.service';
import {
	DatabaseRestoreWriterFenceService,
	type DatabaseRestoreWriterFenceEvidence
} from './database-restore-writer-fence.service';

export type DatabaseRestoreCheckpoint =
	| {
			phase: 'FENCING';
			writerFenceRoles: [string, string, string];
	  }
	| {
			phase: 'FENCED';
			writerFenceRoles: [string, string, string];
			writerFenceAppliedAt: Date;
			writerFenceEvidenceSha256: string;
	  }
	| {
			phase: 'SAFETY_READY';
			safetyBackupFileName: string;
			safetyBackupSha256: string;
	  }
	| { phase: 'MUTATING' }
	| { phase: 'VERIFIED' }
	| {
			phase: 'UNFENCING';
			verifiedAt: Date;
			migrationLedgerSha256: string;
			aclEvidenceSha256: string;
			verifiedWriterFenceSha256: string;
	  }
	| {
			phase: 'UNFENCED';
			writerFenceReleasedAt: Date;
			writerFenceReleaseEvidenceSha256: string;
	  };

@Injectable()
export class DatabaseRestoreExecutorService {
	constructor(
		private readonly targets: DatabaseRestoreTargetRegistryService,
		private readonly artifacts: DatabaseRestoreArtifactValidatorService,
		private readonly process: DatabaseRestoreProcessService,
		private readonly acl: DatabaseRestoreAclService,
		private readonly manifests: DatabaseRestoreMigrationManifestService,
		private readonly writerFence: DatabaseRestoreWriterFenceService
	) {}

	async restore(input: {
		jobId: string;
		target: DatabaseRestoreTarget;
		source: string;
		expectedSha256: string;
		migrationManifestSha: string;
		signal: AbortSignal;
		checkpoint: (checkpoint: DatabaseRestoreCheckpoint) => Promise<void>;
	}) {
		input.signal.throwIfAborted();
		const target = this.targets.get(input.target);
		this.manifests.assertBinding(input.target, input.migrationManifestSha);
		const connection = await this.targets.connection(target);
		input.signal.throwIfAborted();
		const actualSha256 = await this.artifacts.sha256(input.source);
		this.artifacts.assertChecksum(actualSha256, input.expectedSha256);
		const tableOfContents = await this.process.listDump(
			input.source,
			connection.password,
			input.signal
		);
		this.artifacts.assertTableOfContents(tableOfContents, target);
		const sourceMigrationLedger =
			await this.process.extractMigrationLedger(
				input.source,
				target,
				input.signal
			);
		this.manifests.assertDumpLedger(
			input.target,
			target.schema,
			sourceMigrationLedger
		);
		await this.acl.verify(connection, target, input.signal);
		const writerFenceRoles: [string, string, string] = [
			target.runtimeRole,
			target.migrationRole,
			target.backupRole
		];
		await input.checkpoint({ phase: 'FENCING', writerFenceRoles });
		const fenceEvidence = await this.writerFence.apply(
			connection,
			target,
			input.jobId,
			input.signal
		);
		await input.checkpoint({
			phase: 'FENCED',
			writerFenceRoles: fenceEvidence.roles,
			writerFenceAppliedAt: fenceEvidence.verifiedAt,
			writerFenceEvidenceSha256: fenceEvidence.evidenceSha256
		});
		const currentMigrationLedger = await this.process.readMigrationLedger(
			connection,
			target,
			input.signal
		);
		this.manifests.assertDatabaseLedger(
			input.target,
			currentMigrationLedger
		);
		const safetyPath = `${input.source}.safety`;
		await this.process.createSafetyCopy(
			connection,
			target.schema,
			safetyPath,
			input.signal
		);
		const safetyTableOfContents = await this.process.listDump(
			safetyPath,
			connection.password,
			input.signal
		);
		this.artifacts.assertTableOfContents(safetyTableOfContents, target);
		const safetyMigrationLedger =
			await this.process.extractMigrationLedger(
				safetyPath,
				target,
				input.signal
			);
		this.manifests.assertDumpLedger(
			input.target,
			target.schema,
			safetyMigrationLedger
		);
		const safetySha256 = await this.artifacts.sha256(safetyPath);
		input.signal.throwIfAborted();
		const safetyBackupFileName =
			safetyPath.split('/').pop() || `${input.jobId}.safety`;
		await input.checkpoint({
			phase: 'SAFETY_READY',
			safetyBackupFileName,
			safetyBackupSha256: safetySha256
		});
		input.signal.throwIfAborted();
		try {
			await this.writerFence.verify(
				connection,
				target,
				fenceEvidence.evidenceSha256,
				input.signal
			);
			await input.checkpoint({ phase: 'MUTATING' });
			input.signal.throwIfAborted();
			await this.process.recreateSchema(connection, target, input.signal);
			await this.process.restoreSchema(
				connection,
				target,
				input.source,
				input.signal
			);
			await this.acl.reconcileAndVerify(
				connection,
				target,
				input.signal,
				'FENCED'
			);
			const restoredMigrationLedger =
				await this.process.readMigrationLedger(
					connection,
					target,
					input.signal
				);
			this.manifests.assertDatabaseLedger(
				input.target,
				restoredMigrationLedger
			);
			input.signal.throwIfAborted();
			await input.checkpoint({ phase: 'VERIFIED' });
			const releaseMigrationLedger =
				await this.process.readMigrationLedger(
					connection,
					target,
					input.signal
				);
			this.manifests.assertDatabaseLedger(
				input.target,
				releaseMigrationLedger
			);
			await this.acl.verify(connection, target, input.signal, 'FENCED');
			const releaseFenceEvidence = await this.writerFence.verify(
				connection,
				target,
				fenceEvidence.evidenceSha256,
				input.signal
			);
			await input.checkpoint({
				phase: 'UNFENCING',
				...this.releaseVerification(
					target,
					releaseMigrationLedger,
					releaseFenceEvidence
				)
			});
			const releaseEvidence = await this.writerFence.release(
				connection,
				target,
				fenceEvidence.evidenceSha256,
				input.signal
			);
			await input.checkpoint({
				phase: 'UNFENCED',
				writerFenceReleasedAt: releaseEvidence.verifiedAt,
				writerFenceReleaseEvidenceSha256: releaseEvidence.evidenceSha256
			});
			return {
				target: input.target,
				safetyBackupFileName,
				safetyBackupSha256: safetySha256,
				restoredAt: new Date().toISOString(),
				verifiedAt: new Date().toISOString(),
				writerFenceAppliedAt: fenceEvidence.verifiedAt.toISOString(),
				writerFenceReleasedAt: releaseEvidence.verifiedAt.toISOString()
			};
		} catch (error) {
			throw new Error(
				`Database restore failed after safety backup ${safetySha256}: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	async reapplyFence(
		targetName: DatabaseRestoreTarget,
		operationId: string
	): Promise<DatabaseRestoreWriterFenceEvidence> {
		const target = this.targets.get(targetName);
		const connection = await this.targets.connection(target);
		return this.writerFence.reapply(connection, target, operationId);
	}

	async reconcileSucceeded(
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

	private releaseVerification(
		target: ReturnType<DatabaseRestoreTargetRegistryService['get']>,
		migrationLedger: string,
		writerFence: DatabaseRestoreWriterFenceEvidence
	) {
		return {
			verifiedAt: new Date(),
			migrationLedgerSha256: this.sha256(migrationLedger.trim()),
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
			verifiedWriterFenceSha256: writerFence.evidenceSha256
		};
	}

	private sha256(value: string): string {
		return createHash('sha256').update(value).digest('hex');
	}
}
