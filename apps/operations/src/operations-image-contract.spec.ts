import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Operations runtime image contract', () => {
	it('pins PostgreSQL client major 18 and fails the image build on drift', () => {
		const dockerfile = readFileSync(
			join(__dirname, '..', 'Dockerfile'),
			'utf8'
		);

		expect(dockerfile).toContain('postgresql-client-18');
		expect(dockerfile).toContain(
			"pg_dump --version | grep -E '^pg_dump \\(PostgreSQL\\) 18\\.'"
		);
		expect(dockerfile).toContain(
			"pg_restore --version | grep -E '^pg_restore \\(PostgreSQL\\) 18\\.'"
		);
		expect(dockerfile).not.toMatch(/install[^\n]+\bpostgresql-client\s/);
		expect(dockerfile).toContain('EXPOSE 5200 5201 5202 5203');
	});

	it('ships the fail-closed signed artifact rehearsal entrypoint', () => {
		const packageJson = JSON.parse(
			readFileSync(join(__dirname, '..', 'package.json'), 'utf8')
		) as { scripts?: Record<string, string> };
		const rehearsal = readFileSync(
			join(__dirname, 'restore', 'database-restore-artifact-rehearsal.ts'),
			'utf8'
		);

		expect(packageJson.scripts?.['rehearsal:restore-artifacts']).toBe(
			'node dist/src/restore/database-restore-artifact-rehearsal.js'
		);
		for (const boundary of [
			'OPERATIONS_RESTORE_ARTIFACT_REHEARSAL_ALLOW_MUTATION',
			'DATABASE_RESTORE_ENABLED',
			'assertNoTargetConfigurationEnvironment',
			'assertCleanFixtureState',
			'assertReadOnlyArtifact',
			'COPYFILE_EXCL',
			'Normal restore checkpoint sequence is invalid',
			'Recovery checkpoint sequence is invalid',
			'normalSafetyBackupSha256: normal.safetyBackupSha256',
			'artifactSha256 !== expectedArtifactSha256',
			'Artifact rehearsal cleanup failed',
			"status: 'SUCCEEDED'"
		]) {
			expect(rehearsal).toContain(boundary);
		}
		expect(rehearsal).toMatch(
			/recoveryActions\.push\(\{\s*action,\s*phases,\s*artifactSha256,\s*writerFenceReleaseEvidenceSha256\s*\}\)/
		);
		expect(rehearsal).toContain(
			"[...postgresArgs(environment, database, user), '--file=-']"
		);
		expect(rehearsal).not.toMatch(
			/cleanupTargets\([^)]*\)\.catch\(\(\) => undefined\)/
		);
	});
});
