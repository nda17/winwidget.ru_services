import { performance } from 'node:perf_hooks';
import {
	SalesExportService,
	TASK_EXPORT_V2_COLUMNS,
	EXPORT_COLUMNS
} from './export.service';
import { exportHeaders, EXPORT_MAX_BYTES } from './export-format';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const teamId = '22222222-2222-4222-8222-222222222222';
const dealId = '33333333-3333-4333-8333-333333333333';
const membershipId = '44444444-4444-4444-8444-444444444444';
const date = new Date('2026-09-07T10:00:00.000Z');
const authority = {
	schemaVersion: 1,
	workspaceId,
	subject: 'owner',
	role: 'OWNER',
	state: 'READ_ONLY',
	dataScope: 'ALL',
	teamIds: [teamId],
	permissions: ['sales:read', 'sales:export']
};
function task(n: number, overrides = {}) {
	return {
		id: `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`,
		workspaceId,
		dealId: null,
		version: 1,
		title: '=Переговоры\n"😀"',
		dueAt: date,
		status: 'IN_PROGRESS',
		assignedToSubject: 'owner',
		assignedToMembershipId: membershipId,
		teamId,
		completedAt: null,
		createdAt: date,
		updatedAt: date,
		deal: null,
		...overrides
	};
}
function setup(
	rows = [
		task(1),
		task(2, {
			dealId,
			assignedToMembershipId: null,
			teamId: null,
			deal: { teamId }
		})
	]
) {
	const findMany = jest.fn().mockResolvedValue(rows);
	const tx = {
		$executeRawUnsafe: jest.fn(),
		$queryRaw: jest.fn().mockResolvedValue([{ snapshotAt: date }]),
		salesTask: { findMany },
		deal: { findMany: jest.fn().mockResolvedValue([]) }
	};
	const prisma = {
		$transaction: jest.fn(async fn => fn(tx)),
		exportAudit: { create: jest.fn() }
	};
	const authorize = jest.fn().mockResolvedValue(authority);
	return {
		tx,
		prisma,
		authorize,
		findMany,
		service: new SalesExportService(
			prisma as never,
			{ authorize } as never
		)
	};
}

