import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	DATABASE_RESTORE_SHA256_PATTERN,
	DATABASE_RESTORE_TARGETS,
	DatabaseRestoreTarget
} from './database-restore.contract';

const MIGRATION_NAME_PATTERN = /^[0-9]{14}_[a-z0-9_]+$/;
const PRISMA_MIGRATION_COLUMNS = [
	'id',
	'checksum',
	'finished_at',
	'migration_name',
	'logs',
	'rolled_back_at',
	'started_at',
	'applied_steps_count'
] as const;

export interface DatabaseRestoreMigrationManifestEntry {
	name: string;
	checksum: string;
}

export interface DatabaseRestoreTargetMigrationManifest {
	target: DatabaseRestoreTarget;
	manifestSha256: string;
	migrations: ReadonlyArray<DatabaseRestoreMigrationManifestEntry>;
}

interface MigrationLedgerRow {
	migrationName: string;
	checksum: string;
	finished: boolean;
	rolledBack: boolean;
	appliedStepsCount: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const assertExactKeys = (
	value: Record<string, unknown>,
	expected: ReadonlyArray<string>,
	label: string
): void => {
	if (
		Object.keys(value).sort().join(',') !== [...expected].sort().join(',')
	) {
		throw new Error(`${label} has an invalid shape`);
	}
};

const manifestSha256 = (
	target: DatabaseRestoreTarget,
	migrations: ReadonlyArray<DatabaseRestoreMigrationManifestEntry>
): string =>
	createHash('sha256')
		.update(JSON.stringify({ schemaVersion: 1, target, migrations }))
		.digest('hex');

export const parseDatabaseRestoreMigrationManifests = (
	value: unknown
): Readonly<
	Record<DatabaseRestoreTarget, DatabaseRestoreTargetMigrationManifest>
> => {
	if (!isRecord(value))
		throw new Error('Trusted migration manifest is invalid');
	assertExactKeys(
		value,
		['schemaVersion', 'targets'],
		'Migration manifest root'
	);
	if (value.schemaVersion !== 1 || !isRecord(value.targets)) {
		throw new Error('Trusted migration manifest version is invalid');
	}
	assertExactKeys(
		value.targets,
		DATABASE_RESTORE_TARGETS,
		'Migration manifest targets'
	);
	const manifests = {} as Record<
		DatabaseRestoreTarget,
		DatabaseRestoreTargetMigrationManifest
	>;
	for (const target of DATABASE_RESTORE_TARGETS) {
		const raw = value.targets[target];
		if (!isRecord(raw)) {
			throw new Error(
				`Trusted migration manifest for ${target} is invalid`
			);
		}
		assertExactKeys(
			raw,
			['manifestSha256', 'migrations'],
			`Migration manifest for ${target}`
		);
		if (
			typeof raw.manifestSha256 !== 'string' ||
			!DATABASE_RESTORE_SHA256_PATTERN.test(raw.manifestSha256) ||
			!Array.isArray(raw.migrations) ||
			raw.migrations.length === 0
		) {
			throw new Error(
				`Trusted migration manifest for ${target} is invalid`
			);
		}
		const migrations = raw.migrations.map((candidate, index) => {
			if (!isRecord(candidate)) {
				throw new Error(
					`Migration manifest entry ${target}[${index}] is invalid`
				);
			}
			assertExactKeys(
				candidate,
				['name', 'checksum'],
				`Migration manifest entry ${target}[${index}]`
			);
			if (
				typeof candidate.name !== 'string' ||
				!MIGRATION_NAME_PATTERN.test(candidate.name) ||
				typeof candidate.checksum !== 'string' ||
				!DATABASE_RESTORE_SHA256_PATTERN.test(candidate.checksum)
			) {
				throw new Error(
					`Migration manifest entry ${target}[${index}] is invalid`
				);
			}
			return {
				name: candidate.name,
				checksum: candidate.checksum
			};
		});
		const names = migrations.map(migration => migration.name);
		if (
			new Set(names).size !== names.length ||
			names.join(',') !== [...names].sort().join(',')
		) {
			throw new Error(`Migration manifest for ${target} is not canonical`);
		}
		if (manifestSha256(target, migrations) !== raw.manifestSha256) {
			throw new Error(
				`Migration manifest SHA-256 for ${target} is invalid`
			);
		}
		manifests[target] = Object.freeze({
			target,
			manifestSha256: raw.manifestSha256,
			migrations: Object.freeze(migrations)
		});
	}
	return Object.freeze(manifests);
};

@Injectable()
export class DatabaseRestoreMigrationManifestService {
	private readonly manifests: Readonly<
		Record<DatabaseRestoreTarget, DatabaseRestoreTargetMigrationManifest>
	>;

