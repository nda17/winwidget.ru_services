import { HttpException } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import {
	EXPORT_MAX_BYTES,
	exportActorHash,
	exportCheckpoint,
	ExportConcurrency,
	exportCsvCell,
	exportHeaders,
	exportItem,
	exportScope,
	exportScopeFingerprint,
	materializeExport,
	assertExportAuthority,
	type ExportAuthority,
	type ExportItem
} from './export-format';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const context: ExportAuthority = {
	workspaceId,
	subject: 'owner',
	role: 'OWNER',
	state: 'READ_ONLY',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['test:read', 'test:export']
};
const options = () => ({
	workspaceId,
	entity: 'contacts',
	format: 'json' as const,
	snapshotAt: '2026-09-05T00:00:00.000Z',
	columns: ['id', 'workspaceId', 'name'],
	started: 0,
	now: () => 0
});
const row = (n: number, name = 'name'): ExportItem => ({
	id: String(n).padStart(8, '0'),
	workspaceId,
	name
});
describe('bounded service-owned export encoding', () => {
	test.each([
		['=SUM(A1)', "'=SUM(A1)"],
		[' +7', "' +7"],
		['-1', "'-1"],
		['@test', "'@test"],
		['\tname', "'\tname"],
		['\nname', "'\nname"],
		['ok', 'ok'],
		['a\nb', 'a\nb']
	])('spreadsheet-safe %s', (input, expected) =>
		expect(exportCsvCell(input)).toBe('"' + expected + '"')
	);
	test('quotes, null and numbers', () => {
		expect(exportCsvCell('a"b')).toBe('"a""b"');
		expect(exportCsvCell(null)).toBe('""');
		expect(exportCsvCell(-2)).toBe('"-2"');
	});
	test('lossless JSON with multiline Unicode, explicit null and exact metadata', async () => {
		const rows = [row(1, '=Привет\n"😀"')];
		const output = await materializeExport({
			...options(),
			fetchPage: async () => rows
		});
		expect(JSON.parse(output.body.toString())).toEqual({
			schemaVersion: 1,
			workspaceId,
			entity: 'contacts',
			snapshotAt: options().snapshotAt,
			rowCount: 1,
			items: rows
		});
	});
	test('CSV has BOM, fully quoted ordered columns and trailing CRLF', async () => {
		const output = await materializeExport({
			...options(),
			format: 'csv',
			fetchPage: async () => [row(1, '=a\nb')]
		});
		expect(output.body.toString()).toBe(
			'\uFEFF"id","workspaceId","name"\r\n"00000001","' +
				workspaceId +
				'","\'=a\nb"\r\n'
		);
	});
	test('empty JSON and CSV are valid', async () => {
		const json = await materializeExport({
			...options(),
			fetchPage: async () => []
		});
		expect(JSON.parse(json.body.toString()).items).toEqual([]);
		const csv = await materializeExport({
			...options(),
			format: 'csv',
			fetchPage: async () => []
		});
		expect(csv.rowCount).toBe(0);
		expect(csv.body.toString()).toBe(
			'\uFEFF"id","workspaceId","name"\r\n'
		);
	});
	test('keyset 500 pages and exact 10000 rows accepted', async () => {
		const fetchPage = jest.fn(async (after: string | null, take: number) =>
			Array.from(
				{ length: Math.min(take, 10000 - Number(after || 0)) },
				(_, n) => row(Number(after || 0) + n + 1)
			)
		);
		const output = await materializeExport({ ...options(), fetchPage });
		expect(output.rowCount).toBe(10000);
		expect(fetchPage).toHaveBeenLastCalledWith('00010000', 1);
	});
	test('10001 rows fail without partial file', async () => {
		await expect(
			materializeExport({
				...options(),
				fetchPage: async (after, take) =>
					Array.from({ length: take }, (_, n) =>
						row(Number(after || 0) + n + 1)
					)
			})
		).rejects.toMatchObject({ status: 413 });
	});
	test.each(['json', 'csv'] as const)(
		'encoded byte cap accounts UTF8/escaping in %s',
		async format => {
			await expect(
				materializeExport({
					...options(),
					format,
					fetchPage: async () => [
						row(1, '😀'.repeat(EXPORT_MAX_BYTES / 4))
					]
				})
			).rejects.toMatchObject({ status: 413 });
		}
	);
	test('deadline after page and cancellation fail closed', async () => {
		let clock = 0;
		await expect(
			materializeExport({
				...options(),
				now: () => clock,
				fetchPage: async () => {
					clock = 5000;
					return [row(1)];
				}
			})
		).rejects.toMatchObject({ status: 503 });
		const abort = new AbortController();
		abort.abort();
		expect(() =>
			exportCheckpoint(performance.now(), abort.signal)
		).toThrow(HttpException);
	});
	test('cross workspace and stalled keyset rejected', async () => {
		await expect(
			materializeExport({
				...options(),
				fetchPage: async () => [{ ...row(1), workspaceId: 'foreign' }]
			})
		).rejects.toMatchObject({ status: 503 });
		await expect(
			materializeExport({
				...options(),
				fetchPage: async () =>
					Array.from({ length: 500 }, (_, n) => row(n + 1))
			})
		).rejects.toMatchObject({ status: 503 });
	});
	test('data projections reject undefined, objects and unsafe integers', () => {
		for (const value of [undefined, {}, Number.MAX_SAFE_INTEGER + 1])
			expect(() => exportItem({ name: value }, ['name'])).toThrow(
				HttpException
			);
		expect(
			exportItem(
				{ date: new Date('2026-09-05T00:00:00.000Z'), null: null },
				['date', 'null']
			)
		).toEqual({ date: '2026-09-05T00:00:00.000Z', null: null });
	});
	test('current owner export allowed in all readable states only', () => {
		for (const state of ['ACTIVE', 'GRACE', 'READ_ONLY'])
			expect(() =>
				assertExportAuthority({ ...context, state }, workspaceId, 'test')
			).not.toThrow();
		for (const invalid of [
			{ role: 'CRM_ADMIN' },
			{ state: 'SUSPENDED' },
			{ permissions: ['test:read'] },
			{ workspaceId: 'foreign' }
		])
			expect(() =>
				assertExportAuthority(
					{ ...context, ...invalid },
					workspaceId,
					'test'
				)
			).toThrow(HttpException);
	});
	test('fingerprint compares identity and scope, not entitlement phase', () => {
		expect(exportScopeFingerprint(context)).toBe(
			exportScopeFingerprint({ ...context, state: 'ACTIVE' })
		);
		expect(
			exportScopeFingerprint({ ...context, teamIds: ['b', 'a'] })
		).toBe(exportScopeFingerprint({ ...context, teamIds: ['a', 'b'] }));
		expect(exportScope({ ...context, dataScope: 'OWN' }, 'owner')).toEqual(
			{ workspaceId, owner: 'owner' }
		);
		expect(
			exportScope(
				{ ...context, dataScope: 'TEAM', teamIds: ['team'] },
				'owner'
			)
		).toEqual({
			workspaceId,
			OR: [{ owner: 'owner' }, { teamId: { in: ['team'] } }]
		});
	});
	test('bounded process concurrency and per-actor workspace guard released explicitly', () => {
		const gate = new ExportConcurrency();
		const releases = [gate.claim(context)];
		expect(() => gate.claim(context)).toThrow(HttpException);
		for (let n = 1; n < 4; n++)
			releases.push(gate.claim({ ...context, subject: String(n) }));
		expect(() => gate.claim({ ...context, subject: 'fifth' })).toThrow(
			HttpException
		);
		releases[0]();
		expect(() => gate.claim(context)).not.toThrow();
	});
	test('all response metadata and fixed attachment filenames', () => {
		const file = {
			workspaceId,
			entity: 'contacts',
			format: 'json' as const,
			snapshotAt: options().snapshotAt,
			rowCount: 0,
			actorHash: exportActorHash('юзер'),
			body: Buffer.from('😀')
		};
		const headers = exportHeaders(file);
		expect(headers['Content-Length']).toBe('4');
		expect(headers['X-WinCRM-Export-Bytes']).toBe('4');
		expect(headers['X-WinCRM-Export-Actor-SHA256']).toMatch(
			/^[a-f0-9]{64}$/
		);
		expect(headers['Content-Disposition']).toBe(
			'attachment; filename="wincrm-contacts.json"'
		);
		expect(headers['Cache-Control']).toBe('no-store');
		expect(headers['X-Content-Type-Options']).toBe('nosniff');
	});
});
