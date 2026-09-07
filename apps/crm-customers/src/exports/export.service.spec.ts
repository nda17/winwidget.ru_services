import { ForbiddenException } from '@nestjs/common';
import {
	COMPANY_EXPORT_V2_COLUMNS,
	CustomersExportService,
	EXPORT_COLUMNS
} from './export.service';
import { exportHeaders } from './export-format';
import { CrmCustomersPrismaService } from '../prisma/crm-customers-prisma.service';
import { CustomersAuthorizationClient } from '../access/customers-authorization.client';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const authority = {
	schemaVersion: 1,
	workspaceId,
	subject: 'owner',
	role: 'OWNER',
	state: 'READ_ONLY',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['customers:read', 'customers:export']
};
function setup() {
	const rows = [
		{
			id: '22222222-2222-4222-8222-222222222222',
			workspaceId: '11111111-1111-4111-8111-111111111111',
			name: 'value',
			notes: 'value',
			createdBySubject: 'value',
			teamId: 'value',
			version: 1,
			archivedAt: null,
			createdAt: null,
			updatedAt: null,
			phone: 'value',
			email: 'value',
			companyId: 'value'
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
		contact: { findMany },
		company: { findMany: jest.fn().mockResolvedValue([]) }
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
		service: new CustomersExportService(
			prisma as unknown as CrmCustomersPrismaService,
			{ authorize } as unknown as CustomersAuthorizationClient
		)
	};
}
describe('Customers export snapshot authorization', () => {
	test.each(['json', 'csv'] as const)(
		'v2 companies include all requisites in the same bounded %s snapshot',
		async format => {
			const { service, tx, authorize, audit } = setup();
			const row = Object.fromEntries(
				COMPANY_EXPORT_V2_COLUMNS.map(key => [key, null])
			);
			Object.assign(row, {
				id: '22222222-2222-4222-8222-222222222222',
				workspaceId,
				name: 'Тестовая компания',
				version: 1,
				createdBySubject: 'owner',
				inn: '7707083893',
				legalName: 'Полное название',
				kpp: '773601001',
				ogrn: '1027700132195',
				legalAddress: '=Тестовый адрес',
				entityType: 'LEGAL'
			});
			tx.company.findMany.mockResolvedValue([row]);
			const file = await service.prepare(
				'Bearer user',
				workspaceId,
				'companies',
				format,
				undefined,
				2
			);
			expect(file.schemaVersion).toBe(2);
			expect(exportHeaders(file)['X-WinCRM-Export-Schema']).toBe('2');
			expect(authorize).toHaveBeenCalledTimes(2);
			expect(audit).toHaveBeenCalledTimes(1);
			expect(
				Object.keys(tx.company.findMany.mock.calls[0][0].select)
			).toEqual(COMPANY_EXPORT_V2_COLUMNS);
			if (format === 'json')
				expect(JSON.parse(file.body.toString())).toMatchObject({
					schemaVersion: 2,
					rowCount: 1,
					items: [row]
				});
			else {
				expect(file.body.toString()).toContain(
					'"legalName","kpp","ogrn","legalAddress","entityType"'
				);
				expect(file.body.toString()).toContain('"\'=Тестовый адрес"');
			}
		}
	);
	test('legacy company export keeps v1 fields and headers after schema expansion', async () => {
		const { service, tx } = setup();
		const file = await service.prepare(
			'Bearer user',
			workspaceId,
			'companies',
			'json'
		);
		expect(file.schemaVersion).toBeUndefined();
		expect(exportHeaders(file)['X-WinCRM-Export-Schema']).toBe('1');
		expect(JSON.parse(file.body.toString()).schemaVersion).toBe(1);
		expect(
			Object.keys(tx.company.findMany.mock.calls[0][0].select)
		).toEqual(EXPORT_COLUMNS.companies);
	});
	test('does not invent a v2 contacts export', async () => {
		const { service, authorize, prisma } = setup();
		await expect(
			service.prepare(
				'Bearer user',
				workspaceId,
				'contacts',
				'json',
				undefined,
				2
			)
		).rejects.toMatchObject({ status: 400 });
		expect(authorize).not.toHaveBeenCalled();
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});
	test('READ_ONLY owner uses bounded read-only repeatable snapshot then fresh permission then audit', async () => {
		const { service, tx, prisma, authorize, audit, findMany } = setup();
		const file = await service.prepare(
			'Bearer user',
			workspaceId,
			'contacts',
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
				entity: 'contacts',
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
		{ permissions: ['customers:read'] }
	])('initial denial never reads or audits %p', async change => {
		const { service, authorize, prisma, audit } = setup();
		authorize.mockResolvedValue({ ...authority, ...change });
		await expect(
			service.prepare('Bearer user', workspaceId, 'contacts', 'json')
		).rejects.toMatchObject({ status: 403 });
		expect(prisma.$transaction).not.toHaveBeenCalled();
		expect(audit).not.toHaveBeenCalled();
	});
	test.each([
		{ role: 'CRM_ADMIN' },
		{ subject: 'another' },
		{ dataScope: 'TEAM', teamIds: ['team'] },
		{ permissions: ['customers:read'] }
	])(
		'fresh scope/revocation fails without file or audit %p',
		async change => {
			const { service, authorize, audit } = setup();
			authorize
				.mockResolvedValueOnce(authority)
				.mockResolvedValueOnce({ ...authority, ...change });
			await expect(
				service.prepare('Bearer user', workspaceId, 'contacts', 'json')
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
			service.prepare('Bearer user', workspaceId, 'contacts', 'json')
		).resolves.toHaveProperty('rowCount', 1);
	});
	test('dependency and audit failures are safe and release actor guard', async () => {
		const { service, audit } = setup();
		audit.mockRejectedValueOnce(new Error('sensitive-ORM-row-value'));
		await expect(
			service.prepare('Bearer user', workspaceId, 'contacts', 'json')
		).rejects.toMatchObject({
			status: 503,
			response: {
				code: 'crm_export_unavailable',
				message: 'Export is temporarily unavailable'
			}
		});
		await expect(
			service.prepare('Bearer user', workspaceId, 'contacts', 'json')
		).resolves.toHaveProperty('rowCount', 1);
	});
	test('reauthorization failure never audits and cancellation is closed', async () => {
		const { service, authorize, audit } = setup();
		authorize
			.mockResolvedValueOnce(authority)
			.mockRejectedValueOnce(new ForbiddenException());
		await expect(
			service.prepare('Bearer user', workspaceId, 'contacts', 'json')
		).rejects.toMatchObject({ status: 403 });
		expect(audit).not.toHaveBeenCalled();
		authorize.mockResolvedValue(authority);
		const signal = new AbortController();
		signal.abort();
		await expect(
			service.prepare(
				'Bearer user',
				workspaceId,
				'contacts',
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
			'contacts',
			'json'
		);
		await Promise.resolve();
		await Promise.resolve();
		await expect(
			service.prepare('Bearer user', workspaceId, 'contacts', 'json')
		).rejects.toMatchObject({ status: 429 });
		finish();
		await first;
	});
});