	constructor() {
		const path = join(
			process.cwd(),
			'restore-manifests',
			'database-restore-migrations.json'
		);
		let value: unknown;
		try {
			value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
		} catch {
			throw new Error(
				'Trusted database restore migration manifest is unavailable'
			);
		}
		this.manifests = parseDatabaseRestoreMigrationManifests(value);
	}

	get(
		target: DatabaseRestoreTarget
	): DatabaseRestoreTargetMigrationManifest {
		return this.manifests[target];
	}

	sha256(target: DatabaseRestoreTarget): string {
		return this.get(target).manifestSha256;
	}

	assertBinding(target: DatabaseRestoreTarget, value: string): void {
		if (value !== this.sha256(target)) {
			throw new Error(
				`Migration manifest binding for ${target} does not match this Operations revision`
			);
		}
	}

	assertDumpLedger(
		target: DatabaseRestoreTarget,
		schema: string,
		output: string
	): void {
		this.assertLedger(target, this.parseDumpLedger(schema, output));
	}

	assertDatabaseLedger(
		target: DatabaseRestoreTarget,
		output: string
	): void {
		let value: unknown;
		try {
			value = JSON.parse(output.trim()) as unknown;
		} catch {
			throw new Error(
				`Restored migration ledger for ${target} is invalid`
			);
		}
		if (!Array.isArray(value)) {
			throw new Error(
				`Restored migration ledger for ${target} is invalid`
			);
		}
		const rows = value.map((candidate, index) => {
			if (!isRecord(candidate)) {
				throw new Error(
					`Restored migration ledger row ${target}[${index}] is invalid`
				);
			}
			assertExactKeys(
				candidate,
				[
					'migrationName',
					'checksum',
					'finished',
					'rolledBack',
					'appliedStepsCount'
				],
				`Restored migration ledger row ${target}[${index}]`
			);
			if (
				typeof candidate.migrationName !== 'string' ||
				typeof candidate.checksum !== 'string' ||
				typeof candidate.finished !== 'boolean' ||
				typeof candidate.rolledBack !== 'boolean' ||
				typeof candidate.appliedStepsCount !== 'number' ||
				!Number.isSafeInteger(candidate.appliedStepsCount)
			) {
				throw new Error(
					`Restored migration ledger row ${target}[${index}] is invalid`
				);
			}
			return {
				migrationName: candidate.migrationName,
				checksum: candidate.checksum,
				finished: candidate.finished,
				rolledBack: candidate.rolledBack,
				appliedStepsCount: candidate.appliedStepsCount
			};
		});
		this.assertLedger(target, rows);
	}

