import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { DatabaseRestoreTargetConfiguration } from './database-restore-target-registry.service';

const SCHEMA_TOC_PREFIX = /^\d+;\s+\d+\s+\d+\s+SCHEMA(?:\s|$)/;
const SCHEMA_TOC_ENTRY = /^\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+(.+)$/;

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
		target: DatabaseRestoreTargetConfiguration
	): void {
		const schemaEntries = tableOfContents
			.split(/\r?\n/)
			.filter(line => SCHEMA_TOC_PREFIX.test(line))
			.map(line => {
				const match = SCHEMA_TOC_ENTRY.exec(line);
				if (!match) {
					throw new Error('Restore dump schema TOC entry is invalid');
				}
				return match[1];
			});
		const expectedSchemaEntry = `${target.schema} ${target.migrationRole}`;
		if (!schemaEntries.includes(expectedSchemaEntry)) {
			throw new Error(
				'Restore dump does not contain the exact target schema'
			);
		}
		if (schemaEntries.length !== 1) {
			throw new Error(
				'Restore dump must contain only the target service schema'
			);
		}
	}
}