describe('version 2 owner Workday task export', () => {
	it('exports standalone + linked current projection with explicit nulls and versioned metadata', async () => {
		const current = setup();
		const file = await current.service.prepareTasksV2(
			'Bearer user',
			workspaceId,
			'json'
		);
		const result = JSON.parse(file.body.toString());
		expect(result).toEqual({
			schemaVersion: 2,
			workspaceId,
			entity: 'tasks',
			snapshotAt: date.toISOString(),
			rowCount: 2,
			items: [
				{
					...task(1),
					deal: undefined,
					dueAt: date.toISOString(),
					createdAt: date.toISOString(),
					updatedAt: date.toISOString()
				},
				{
					...task(2),
					deal: undefined,
					dealId,
					assignedToMembershipId: null,
					dueAt: date.toISOString(),
					createdAt: date.toISOString(),
					updatedAt: date.toISOString()
				}
			].map(item =>
				Object.fromEntries(
					Object.entries(item).filter(([key]) => key !== 'deal')
				)
			)
		});
		expect(Object.keys(result.items[0])).toEqual([
			...TASK_EXPORT_V2_COLUMNS
		]);
		expect(exportHeaders(file)).toMatchObject({
			'X-WinCRM-Export-Schema': '2',
			'X-WinCRM-Export-Entity': 'tasks',
			'Content-Disposition': 'attachment; filename="wincrm-tasks-v2.json"',
			'Content-Length': String(file.body.byteLength),
			'Cache-Control': 'no-store'
		});
		expect(current.prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			{ isolationLevel: 'RepeatableRead', maxWait: 500, timeout: 4500 }
		);
		expect(current.tx.$executeRawUnsafe.mock.calls).toEqual([
			['SET TRANSACTION READ ONLY'],
			["SET LOCAL statement_timeout = '4000ms'"]
		]);
		expect(current.authorize).toHaveBeenCalledTimes(2);
		expect(current.prisma.exportAudit.create).toHaveBeenCalledWith({
			data: {
				workspaceId,
				actorSubject: 'owner',
				entity: 'tasks',
				format: 'json',
				rowCount: 2,
				byteCount: file.body.byteLength,
				snapshotAt: date
			}
		});
		expect(
			current.prisma.exportAudit.create.mock.invocationCallOrder[0]
		).toBeGreaterThan(current.authorize.mock.invocationCallOrder[1]);
	});
	it.each(['ALL', 'OWN', 'TEAM'])(
		'applies %s to standalone and the live parent independently, without period filters',
		async dataScope => {
			const current = setup([]);
			current.authorize.mockResolvedValue({ ...authority, dataScope });
			await current.service.prepareTasksV2(
				'Bearer user',
				workspaceId,
				'json'
			);
			const scope =
				dataScope === 'ALL'
					? {}
					: dataScope === 'OWN'
						? { assignedToSubject: 'owner' }
						: {
								OR: [
									{ assignedToSubject: 'owner' },
									{ teamId: { in: [teamId] } }
								]
							};
			expect(current.findMany.mock.calls[0][0]).toMatchObject({
				where: {
					AND: [
						{
							workspaceId,
							OR: [
								{ dealId: null, ...scope },
								{
									deal: {
										is: {
											AND: [
												{ workspaceId, ...scope },
												{ archivedAt: null }
											]
										}
									}
								}
							]
						}
					]
				},
				orderBy: { id: 'asc' },
				take: 500
			});
			expect(current.findMany.mock.calls[0][0].select).toEqual({
				...Object.fromEntries(
					TASK_EXPORT_V2_COLUMNS.map(key => [key, true])
				),
				deal: { select: { teamId: true } }
			});
			const { where } = current.findMany.mock.calls[0][0];
			expect(JSON.stringify(where)).not.toMatch(
				/dueAt|status|completedAt|search/
			);
		}
	);
	it('uses parent team rather than a stale task team, preserving a real null parent team', async () => {
		const current = setup([
			task(1, { dealId, teamId, deal: { teamId: null } })
		]);
		const file = await current.service.prepareTasksV2(
			'Bearer user',
			workspaceId,
			'json'
		);
		expect(JSON.parse(file.body.toString()).items[0].teamId).toBeNull();
	});
	it('keeps schema-1 deal-bound output, archived-parent selection and columns unchanged', async () => {
		const current = setup([task(1, { dealId })]);
		const file = await current.service.prepare(
			'Bearer user',
			workspaceId,
			'tasks',
			'json'
		);
		expect(JSON.parse(file.body.toString())).toMatchObject({
			schemaVersion: 1,
			items: [{ dealId }]
		});
		expect(Object.keys(JSON.parse(file.body.toString()).items[0])).toEqual(
			[...EXPORT_COLUMNS.tasks]
		);
		expect(current.findMany.mock.calls[0][0].where).toEqual({
			workspaceId,
			deal: { workspaceId }
		});
		expect(exportHeaders(file)).toMatchObject({
			'X-WinCRM-Export-Schema': '1',
			'Content-Disposition': 'attachment; filename="wincrm-tasks.json"'
		});
	});
	it.each(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])(
		'retains %s without converting status or requiring a deal',
		async status => {
			const completedAt = ['COMPLETED', 'CANCELLED'].includes(status)
				? date
				: null;
			const current = setup([
				task(1, {
					status,
					completedAt,
					teamId: null,
					assignedToMembershipId: null
				})
			]);
			const file = await current.service.prepareTasksV2(
				'Bearer user',
				workspaceId,
				'json'
			);
			expect(JSON.parse(file.body.toString()).items[0]).toMatchObject({
				status,
				dealId: null,
				completedAt: completedAt?.toISOString() ?? null,
				teamId: null,
				assignedToMembershipId: null
			});
		}
	);
	it('CSV is versioned, spreadsheet safe and preserves ordered nullable columns', async () => {
		const current = setup([task(1)]);
		const file = await current.service.prepareTasksV2(
			'Bearer user',
			workspaceId,
			'csv'
		);
		expect(file.body.toString()).toBe(
			'\uFEFF' +
				TASK_EXPORT_V2_COLUMNS.map(column => `"${column}"`).join(',') +
				'\r\n' +
				`"${task(1).id}","${workspaceId}","","1","'=Переговоры\n""😀""","${date.toISOString()}","IN_PROGRESS","owner","${membershipId}","${teamId}","","${date.toISOString()}","${date.toISOString()}"\r\n`
		);
		expect(exportHeaders(file)).toMatchObject({
			'X-WinCRM-Export-Schema': '2',
			'Content-Disposition': 'attachment; filename="wincrm-tasks-v2.csv"'
		});
	});
	it.each(['json', 'csv'] as const)(
		'exports an empty %s with the v2 header/columns',
		async format => {
			const current = setup([]);
			const file = await current.service.prepareTasksV2(
				'Bearer user',
				workspaceId,
				format
			);
			expect(file.rowCount).toBe(0);
			expect(exportHeaders(file)['X-WinCRM-Export-Schema']).toBe('2');
			if (format === 'json')
				expect(JSON.parse(file.body.toString())).toMatchObject({
					schemaVersion: 2,
					items: []
				});
			else
				expect(file.body.toString()).toBe(
					'\uFEFF' +
						TASK_EXPORT_V2_COLUMNS.map(column => `"${column}"`).join(',') +
						'\r\n'
				);
		}
	);
	it.each([
		{ role: 'CRM_ADMIN' },
		{ role: 'TEAM_LEAD' },
		{ role: 'MANAGER' },
		{ role: 'ANALYST' },
		{ state: 'SUSPENDED' },
		{ workspaceId: dealId },
		{ permissions: ['sales:read'] },
		{ permissions: ['sales:export'] }
	])(
		'denies non-owner/invalid authority before data reads: %j',
		async change => {
			const current = setup();
			current.authorize.mockResolvedValue({ ...authority, ...change });
			await expect(
				current.service.prepareTasksV2('Bearer user', workspaceId, 'json')
			).rejects.toMatchObject({ status: 403 });
			expect(current.prisma.$transaction).not.toHaveBeenCalled();
			expect(current.prisma.exportAudit.create).not.toHaveBeenCalled();
		}
	);
	it.each([
		{ subject: 'another' },
		{ role: 'CRM_ADMIN' },
		{ dataScope: 'OWN' },
		{ teamIds: [] },
		{ permissions: ['sales:read'] },
		{ workspaceId: dealId }
	])(
		'discards a prepared snapshot on fresh authority change: %j',
		async change => {
			const current = setup();
			current.authorize
				.mockResolvedValueOnce(authority)
				.mockResolvedValueOnce({ ...authority, ...change });
			await expect(
				current.service.prepareTasksV2('Bearer user', workspaceId, 'json')
			).rejects.toMatchObject({ status: 403 });
			expect(current.prisma.exportAudit.create).not.toHaveBeenCalled();
		}
	);
	it('allows ACTIVE→READ_ONLY, denies partial data/dependency/audit failures, releases guards', async () => {
		const current = setup();
		current.authorize
			.mockResolvedValueOnce({ ...authority, state: 'ACTIVE' })
			.mockResolvedValueOnce(authority);
		await expect(
			current.service.prepareTasksV2('Bearer user', workspaceId, 'json')
		).resolves.toHaveProperty('rowCount', 2);
		current.prisma.exportAudit.create.mockRejectedValueOnce(
			new Error('private-data')
		);
		await expect(
			current.service.prepareTasksV2('Bearer user', workspaceId, 'json')
		).rejects.toMatchObject({
			status: 503,
			response: {
				code: 'crm_export_unavailable',
				message: 'Export is temporarily unavailable'
			}
		});
		current.findMany.mockResolvedValueOnce([
			task(1, { workspaceId: dealId })
		]);
		await expect(
			current.service.prepareTasksV2('Bearer user', workspaceId, 'json')
		).rejects.toMatchObject({ status: 503 });
		current.findMany.mockRejectedValueOnce(new Error('private-ORM-data'));
		await expect(
			current.service.prepareTasksV2('Bearer user', workspaceId, 'json')
		).rejects.toMatchObject({ status: 503 });
		await expect(
			current.service.prepareTasksV2('Bearer user', workspaceId, 'json')
		).resolves.toHaveProperty('rowCount', 2);
	});
	it('shares the actor/workspace concurrency guard with v1 and frees it after completion', async () => {
		const current = setup();
		let finish!: () => void;
		const wait = new Promise<void>(resolve => {
			finish = resolve;
		});
		current.prisma.$transaction.mockImplementationOnce(async fn => {
			await wait;
			return fn(current.tx);
		});
		const first = current.service.prepareTasksV2(
			'Bearer user',
			workspaceId,
			'json'
		);
		await Promise.resolve();
		await Promise.resolve();
		await expect(
			current.service.prepare('Bearer user', workspaceId, 'deals', 'json')
		).rejects.toMatchObject({ status: 429 });
		await expect(
			current.service.prepareTasksV2('Bearer user', workspaceId, 'csv')
		).rejects.toMatchObject({ status: 429 });
		finish();
		await first;
		await expect(
			current.service.prepare('Bearer user', workspaceId, 'deals', 'json')
		).resolves.toHaveProperty('rowCount', 0);
	});
	it('uses keyset pages and rejects 10001 tasks without a partial file or audit', async () => {
		const current = setup();
		current.findMany.mockImplementation(async ({ where, take }) => {
			const after = Number(where.AND[1]?.id.gt.slice(0, 8) ?? 0);
			return Array.from({ length: take }, (_, index) =>
				task(after + index + 1)
			);
		});
		await expect(
			current.service.prepareTasksV2('Bearer user', workspaceId, 'json')
		).rejects.toMatchObject({ status: 413 });
		expect(current.findMany).toHaveBeenCalledTimes(21);
		expect(current.findMany.mock.calls[20][0]).toMatchObject({
			take: 1,
			where: { AND: [expect.any(Object), { id: { gt: task(10000).id } }] }
		});
		expect(current.prisma.exportAudit.create).not.toHaveBeenCalled();
	});
	it.each(['json', 'csv'] as const)(
		'retains the encoded byte cap for v2 %s',
		async format => {
			const current = setup([
				task(1, { title: '😀'.repeat(EXPORT_MAX_BYTES / 4) })
			]);
			await expect(
				current.service.prepareTasksV2('Bearer user', workspaceId, format)
			).rejects.toMatchObject({ status: 413 });
			expect(current.prisma.exportAudit.create).not.toHaveBeenCalled();
		}
	);
	it('keeps bounded deadline/cancellation checks on the v2 path', async () => {
		const current = setup();
		const spy = jest.spyOn(performance, 'now').mockReturnValue(0);
		try {
			current.findMany.mockImplementationOnce(async () => {
				spy.mockReturnValue(5000);
				return [task(1)];
			});
			await expect(
				current.service.prepareTasksV2('Bearer user', workspaceId, 'json')
			).rejects.toMatchObject({
				status: 503,
				response: { code: 'crm_export_timeout' }
			});
		} finally {
			spy.mockRestore();
		}
		const abort = new AbortController();
		abort.abort();
		await expect(
			current.service.prepareTasksV2(
				'Bearer user',
				workspaceId,
				'json',
				abort.signal
			)
		).rejects.toMatchObject({
			status: 503,
			response: { code: 'crm_export_cancelled' }
		});
		expect(current.prisma.exportAudit.create).not.toHaveBeenCalled();
	});
});