	private parseDumpLedger(
		schema: string,
		output: string
	): MigrationLedgerRow[] {
		const lines = output.replace(/\r\n/g, '\n').split('\n');
		const matches: Array<{ index: number; columns: string[] }> = [];
		for (let index = 0; index < lines.length; index += 1) {
			const header = this.parseCopyHeader(lines[index], schema);
			if (header) matches.push({ index, columns: header });
		}
		if (matches.length !== 1) {
			throw new Error(
				`Source dump must contain exactly one ${schema}._prisma_migrations COPY block`
			);
		}
		const [{ index: headerIndex, columns }] = matches;
		if (
			columns.length !== PRISMA_MIGRATION_COLUMNS.length ||
			[...columns].sort().join(',') !==
				[...PRISMA_MIGRATION_COLUMNS].sort().join(',')
		) {
			throw new Error(
				'Source dump Prisma migration ledger columns are invalid'
			);
		}
		const column = (name: (typeof PRISMA_MIGRATION_COLUMNS)[number]) =>
			columns.indexOf(name);
		const rows: MigrationLedgerRow[] = [];
		let terminated = false;
		for (let index = headerIndex + 1; index < lines.length; index += 1) {
			const line = lines[index];
			if (line === '\\.') {
				terminated = true;
				break;
			}
			const fields = line.split('\t');
			if (fields.length !== columns.length) {
				throw new Error(
					'Source dump Prisma migration ledger row is invalid'
				);
			}
			const finished = fields[column('finished_at')] !== '\\N';
			const rolledBack = fields[column('rolled_back_at')] !== '\\N';
			const appliedStepsCount = Number(
				fields[column('applied_steps_count')]
			);
			if (!Number.isSafeInteger(appliedStepsCount)) {
				throw new Error(
					'Source dump Prisma migration ledger row is invalid'
				);
			}
			rows.push({
				migrationName: fields[column('migration_name')],
				checksum: fields[column('checksum')],
				finished,
				rolledBack,
				appliedStepsCount
			});
		}
		if (!terminated) {
			throw new Error(
				'Source dump Prisma migration ledger COPY block is incomplete'
			);
		}
		return rows;
	}

	private parseCopyHeader(line: string, schema: string): string[] | null {
		const prefix = 'COPY ';
		const columnsStart = line.indexOf(' (');
		const suffix = ') FROM stdin;';
		if (
			!line.startsWith(prefix) ||
			columnsStart < prefix.length ||
			!line.endsWith(suffix)
		) {
			return null;
		}
		const relation = line.slice(prefix.length, columnsStart);
		const identifiers = relation
			.split('.')
			.map(value =>
				value.startsWith('"') && value.endsWith('"')
					? value.slice(1, -1).replace(/""/g, '"')
					: value
			);
		if (
			identifiers.length !== 2 ||
			identifiers[0] !== schema ||
			identifiers[1] !== '_prisma_migrations'
		) {
			return null;
		}
		return line
			.slice(columnsStart + 2, -suffix.length)
			.split(',')
			.map(value => value.trim().replace(/^"|"$/g, ''));
	}

	private assertLedger(
		target: DatabaseRestoreTarget,
		rows: ReadonlyArray<MigrationLedgerRow>
	): void {
		const successful = new Map<string, string>();
		for (const row of rows) {
			if (
				!MIGRATION_NAME_PATTERN.test(row.migrationName) ||
				!DATABASE_RESTORE_SHA256_PATTERN.test(row.checksum) ||
				row.appliedStepsCount < 0 ||
				(row.finished && row.rolledBack)
			) {
				throw new Error(`Migration ledger for ${target} is inconsistent`);
			}
			if (row.rolledBack) continue;
			if (!row.finished || row.appliedStepsCount < 1) {
				throw new Error(
					`Migration ledger for ${target} has an unresolved row`
				);
			}
			if (successful.has(row.migrationName)) {
				throw new Error(
					`Migration ledger for ${target} has duplicate successful migrations`
				);
			}
			successful.set(row.migrationName, row.checksum);
		}
		const expected = this.get(target).migrations;
		if (successful.size !== expected.length) {
			throw new Error(
				`Migration ledger for ${target} does not match the trusted manifest`
			);
		}
		for (const migration of expected) {
			if (successful.get(migration.name) !== migration.checksum) {
				throw new Error(
					`Migration ledger for ${target} does not match the trusted manifest`
				);
			}
		}
	}
}
