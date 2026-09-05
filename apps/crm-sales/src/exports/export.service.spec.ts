import { ForbiddenException } from '@nestjs/common';
import { SalesExportService } from './export.service';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import { SalesAccessClient } from '../sales/sales-access';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const authority = {
	schemaVersion: 1,
	workspaceId,
	subject: 'owner',
	role: 'OWNER',
	state: 'READ_ONLY',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['sales:read', 'sales:export']
};
function setup() {
	const rows = [
		{
			id: '22222222-2222-4222-8222-222222222222',
			workspaceId: '11111111-1111-4111-8111-111111111111',
			version: 1,
			title: 'value',
			currency: 'value',
			amountMinor: 1,
			pipelineId: 'value',
			stageId: 'value',
			status: 'value',
			contactId: 'value',
			contactName: 'value',
			assignedToSubject: 'value',
			teamId: 'value',
			nextTaskId: 'value',
			archivedAt: null,
			createdAt: null,
			updatedAt: null,
			pipeline: {
				name: 'Pipeline',
				templateKey: 'sales',
				templateVersion: 1
			},
			stage: { name: 'Stage', key: 'new', position: 1 }
		}
	];
	const findMany = jest.fn().mockResolvedValue(rows);
	const tx = {
		$executeRawUnsafe: jest.fn(),
		$queryRaw: jest
			.fn()
			.mockResolvedValue([
				{ snapshotAt: new Date('2026-09-05T00:00:00.000Z') }
			]),
		deal: { findMany }
	};
	const audit = jest.fn().mockResolvedValue({});
	const prisma = {
		$transaction: jest.fn(async (fn: (value: typeof tx) => unknown) =>
			fn(tx)
		),
		exportAudit: { create: audit }
	};
	const authorize = jest.fn().mockResolvedValue(authority);
	return {
		tx,
		prisma,
		authorize,
		audit,
		findMany,
		service: new SalesExportService(
			prisma as unknown as CrmSalesPrismaService,
			{ authorize } as unknown as SalesAccessClient
		)
	};
}
describe('Sales export snapshot authorization', () => {
	test('READ_ONLY owner uses bounded read-only repeatable snapshot then fresh permission then audit', async () => {
		const { service, tx, prisma, authorize, audit, findMany } = setup();
		const file = await service.prepare(
			'Bearer user',
			workspaceId,
			'deals',
			'json'
		);
		expect(file.rowCount).toBe(1);
		expect(authorize).toHaveBeenCalledTimes(2);
		expect(tx.$executeRawUnsafe.mock.calls).toEqual([
			['SET TRANSACTION READ ONLY'],
			["SET LOCAL statement_timeout = '4000ms'"]
		]);
		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			{ isolationLevel: 'RepeatableRead', maxWait: 500, timeout: 4500 }
		);
		expect(findMany.mock.calls[0][0].where).toEqual({ workspaceId });
		expect(findMany.mock.calls[0][0].take).toBe(500);
		expect(audit).toHaveBeenCalledWith({
			data: expect.objectContaining({
				workspaceId,
				actorSubject: 'owner',
				entity: 'deals',
				format: 'json',
				rowCount: 1,
				byteCount: file.body.byteLength
			})
		});
		expect(audit.mock.invocationCallOrder[0]).toBeGreaterThan(
			authorize.mock.invocationCallOrder[1]
		);
		expect(Object.keys(audit.mock.calls[0][0].data).sort()).toEqual(
			[
				'actorSubject',
				'byteCount',
				'entity',
				'format',
				'rowCount',
				'snapshotAt',
				'workspaceId'
			].sort()
		);
	});
	test.each([
		{ role: 'MANAGER' },
		{ state: 'SUSPENDED' },
		{ permissions: ['sales:read'] }
	])('initial denial never reads or audits %p', async change => {
		const { service, authorize, prisma, audit } = setup();
		authorize.mockResolvedValue({ ...authority, ...change });
		await expect(
			service.prepare('Bearer user', workspaceId, 'deals', 'json')
		).rejects.toMatchObject({ status: 403 });
		expect(prisma.$transaction).not.toHaveBeenCalled();
		expect(audit).not.toHaveBeenCalled();
	});
	test.each([
		{ role: 'CRM_ADMIN' },
		{ subject: 'another' },
		{ dataScope: 'TEAM', teamIds: ['team'] },
		{ permissions: ['sales:read'] }
	])(
		'fresh scope/revocation fails without file or audit %p',
		async change => {
			const { service, authorize, audit } = setup();
			authorize
				.mockResolvedValueOnce(authority)
				.mockResolvedValueOnce({ ...authority, ...change });
			await expect(
				service.prepare('Bearer user', workspaceId, 'deals', 'json')
			).rejects.toMatchObject({ status: 403 });
			expect(audit).not.toHaveBeenCalled();
		}
	);
	test('ACTIVE to READ_ONLY is valid without privilege expansion', async () => {
		const { service, authorize } = setup();
		authorize
			.mockResolvedValueOnce({ ...authority, state: 'ACTIVE' })
			.mockResolvedValueOnce(authority);
		await expect(
			service.prepare('Bearer user', workspaceId, 'deals', 'json')
		).resolves.toHaveProperty('rowCount', 1);
	});
	test('dependency and audit failures are safe and release actor guard', async () => {
		const { service, audit } = setup();
		audit.mockRejectedValueOnce(new Error('sensitive-ORM-row-value'));
		await expect(
			service.prepare('Bearer user', workspaceId, 'deals', 'json')
		).rejects.toMatchObject({
			status: 503,
			response: {
				code: 'crm_export_unavailable',
				message: 'Export is temporarily unavailable'
			}
		});
		await expect(
			service.prepare('Bearer user', workspaceId, 'deals', 'json')
		).resolves.toHaveProperty('rowCount', 1);
	});
	test('reauthorization failure never audits and cancellation is closed', async () => {
		const { service, authorize, audit } = setup();
		authorize
			.mockResolvedValueOnce(authority)
			.mockRejectedValueOnce(new ForbiddenException());
		await expect(
			service.prepare('Bearer user', workspaceId, 'deals', 'json')
		).rejects.toMatchObject({ status: 403 });
		expect(audit).not.toHaveBeenCalled();
		authorize.mockResolvedValue(authority);
		const signal = new AbortController();
		signal.abort();
		await expect(
			service.prepare(
				'Bearer user',
				workspaceId,
				'deals',
				'json',
				signal.signal
			)
		).rejects.toMatchObject({ status: 503 });
	});
	test('single actor concurrent requests rejected before second materialization', async () => {
		const { service, prisma, tx } = setup();
		let finish!: () => void;
		const wait = new Promise<void>(resolve => {
			finish = resolve;
		});
		prisma.$transaction.mockImplementationOnce(async fn => {
			await wait;
			return fn(tx);
		});
		const first = service.prepare(
			'Bearer user',
			workspaceId,
			'deals',
			'json'
		);
		await Promise.resolve();
		await Promise.resolve();
		await expect(
			service.prepare('Bearer user', workspaceId, 'deals', 'json')
		).rejects.toMatchObject({ status: 429 });
		finish();
		await first;
	});
});
