import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('Identity initial migration', () => {
	it('contains the ownership and non-null invariants required by migrate deploy', async () => {
		const migration = await readFile(
			join(
				process.cwd(),
				'prisma/migrations/20260814000000_init_identity/migration.sql'
			),
			'utf8'
		);
		expect(migration).toMatch(
			/"database_id" UUID NOT NULL DEFAULT gen_random_uuid\(\)/
		);
		expect(migration).toMatch(
			/"rights" "identity"\."Role"\[\] NOT NULL DEFAULT ARRAY\['USER'\]::"identity"\."Role"\[\]/
		);
		expect(migration).toMatch(
			/INSERT INTO "identity"\."service_identity"[^;]+gen_random_uuid\(\)/s
		);
		expect(migration).toContain('CHECK (CARDINALITY("rights") > 0)');
	});
});
