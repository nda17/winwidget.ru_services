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
	backupRole: `winwidget_${schema}_backup`
});

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

	it('accepts the target schema under the existing TOC substring contract', () => {
		const operations = target('operations');

		expect(() =>
			service.assertTableOfContents(
				'1; 2615 1 SCHEMA - operations owner',
				operations,
				[operations, target('billing')]
			)
		).not.toThrow();
	});

	it('rejects a TOC without the target schema', () => {
		const operations = target('operations');

		expect(() =>
			service.assertTableOfContents(
				'1; 2615 1 SCHEMA - public owner',
				operations,
				[operations]
			)
		).toThrow('Restore dump does not contain the exact target schema');
	});

	it.each([
		'notification_delivery',
		'campaigns',
		'reporting',
		'widgets',
		'billing',
		'identity',
		'platform',
		'support'
	])('rejects the foreign %s service schema', schema => {
		const operations = target('operations');
		const foreign = target(schema);

		expect(() =>
			service.assertTableOfContents(
				`1; 2615 1 SCHEMA - operations owner\n2; 2615 2 SCHEMA - ${schema} owner`,
				operations,
				[operations, foreign]
			)
		).toThrow('Restore dump contains a foreign service schema');
	});
});
