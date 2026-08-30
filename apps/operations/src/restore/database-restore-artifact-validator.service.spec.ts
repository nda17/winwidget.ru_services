import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseRestoreArtifactValidatorService } from './database-restore-artifact-validator.service';
import { DatabaseRestoreTargetConfiguration } from './database-restore-target-registry.service';

const target = (schema: string): DatabaseRestoreTargetConfiguration => ({
	environmentPrefix: schema.toUpperCase(),
	database: `winwidget_${schema}`,
	schema,
	adminRole: `winwidget_${schema}_admin`,
	migrationRole: `winwidget_${schema}_migration`,
	runtimeRole: `winwidget_${schema}_runtime`,
	backupRole: `winwidget_${schema}_backup`,
	acl: { profile: 'standard', routines: [], runtimeRoutines: [] }
});

const SERVICE_SCHEMAS = [
	'notification_delivery',
	'campaigns',
	'reporting',
	'widgets',
	'billing',
	'identity',
	'platform',
	'support',
	'operations'
] as const;

const schemaEntry = (
	schema: string,
	dumpId = 3,
	owner = `winwidget_${schema}_migration`
) => `${dumpId}; 2615 ${2_200 + dumpId} SCHEMA - ${schema} ${owner}`;

describe('DatabaseRestoreArtifactValidatorService', () => {
	const service = new DatabaseRestoreArtifactValidatorService();

	it('streams the exact SHA-256 digest', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'restore-artifact-'));
		const path = join(directory, 'source.dump');
		await writeFile(path, 'PGDMP-test');

		try {
			await expect(service.sha256(path)).resolves.toBe(
				'acc71b523708336f2b77c1bd7bdd930cb4417607f8285cb7fce77d038d7816dc'
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('accepts an exact checksum and rejects a mismatch with the stable error', () => {
		expect(() => service.assertChecksum('same', 'same')).not.toThrow();
		expect(() => service.assertChecksum('actual', 'expected')).toThrow(
			'Restore dump checksum mismatch'
		);
	});

	it.each(SERVICE_SCHEMAS)(
		'accepts the single exact %s schema entry in a PostgreSQL 18 TOC',
		schema => {
			const tableOfContents = [
				'; Archive created at 2026-08-30 12:00:00 UTC',
				';     dbname: winwidget',
				schemaEntry(schema),
				`4; 1259 3000 TABLE ${schema} jobs owner`,
				`5; 0 0 COMMENT - SCHEMA ${schema} owner`,
				`6; 0 0 ACL ${schema} TABLE jobs owner`
			].join('\r\n');

			expect(() =>
				service.assertTableOfContents(tableOfContents, target(schema))
			).not.toThrow();
		}
	);

	it.each([
		'4; 1259 3000 TABLE public operations owner',
		'5; 0 0 COMMENT - SCHEMA operations owner',
		'; 3; 2615 2203 SCHEMA - operations owner',
		'; PostgreSQL database dump complete'
	])(
		'rejects a TOC where the target appears only outside an active SCHEMA entry',
		line => {
			expect(() =>
				service.assertTableOfContents(line, target('operations'))
			).toThrow('Restore dump does not contain the exact target schema');
		}
	);

	it('rejects a schema whose name only extends the target identifier', () => {
		expect(() =>
			service.assertTableOfContents(
				schemaEntry('operations_shadow'),
				target('operations')
			)
		).toThrow('Restore dump does not contain the exact target schema');
	});

	it.each([
		'3; 2615 2203 SCHEMA - operations shadow winwidget_operations_migration',
		'3; 2615 2203 SCHEMA - "operations" winwidget_operations_migration',
		schemaEntry('operations', 3, 'unexpected_owner')
	])(
		'rejects an ambiguous schema name or unexpected owner fail-closed',
		line => {
			expect(() =>
				service.assertTableOfContents(line, target('operations'))
			).toThrow('Restore dump does not contain the exact target schema');
		}
	);

	it.each(SERVICE_SCHEMAS.filter(schema => schema !== 'operations'))(
		'rejects the exact target together with the known foreign %s schema',
		schema => {
			expect(() =>
				service.assertTableOfContents(
					`${schemaEntry('operations')}\n${schemaEntry(schema, 4)}`,
					target('operations')
				)
			).toThrow(
				'Restore dump must contain only the target service schema'
			);
		}
	);

	it.each(['rogue', 'public'])(
		'rejects the target together with the unknown or non-service %s schema',
		schema => {
			expect(() =>
				service.assertTableOfContents(
					`${schemaEntry('operations')}\n${schemaEntry(schema, 4)}`,
					target('operations')
				)
			).toThrow(
				'Restore dump must contain only the target service schema'
			);
		}
	);

	it('rejects duplicate target schema entries', () => {
		expect(() =>
			service.assertTableOfContents(
				`${schemaEntry('operations')}\n${schemaEntry('operations', 4)}`,
				target('operations')
			)
		).toThrow('Restore dump must contain only the target service schema');
	});

	it('rejects a malformed active schema entry fail-closed', () => {
		expect(() =>
			service.assertTableOfContents(
				'3; 2615 2203 SCHEMA operations winwidget_operations_migration',
				target('operations')
			)
		).toThrow('Restore dump schema TOC entry is invalid');
	});
});
