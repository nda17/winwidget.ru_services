import { createHash } from 'node:crypto';
import {
	lstat,
	mkdir,
	readFile,
	readdir,
	writeFile
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGETS = [
	'notification-delivery',
	'campaigns',
	'reporting',
	'widgets',
	'identity',
	'platform',
	'support'
];
const MIGRATION_NAME_PATTERN = /^[0-9]{14}_[a-z0-9_]+$/;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const OPERATIONS_DIRECTORY = dirname(SCRIPT_DIRECTORY);
const APPS_DIRECTORY = dirname(OPERATIONS_DIRECTORY);
const OUTPUT_PATH = join(
	OPERATIONS_DIRECTORY,
	'restore-manifests',
	'database-restore-migrations.json'
);

const sha256 = value => createHash('sha256').update(value).digest('hex');

const exactKeys = (value, expected, label) => {
	const actual = Object.keys(value).sort().join(',');
	if (actual !== [...expected].sort().join(',')) {
		throw new Error(`${label} has unexpected keys: ${actual}`);
	}
};

const collectTarget = async target => {
	const migrationsDirectory = join(
		APPS_DIRECTORY,
		target,
		'prisma',
		'migrations'
	);
	const directoryMetadata = await lstat(migrationsDirectory);
	if (
		!directoryMetadata.isDirectory() ||
		directoryMetadata.isSymbolicLink()
	) {
		throw new Error(
			`${target} migrations path is not a trusted directory`
		);
	}
	const entries = await readdir(migrationsDirectory, {
		withFileTypes: true
	});
	const migrationNames = entries
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.sort();
	if (migrationNames.length === 0) {
		throw new Error(`${target} has no Prisma migrations`);
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) {
			throw new Error(`${target} migrations contain a symbolic link`);
		}
		if (
			!entry.isDirectory() &&
			!(entry.isFile() && entry.name === 'migration_lock.toml')
		) {
			throw new Error(
				`${target} migrations contain an unexpected non-directory entry`
			);
		}
	}
	const migrations = [];
	for (const name of migrationNames) {
		if (!MIGRATION_NAME_PATTERN.test(name)) {
			throw new Error(`${target} has an unsafe migration name: ${name}`);
		}
		const path = join(migrationsDirectory, name, 'migration.sql');
		const metadata = await lstat(path);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new Error(
				`${target}/${name}/migration.sql is not a trusted file`
			);
		}
		migrations.push({
			name,
			checksum: sha256(await readFile(path))
		});
	}
	const canonical = {
		schemaVersion: 1,
		target,
		migrations
	};
	return {
		manifestSha256: sha256(JSON.stringify(canonical)),
		migrations
	};
};

const generate = async () => {
	const targets = {};
	for (const target of TARGETS)
		targets[target] = await collectTarget(target);
	return `${JSON.stringify({ schemaVersion: 1, targets }, null, '\t')}\n`;
};

const run = async () => {
	const args = process.argv.slice(2);
	if (
		args.length > 1 ||
		(args[0] && !['--check', '--write'].includes(args[0]))
	) {
		throw new Error(
			'Usage: node database-restore-migration-manifests.mjs [--check|--write]'
		);
	}
	const output = await generate();
	if (args[0] === '--write') {
		await mkdir(dirname(OUTPUT_PATH), { recursive: true });
		await writeFile(OUTPUT_PATH, output, {
			encoding: 'utf8',
			mode: 0o644
		});
		return;
	}
	let current;
	try {
		current = await readFile(OUTPUT_PATH, 'utf8');
	} catch {
		throw new Error(
			`Migration manifest is missing; run ${process.argv[1]} --write`
		);
	}
	if (current !== output) {
		throw new Error(
			`Migration manifest drift detected; run ${process.argv[1]} --write and commit the result`
		);
	}
	const parsed = JSON.parse(current);
	exactKeys(
		parsed,
		['schemaVersion', 'targets'],
		'Migration manifest root'
	);
};

await run();
