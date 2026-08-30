import { Injectable } from '@nestjs/common';
import { DatabaseRestoreTarget } from './database-restore.contract';
import { DatabaseRestoreArtifactValidatorService } from './database-restore-artifact-validator.service';
import { DatabaseRestoreProcessService } from './database-restore-process.service';
import { DatabaseRestoreTargetRegistryService } from './database-restore-target-registry.service';

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
	}) {
		const target = this.targets.get(input.target);
		const connection = await this.targets.connection(target);
		const actualSha256 = await this.artifacts.sha256(input.source);
		this.artifacts.assertChecksum(actualSha256, input.expectedSha256);
		const tableOfContents = await this.process.listDump(
			input.source,
			connection.password
		);
		this.artifacts.assertTableOfContents(tableOfContents, target);
		const safetyPath = `${input.source}.safety`;
		await this.process.createSafetyCopy(
			connection,
			target.schema,
			safetyPath
		);
		const safetySha256 = await this.artifacts.sha256(safetyPath);
		try {
			await this.process.recreateSchema(connection, target);
			await this.process.restoreSchema(connection, target, input.source);
			await this.process.applyAcl(connection, target);
			if (
				!(await this.process.verifyMigrationLedger(connection, target))
			) {
				throw new Error('Restored database migration ledger is missing');
			}
			return {
				target: input.target,
				safetyBackupFileName:
					safetyPath.split('/').pop() || `${input.jobId}.safety`,
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
