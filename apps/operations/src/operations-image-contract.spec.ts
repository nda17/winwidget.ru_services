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
});
