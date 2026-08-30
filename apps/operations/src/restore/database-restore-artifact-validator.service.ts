import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { DatabaseRestoreTargetConfiguration } from './database-restore-target-registry.service';

@Injectable()
export class DatabaseRestoreArtifactValidatorService {
	async sha256(path: string): Promise<string> {
		const hash = createHash('sha256');
		for await (const chunk of createReadStream(path)) hash.update(chunk);
		return hash.digest('hex');
	}

	assertChecksum(actualSha256: string, expectedSha256: string): void {
		if (actualSha256 !== expectedSha256) {
			throw new Error('Restore dump checksum mismatch');
		}
	}

	assertTableOfContents(
		tableOfContents: string,
		target: DatabaseRestoreTargetConfiguration,
		allTargets: DatabaseRestoreTargetConfiguration[]
	): void {
		if (!tableOfContents.includes(` ${target.schema} `)) {
			throw new Error(
				'Restore dump does not contain the exact target schema'
			);
		}
		for (const other of allTargets) {
			if (
				other.schema !== target.schema &&
				tableOfContents.includes(` SCHEMA - ${other.schema} `)
			) {
				throw new Error('Restore dump contains a foreign service schema');
			}
		}
	}
}
