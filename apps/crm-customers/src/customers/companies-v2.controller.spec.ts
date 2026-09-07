import {
	BadRequestException,
	ForbiddenException,
	UnauthorizedException,
	ValidationPipe
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Company } from '@prisma/crm-customers-client';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { CustomersAuthorizationClient } from '../access/customers-authorization.client';
import { CrmCustomersPrismaService } from '../prisma/crm-customers-prisma.service';
import { CompaniesV2Controller } from './companies-v2.controller';
import { CustomersController } from './customers.controller';
import {
	ArchiveCompanyV2Dto,
	CreateCompanyV2Dto,
	UpdateCompanyV2Dto
} from './customers.dto';
import { CustomersService } from './customers.service';

describe('CompaniesV2Controller boundary', () => {
	const workspaceId = randomUUID(),
		id = randomUUID();
	const command = {
		schemaVersion: 2 as const,
		commandId: randomUUID(),
		workspaceId,
		name: 'Компания',
		legalName: 'Полное имя'
	};
	const query = { workspaceId, page: 2, pageSize: 20 };
	const authorized = { workspaceId, subject: 'actor' };
	function setup() {
		const authorization = {
			authorize: jest.fn().mockResolvedValue(authorized)
		};
		const customers = {
			create: jest.fn(),
			update: jest.fn(),
			archive: jest.fn(),
			list: jest.fn(),
			get: jest.fn(),
			activities: jest.fn()
		};
		return {
			authorization,
			customers,
			controller: new CompaniesV2Controller(
				authorization as unknown as CustomersAuthorizationClient,
				customers as unknown as CustomersService
			)
		};
	}
	it('declares separate v2 routes and v2 request DTOs', () => {
		expect(Reflect.getMetadata(PATH_METADATA, CompaniesV2Controller)).toBe(
			'crm/customers/v2/companies'
		);
		expect(
			Reflect.getMetadata(
				'design:paramtypes',
				CompaniesV2Controller.prototype,
				'create'
			)[2]
		).toBe(CreateCompanyV2Dto);
		expect(
			Reflect.getMetadata(
				'design:paramtypes',
				CompaniesV2Controller.prototype,
				'update'
			)[3]
		).toBe(UpdateCompanyV2Dto);
		expect(
			Reflect.getMetadata(
				'design:paramtypes',
				CompaniesV2Controller.prototype,
				'archive'
			)[3]
		).toBe(ArchiveCompanyV2Dto);
	});
	it('passes version2 only to company reads and retains authoritative workspace binding', async () => {
		const { controller, customers, authorization } = setup();
		await controller.list('Bearer list', query);
		await controller.get('Bearer get', id, { workspaceId });
		await controller.activities('Bearer activity', id, query);
		expect(customers.list).toHaveBeenCalledWith(
			'company',
			authorized,
			query,
			2
		);
		expect(customers.get).toHaveBeenCalledWith(
			'company',
			authorized,
			id,
			workspaceId,
			2
		);
		expect(customers.activities).toHaveBeenCalledWith(
			'company',
			authorized,
			id,
			query,
			2
		);
		expect(authorization.authorize.mock.calls).toEqual([
			['Bearer list', workspaceId],
			['Bearer get', workspaceId],
			['Bearer activity', workspaceId]
		]);
	});
	it.each([undefined, '', 'wrong-key'])(
		'refuses mismatched key %s before authorization or mutation',
		async key => {
			const { controller, customers, authorization } = setup();
			await expect(
				controller.create('Bearer token', key, command)
			).rejects.toBeInstanceOf(BadRequestException);
			await expect(
				controller.update('Bearer token', key, id, {
					...command,
					expectedVersion: 1
				})
			).rejects.toBeInstanceOf(BadRequestException);
			await expect(
				controller.archive('Bearer token', key, id, {
					schemaVersion: 2,
					workspaceId,
					commandId: command.commandId,
					expectedVersion: 1
				})
			).rejects.toBeInstanceOf(BadRequestException);
			expect(authorization.authorize).not.toHaveBeenCalled();
			expect(customers.create).not.toHaveBeenCalled();
			expect(customers.update).not.toHaveBeenCalled();
			expect(customers.archive).not.toHaveBeenCalled();
		}
	);
	it('reauthorizes each v2 mutation and preserves command/CAS fields', async () => {
		const { controller, customers, authorization } = setup();
		const update = { ...command, expectedVersion: 1 };
		const archive = {
			schemaVersion: 2 as const,
			workspaceId,
			commandId: command.commandId,
			expectedVersion: 2
		};
		await controller.create('Bearer first', command.commandId, command);
		await controller.update(
			'Bearer second',
			command.commandId,
			id,
			update
		);
		await controller.archive(
			'Bearer third',
			command.commandId,
			id,
			archive
		);
		expect(authorization.authorize.mock.calls).toEqual([
			['Bearer first', workspaceId],
			['Bearer second', workspaceId],
			['Bearer third', workspaceId]
		]);
		expect(customers.create).toHaveBeenCalledWith(
			'company',
			authorized,
			command
		);
		expect(customers.update).toHaveBeenCalledWith(
			'company',
			authorized,
			id,
			update
		);
		expect(customers.archive).toHaveBeenCalledWith(
			'company',
			authorized,
			id,
			archive
		);
	});
	it('does not access company records when fresh authorization fails', async () => {
		const { controller, customers, authorization } = setup();
		authorization.authorize.mockRejectedValue(new ForbiddenException());
		await expect(
			controller.list('Bearer revoked', query)
		).rejects.toBeInstanceOf(ForbiddenException);
		await expect(
			controller.create('Bearer revoked', command.commandId, command)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(customers.list).not.toHaveBeenCalled();
		expect(customers.create).not.toHaveBeenCalled();
	});
});

describe('Companies v1/v2 coexistence through actual Nest HTTP', () => {
	const workspaceId = '11111111-1111-4111-8111-111111111111';
	const companyId = '22222222-2222-4222-8222-222222222222';
	const requisites = {
		legalName: 'Полное наименование',
		kpp: '123456789',
		ogrn: '1234567890123',
		legalAddress: 'Юридический адрес',
		entityType: 'LEGAL' as const
	};
	const legacyKeys = [
		'id',
		'workspaceId',
		'name',
		'notes',
		'createdBySubject',
		'teamId',
		'version',
		'archivedAt',
		'createdAt',
		'updatedAt',
		'inn',
		'website'
	];
	const access = () => ({
		schemaVersion: 1,
		workspaceId,
		subject: 'actor',
		role: 'OWNER',
		state: 'ACTIVE',
		dataScope: 'ALL',
		teamIds: [],
		permissions: ['customers:read', 'customers:write']
	});
	let app: NestExpressApplication;
	let origin: string;
	let stored: Company | null;
	const receipts = new Map<string, Record<string, unknown>>();
	const authorize = jest.fn();
	// Only the DB boundary is stubbed. Routing, DTO validation, command hashes,
	// projection, mutation normalization and version handling use production code.
	const matches = (where: Record<string, unknown>): boolean => {
		if (!stored) return false;
		if (Array.isArray(where.AND) && !where.AND.every(matches))
			return false;
		return [
			'id',
			'workspaceId',
			'version',
			'archivedAt',
			'createdBySubject'
		].every(
			key =>
				!Object.prototype.hasOwnProperty.call(where, key) ||
				stored![key as keyof Company] === where[key]
		);
	};
	const company = {
		findFirst: jest.fn(
			async ({ where }: { where: Record<string, unknown> }) =>
				matches(where) ? stored : null
		),
		findMany: jest.fn(
			async ({ where }: { where: Record<string, unknown> }) =>
				matches(where) ? [stored!] : []
		),
		count: jest.fn(
			async ({ where }: { where: Record<string, unknown> }) =>
				matches(where) ? 1 : 0
		),
		create: jest.fn(
			async ({ data }: { data: Record<string, unknown> }) => {
				stored = {
					id: companyId,
					workspaceId,
					name: 'Company',
					inn: null,
					website: null,
					legalName: null,
					kpp: null,
					ogrn: null,
					legalAddress: null,
					entityType: null,
					notes: null,
					createdBySubject: 'actor',
					teamId: null,
					version: 1,
					archivedAt: null,
					createdAt: new Date('2026-09-07T00:00:00.000Z'),
					updatedAt: new Date('2026-09-07T00:00:00.000Z'),
					...data
				} as Company;
				return stored;
			}
		),
		updateMany: jest.fn(
			async ({
				where,
				data
			}: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				if (!matches(where)) return { count: 0 };
				stored = {
					...stored!,
					...data,
					version: stored!.version + 1
				} as Company;
				return { count: 1 };
			}
		)
	};
	const tx = {
		$executeRaw: jest.fn(),
		company,
		contact: { count: jest.fn().mockResolvedValue(0) },
		customerCommand: {
			findUnique: jest.fn(
				async ({ where }: { where: { commandId: string } }) =>
					receipts.get(where.commandId) ?? null
			),
			create: jest.fn(
				async ({ data }: { data: Record<string, unknown> }) => {
					receipts.set(data.commandId as string, data);
					return data;
				}
			)
		},
		customerActivity: { create: jest.fn().mockResolvedValue({}) }
	};
	const transaction = jest.fn(async (input: unknown) =>
		typeof input === 'function'
			? input(tx)
			: Promise.all(input as Promise<unknown>[])
	);
	beforeAll(async () => {
		const module = await Test.createTestingModule({
			controllers: [CustomersController, CompaniesV2Controller],
			providers: [
				CustomersService,
				{ provide: CustomersAuthorizationClient, useValue: { authorize } },
				{
					provide: CrmCustomersPrismaService,
					useValue: { ...tx, $transaction: transaction }
				}
			]
		}).compile();
		app = module.createNestApplication<NestExpressApplication>({
			logger: false
		});
		app.setGlobalPrefix('api/v1');
		app.useGlobalPipes(
			new ValidationPipe({
				transform: true,
				whitelist: true,
				forbidNonWhitelisted: true,
				validationError: { target: false, value: false }
			})
		);
		await app.listen(0, '127.0.0.1');
		origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
	});
	afterAll(async () => {
		await app?.close();
	});
	beforeEach(() => {
		jest.clearAllMocks();
		stored = null;
		receipts.clear();
		authorize
			.mockReset()
			.mockImplementation(async (bearer: string | undefined) => {
				if (bearer !== 'Bearer unit') throw new UnauthorizedException();
				return access();
			});
	});
	const path = (version: 1 | 2, suffix = '') =>
		`${origin}/api/v1/crm/customers/${version === 2 ? 'v2/' : ''}companies${suffix}`;
	const body = (version: 1 | 2, operation = 'create') => ({
		schemaVersion: version,
		workspaceId,
		commandId: randomUUID(),
		...(operation === 'archive'
			? {}
			: {
					name: 'Компания',
					inn: '1234567890',
					...(version === 2 ? requisites : {})
				}),
		...(operation === 'create' ? {} : { expectedVersion: 1 })
	});
	const write = (
		version: 1 | 2,
		operation: string,
		data: Record<string, unknown>,
		key: string | null = data.commandId as string,
		bearer: string | null = 'Bearer unit'
	) =>
		fetch(
			path(
				version,
				operation === 'create'
					? ''
					: `/${companyId}${operation === 'archive' ? '/archive' : ''}`
			),
			{
				method: operation === 'update' ? 'PUT' : 'POST',
				headers: {
					'content-type': 'application/json',
					...(key === null ? {} : { 'idempotency-key': key }),
					...(bearer === null ? {} : { authorization: bearer })
				},
				body: JSON.stringify(data)
			}
		);
	const shape = (
		value: { schemaVersion: number; company: Record<string, unknown> },
		version: 1 | 2
	) => {
		expect(value.schemaVersion).toBe(version);
		expect(Object.keys(value).sort()).toEqual([
			'company',
			'schemaVersion'
		]);
		expect(Object.keys(value.company).sort()).toEqual(
			[
				...legacyKeys,
				...(version === 2 ? Object.keys(requisites) : [])
			].sort()
		);
	};
	it.each([1, 2] as const)(
		'routes v%s create/update/archive with its exact response shape and replay',
		async version => {
			const create = body(version);
			const created = await write(version, 'create', create);
			expect(created.status).toBe(200);
			const first = await created.json();
			shape(first, version);
			expect(first.company.version).toBe(1);
			const replay = await write(version, 'create', create);
			expect(replay.status).toBe(200);
			expect(await replay.json()).toEqual(first);
			expect(company.create).toHaveBeenCalledTimes(1);
			const updated = await write(version, 'update', {
				...body(version, 'update'),
				name: 'Изменено'
			});
			expect(updated.status).toBe(200);
			const next = await updated.json();
			shape(next, version);
			expect(next.company.name).toBe('Изменено');
			expect(next.company.version).toBe(2);
			const archive = { ...body(version, 'archive'), expectedVersion: 2 };
			const archived = await write(version, 'archive', archive);
			expect(archived.status).toBe(200);
			const last = await archived.json();
			shape(last, version);
			expect(last.company.archivedAt).toEqual(expect.any(String));
			expect(last.company.version).toBe(3);
			const archivedReplay = await write(version, 'archive', archive);
			expect(await archivedReplay.json()).toEqual(last);
			expect(company.updateMany).toHaveBeenCalledTimes(2);
			const unavailable = await fetch(
				`${path(version, `/${companyId}`)}?workspaceId=${workspaceId}`,
				{ headers: { authorization: 'Bearer unit' } }
			);
			expect(unavailable.status).toBe(404);
			await unavailable.body?.cancel();
		}
	);
	it('keeps v2 requisites through a v1 HTTP update while v1 and v2 GET projections coexist', async () => {
		const created = await write(2, 'create', body(2));
		expect(created.status).toBe(200);
		await created.body?.cancel();
		const updated = await write(1, 'update', body(1, 'update'));
		expect(updated.status).toBe(200);
		shape(await updated.json(), 1);
		for (const version of [1, 2] as const) {
			const response = await fetch(
				`${path(version, `/${companyId}`)}?workspaceId=${workspaceId}`,
				{ headers: { authorization: 'Bearer unit' } }
			);
			expect(response.status).toBe(200);
			const item = await response.json();
			shape(item, version);
			if (version === 2) expect(item.company).toMatchObject(requisites);
		}
		expect(stored).toMatchObject(requisites);
		expect(company.updateMany.mock.calls[0][0].data).not.toHaveProperty(
			'legalName'
		);
	});
	const routes = ([1, 2] as const).flatMap(version =>
		['create', 'update', 'archive'].map(operation => ({
			version,
			operation
		}))
	);
	it.each(routes)(
		'rejects the other schema on v$version $operation before authorization or persistence',
		async ({ version, operation }) => {
			const response = await write(version, operation, {
				...body(version, operation),
				schemaVersion: version === 1 ? 2 : 1
			});
			expect(response.status).toBe(400);
			await response.body?.cancel();
			expect(authorize).not.toHaveBeenCalled();
			expect(transaction).not.toHaveBeenCalled();
		}
	);
	it.each(routes)(
		'rejects extra fields on v$version $operation without echoing values',
		async ({ version, operation }) => {
			const response = await write(version, operation, {
				...body(version, operation),
				[version === 1 ? 'legalName' : 'providerStatus']:
					'PRIVATE_UNTRUSTED_EXTRA'
			});
			expect(response.status).toBe(400);
			expect(await response.text()).not.toContain(
				'PRIVATE_UNTRUSTED_EXTRA'
			);
			expect(authorize).not.toHaveBeenCalled();
			expect(transaction).not.toHaveBeenCalled();
		}
	);
	it.each(routes)(
		'enforces Idempotency-Key on v$version $operation before authorization',
		async ({ version, operation }) => {
			const response = await write(
				version,
				operation,
				body(version, operation),
				null
			);
			expect(response.status).toBe(400);
			await response.body?.cancel();
			expect(authorize).not.toHaveBeenCalled();
			expect(transaction).not.toHaveBeenCalled();
		}
	);
	it.each([1, 2] as const)(
		'does not authorize anonymous or READ_ONLY v%s mutations',
		async version => {
			const anonymous = await write(
				version,
				'create',
				body(version),
				undefined,
				null
			);
			expect(anonymous.status).toBe(401);
			await anonymous.body?.cancel();
			authorize.mockResolvedValue({ ...access(), state: 'READ_ONLY' });
			const readOnly = await write(version, 'create', body(version));
			expect(readOnly.status).toBe(403);
			await readOnly.body?.cancel();
			expect(transaction).not.toHaveBeenCalled();
		}
	);
});
