import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	DATABASE_BACKUP_PROVENANCE_TARGETS,
	isDatabaseBackupProvenanceTarget,
	DatabaseBackupProvenanceTarget
} from './database-backup.contract';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MIGRATION_NAME_PATTERN = /^[0-9]{14}_[a-z0-9_]+$/;

export interface DatabaseBackupMigrationManifest {
	target: DatabaseBackupProvenanceTarget;
	manifestSha256: string;
	migrations: ReadonlyArray<Readonly<{ name: string; checksum: string }>>;
}

const record = (
	value: unknown,
	keys: ReadonlyArray<string>
): Record<string, unknown> => {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
	) {
		throw new Error('Trusted backup migration manifest shape is invalid');
	}
	return value as Record<string, unknown>;
};

export const parseDatabaseBackupMigrationManifests = (
	value: unknown
): Readonly<
	Record<DatabaseBackupProvenanceTarget, DatabaseBackupMigrationManifest>
> => {
	const root = record(value, ['schemaVersion', 'targets']);
	if (root.schemaVersion !== 1) {
		throw new Error(
			'Trusted backup migration manifest version is invalid'
		);
	}
	const targets = record(root.targets, DATABASE_BACKUP_PROVENANCE_TARGETS);
	const manifests = {} as Record<
		DatabaseBackupProvenanceTarget,
		DatabaseBackupMigrationManifest
	>;
	for (const target of DATABASE_BACKUP_PROVENANCE_TARGETS) {
		const raw = record(targets[target], ['manifestSha256', 'migrations']);
		if (
			typeof raw.manifestSha256 !== 'string' ||
			!SHA256_PATTERN.test(raw.manifestSha256) ||
			!Array.isArray(raw.migrations) ||
			raw.migrations.length === 0 ||
			raw.migrations.length > 10_000
		) {
			throw new Error('Trusted backup migration manifest is invalid');
		}
		const migrations = raw.migrations.map(candidate => {
			const entry = record(candidate, ['name', 'checksum']);
			if (
				typeof entry.name !== 'string' ||
				entry.name.length > 255 ||
				!MIGRATION_NAME_PATTERN.test(entry.name) ||
				typeof entry.checksum !== 'string' ||
				!SHA256_PATTERN.test(entry.checksum)
			) {
				throw new Error(
					'Trusted backup migration manifest entry is invalid'
				);
			}
			return Object.freeze({ name: entry.name, checksum: entry.checksum });
		});
		const names = migrations.map(entry => entry.name);
		if (
			new Set(names).size !== names.length ||
			names.join(',') !== [...names].sort().join(',')
		) {
			throw new Error(
				'Trusted backup migration manifest is not canonical'
			);
		}
		const sha256 = createHash('sha256')
			.update(JSON.stringify({ schemaVersion: 1, target, migrations }))
			.digest('hex');
		if (sha256 !== raw.manifestSha256) {
			throw new Error(
				'Trusted backup migration manifest SHA-256 is invalid'
			);
		}
		manifests[target] = Object.freeze({
			target,
			manifestSha256: sha256,
			migrations: Object.freeze(migrations)
		});
	}
	return Object.freeze(manifests);
};

@Injectable()
export class DatabaseBackupMigrationManifestService {
	private readonly manifests: Readonly<
		Record<DatabaseBackupProvenanceTarget, DatabaseBackupMigrationManifest>
	>;

	constructor() {
		let value: unknown;
		try {
			value = JSON.parse(
				readFileSync(
					join(
						process.cwd(),
						'backup-manifests',
						'database-backup-migrations.json'
					),
					'utf8'
				)
			) as unknown;
		} catch {
			throw new Error(
				'Trusted database backup migration manifest is unavailable'
			);
		}
		this.manifests = parseDatabaseBackupMigrationManifests(value);
	}

	sha256(target: DatabaseBackupProvenanceTarget): string {
		if (!isDatabaseBackupProvenanceTarget(target)) {
			throw new Error(
				'Trusted backup migration manifest target is invalid'
			);
		}
		return this.manifests[target].manifestSha256;
	}
}
