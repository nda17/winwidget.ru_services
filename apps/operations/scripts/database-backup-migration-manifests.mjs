import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectTarget } from './database-restore-migration-manifests.mjs';

// An independent signing registry, not the destructive restore allowlist.
export const TARGETS = [
	'notification-delivery',
	'campaigns',
	'reporting',
	'widgets',
	'identity',
	'platform',
	'support',
	'crm-access',
	'crm-intake',
	'crm-customers',
	'crm-sales'
];
const OUTPUT_PATH = join(
	dirname(dirname(fileURLToPath(import.meta.url))),
	'backup-manifests',
	'database-backup-migrations.json'
);

export const generate = async () => {
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
			'Usage: node database-backup-migration-manifests.mjs [--check|--write]'
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
			`Backup migration manifest is missing; run ${process.argv[1]} --write`
		);
	}
	if (current !== output) {
		throw new Error(
			`Backup migration manifest drift detected; run ${process.argv[1]} --write and commit the result`
		);
	}
};

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
	await run();
}
