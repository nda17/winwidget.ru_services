import { Injectable } from '@nestjs/common';
import { DatabaseRestoreTarget } from './database-restore.contract';
import { DatabaseRestoreArtifactValidatorService } from './database-restore-artifact-validator.service';
import { DatabaseRestoreProcessService } from './database-restore-process.service';
import { DatabaseRestoreTargetRegistryService } from './database-restore-target-registry.service';

export type DatabaseRestoreCheckpoint =
	| {
			phase: 'SAFETY_READY';
			safetyBackupFileName: string;
			safetyBackupSha256: string;
	  }
	| { phase: 'MUTATING' }
	| { phase: 'VERIFIED' };

@Injectable()
export class DatabaseRestoreExecutorService {
	constructor(
		private readonly targets: DatabaseRestoreTargetRegistryService,
		private readonly artifacts: DatabaseRestoreArtifactValidatorService,
		private readonly process: DatabaseRestoreProcessService
	) {}

	async restore(input: {
		jobId: string;
		target: DatabaseRestoreTarget;
		source: string;
		expectedSha256: string;
		signal: AbortSignal;
		checkpoint: (checkpoint: DatabaseRestoreCheckpoint) => Promise<void>;
	}) {
		input.signal.throwIfAborted();
		const target = this.targets.get(input.target);
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
			await input.checkpoint({ phase: 'MUTATING' });
			input.signal.throwIfAborted();
			await this.process.recreateSchema(connection, target, input.signal);
			await this.process.restoreSchema(
				connection,
				target,
				input.source,
				input.signal
			);
			await this.process.applyAcl(connection, target, input.signal);
			if (
				!(await this.process.verifyMigrationLedger(
					connection,
					target,
					input.signal
				))
			) {
				throw new Error('Restored database migration ledger is missing');
			}
			input.signal.throwIfAborted();
			await input.checkpoint({ phase: 'VERIFIED' });
			return {
				target: input.target,
				safetyBackupFileName,
				safetyBackupSha256: safetySha256,
				restoredAt: new Date().toISOString(),
				verifiedAt: new Date().toISOString()
			};
		} catch (error) {
			throw new Error(
				`Database restore failed after safety backup ${safetySha256}: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}
}
