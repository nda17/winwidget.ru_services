import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	NotFoundException
} from '@nestjs/common';
import { Company } from '@prisma/crm-customers-client';
import { randomUUID } from 'node:crypto';
import { CustomersAuthorization } from '../access/customers-authorization.client';
import { CrmCustomersPrismaService } from '../prisma/crm-customers-prisma.service';
import { CreateCompanyV2Dto } from './customers.dto';
import { customerView, CustomersService } from './customers.service';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const context: CustomersAuthorization = {
	schemaVersion: 1,
	workspaceId,
	subject: 'owner',
	role: 'OWNER',
	state: 'ACTIVE',
	dataScope: 'ALL',
	teamIds: [],
	permissions: ['customers:read', 'customers:write']
};
const legacy = {
	schemaVersion: 1 as const,
	workspaceId,
	commandId: randomUUID(),
	name: ' Компания ',
	inn: '1234567890'
};
const fields = {
	legalName: 'Полное имя',
	kpp: '123456789',
	ogrn: '1234567890123',
	legalAddress: 'Москва',
	entityType: 'LEGAL' as const
};
const command: CreateCompanyV2Dto = {
	...legacy,
	schemaVersion: 2,
	...fields
};
const record: Company = {
	id: '22222222-2222-4222-8222-222222222222',
	workspaceId,
	name: 'Компания',
	inn: legacy.inn,
	website: null,
	notes: null,
	createdBySubject: 'owner',
	teamId: null,
	version: 1,
	archivedAt: null,
	createdAt: new Date('2026-09-07T00:00:00.000Z'),
	updatedAt: new Date('2026-09-07T00:00:00.000Z'),
	...fields
};

function setup() {
	let stored = { ...record };
	const tx = {
		$executeRaw: jest.fn(),
		company: {
			findFirst: jest
				.fn()
				.mockImplementation(() => Promise.resolve(stored)),
			findMany: jest
				.fn()
				.mockImplementation(() => Promise.resolve([stored])),
			count: jest.fn().mockResolvedValue(1),
			create: jest.fn().mockImplementation(({ data }) => {
				stored = {
					...record,
					legalName: null,
					kpp: null,
					ogrn: null,
					legalAddress: null,
					entityType: null,
					...data
				};
				return Promise.resolve(stored);
			}),
			updateMany: jest.fn().mockImplementation(({ data }) => {
				stored = { ...stored, ...data, version: stored.version + 1 };
				return Promise.resolve({ count: 1 });
			})
		},
		contact: { count: jest.fn().mockResolvedValue(0) },
		customerCommand: {
			findUnique: jest.fn().mockResolvedValue(null),
			create: jest.fn()
		},
		customerActivity: {
			create: jest.fn(),
			findMany: jest.fn().mockResolvedValue([]),
			count: jest.fn().mockResolvedValue(0)
		}
	};
	const prisma = {
		...tx,
		$transaction: jest
			.fn()
			.mockImplementation(input =>
				typeof input === 'function' ? input(tx) : Promise.all(input)
			)
	};
	const service = new CustomersService(
		prisma as unknown as CrmCustomersPrismaService
	);
	return { service, tx, prisma };
}

describe('Company v2 persistence and legacy compatibility', () => {
	it.each([
		[
			'update',
			'82460d7648d908fbcb444fc3e0ddd0757c98841ec7d8ce475c2966a3e9a6c39d'
		],
		[
			'archive',
			'e200d95cf3f3cf534bbfb61cedfdb4e9503cb2a562acf2c9ab2c402dd3e52308'
		]
	] as const)(
		'preserves the exact pre-v2 %s command hash',
		async (operation, expectedHash) => {
			const { service, tx } = setup();
			await service[operation]('company', context, record.id, {
				...legacy,
				expectedVersion: 1
			});
			expect(
				tx.customerCommand.create.mock.calls[0][0].data.requestHash
			).toBe(expectedHash);
		}
	);
	it('preserves the exact pre-v2 company command hash and v1 response keys', async () => {
		const { service, tx } = setup();
		const result = await service.create('company', context, legacy);
		expect(
			tx.customerCommand.create.mock.calls[0][0].data.requestHash
		).toBe(
			'39c61acb955f4389fa2bcdfb3f9208a403676538dd76b52772ebc5fd7ea236dc'
		);
		expect(result).toEqual({
			schemaVersion: 1,
			company: customerView('company', {
				...record,
				...Object.fromEntries(Object.keys(fields).map(key => [key, null]))
			})
		});
		expect(
			Object.keys((result as { company: object }).company).sort()
		).toEqual(
			[
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
			].sort()
		);
		expect(tx.company.create.mock.calls[0][0].data).not.toHaveProperty(
			'legalName'
		);
	});
	it('replays the original v1 JSON despite later v2 fields and refuses cross-version reuse', async () => {
		const { service, tx } = setup();
		const first = await service.create('company', context, legacy);
		tx.customerCommand.findUnique.mockResolvedValue(
			tx.customerCommand.create.mock.calls[0][0].data
		);
		tx.company.findFirst.mockResolvedValue({ ...record, version: 5 });
		expect(await service.create('company', context, legacy)).toBe(first);
		await expect(
			service.create('company', context, command)
		).rejects.toBeInstanceOf(ConflictException);
		expect(tx.company.create).toHaveBeenCalledTimes(1);
	});
	it('stores all v2 requisites, audit and immutable response in the same serializable transaction', async () => {
		const { service, tx, prisma } = setup();
		const result = await service.create('company', context, {
			...command,
			legalName: '  Полное имя  ',
			legalAddress: ' Москва '
		});
		expect(result).toMatchObject({ schemaVersion: 2, company: fields });
		expect(tx.company.create.mock.calls[0][0].data).toMatchObject(fields);
		expect(
			tx.customerActivity.create.mock.calls[0][0].data.changedFields
		).toEqual(expect.arrayContaining(Object.keys(fields)));
		expect(tx.customerCommand.create.mock.calls[0][0].data.response).toBe(
			result
		);
		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			{ isolationLevel: 'Serializable' }
		);
		tx.customerCommand.findUnique.mockResolvedValue(
			tx.customerCommand.create.mock.calls[0][0].data
		);
		expect(await service.create('company', context, command)).toBe(result);
		expect(tx.company.create).toHaveBeenCalledTimes(1);
	});
	it('creates omitted requisites as null without inventing entity type', async () => {
		const { service, tx } = setup();
		const result = await service.create('company', context, {
			...legacy,
			schemaVersion: 2
		});
		const empty = Object.fromEntries(
			Object.keys(fields).map(key => [key, null])
		);
		expect(result).toMatchObject({ schemaVersion: 2, company: empty });
		expect(tx.company.create.mock.calls[0][0].data).toMatchObject(empty);
	});
	it.each([1, 2] as const)(
		'preserves requisites when update v%s omits them',
		async schemaVersion => {
			const { service, tx } = setup();
			await service.update('company', context, record.id, {
				...legacy,
				schemaVersion,
				expectedVersion: 1,
				name: 'Новое имя'
			});
			const update = tx.company.updateMany.mock.calls[0][0].data;
			for (const field of Object.keys(fields))
				expect(update).not.toHaveProperty(field);
			expect(
				tx.customerActivity.create.mock.calls[0][0].data.changedFields
			).not.toEqual(expect.arrayContaining(['legalName']));
			expect(
				await service.get('company', context, record.id, workspaceId, 2)
			).toMatchObject({
				schemaVersion: 2,
				company: { ...fields, name: 'Новое имя', version: 2 }
			});
		}
	);
	it('distinguishes omitted, explicit clear, and changed requisites in hash/audit', async () => {
		const { service, tx } = setup();
		const update = {
			...legacy,
			schemaVersion: 2 as const,
			expectedVersion: 1,
			legalName: null,
			legalAddress: '   ',
			entityType: null
		};
		const result = await service.update(
			'company',
			context,
			record.id,
			update
		);
		expect(result).toMatchObject({
			company: {
				legalName: null,
				legalAddress: null,
				entityType: null,
				kpp: fields.kpp,
				ogrn: fields.ogrn
			}
		});
		expect(
			tx.customerActivity.create.mock.calls[0][0].data.changedFields
		).toEqual(
			expect.arrayContaining(['legalName', 'legalAddress', 'entityType'])
		);
		tx.customerCommand.findUnique.mockResolvedValue(
			tx.customerCommand.create.mock.calls[0][0].data
		);
		expect(
			await service.update('company', context, record.id, update)
		).toBe(result);
		await expect(
			service.update('company', context, record.id, {
				...legacy,
				schemaVersion: 2,
				expectedVersion: 1
			})
		).rejects.toBeInstanceOf(ConflictException);
		await expect(
			service.update('company', context, record.id, {
				...update,
				kpp: null
			})
		).rejects.toBeInstanceOf(ConflictException);
	});
	it('CAS conflict and lost update do not create receipt or audit', async () => {
		const { service, tx } = setup();
		await expect(
			service.update('company', context, record.id, {
				...command,
				expectedVersion: 2
			})
		).rejects.toBeInstanceOf(ConflictException);
		expect(tx.company.updateMany).not.toHaveBeenCalled();
		tx.company.updateMany.mockResolvedValue({ count: 0 });
		await expect(
			service.update('company', context, record.id, {
				...command,
				expectedVersion: 1
			})
		).rejects.toBeInstanceOf(ConflictException);
		expect(tx.customerCommand.create).not.toHaveBeenCalled();
		expect(tx.customerActivity.create).not.toHaveBeenCalled();
	});
	it('rechecks actor, workspace and entity visibility before v2 receipt replay', async () => {
		const { service, tx } = setup();
		await service.create('company', context, command);
		tx.customerCommand.findUnique.mockResolvedValue(
			tx.customerCommand.create.mock.calls[0][0].data
		);
		await expect(
			service.create(
				'company',
				{ ...context, subject: 'another' },
				command
			)
		).rejects.toBeInstanceOf(ConflictException);
		await expect(
			service.create(
				'company',
				{ ...context, workspaceId: randomUUID() },
				command
			)
		).rejects.toBeInstanceOf(ForbiddenException);
		tx.company.findFirst.mockResolvedValue(null);
		await expect(
			service.create('company', { ...context, dataScope: 'OWN' }, command)
		).rejects.toBeInstanceOf(NotFoundException);
		expect(tx.company.create).toHaveBeenCalledTimes(1);
	});
	it('uses the unchanged read-only/team guards and server pagination for v2', async () => {
		const { service, tx, prisma } = setup();
		const reader = {
			...context,
			state: 'READ_ONLY' as const,
			dataScope: 'OWN' as const
		};
		expect(
			await service.get('company', reader, record.id, workspaceId, 2)
		).toMatchObject({ schemaVersion: 2, company: fields });
		const list = await service.list(
			'company',
			reader,
			{ workspaceId, page: 2, pageSize: 1 },
			2
		);
		expect(list).toMatchObject({
			schemaVersion: 2,
			page: 2,
			pageSize: 1,
			total: 1,
			items: [fields]
		});
		expect(tx.company.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				skip: 1,
				take: 1,
				where: {
					AND: [
						{ workspaceId, archivedAt: null, createdBySubject: 'owner' }
					]
				}
			})
		);
		prisma.$transaction.mockClear();
		await expect(
			service.create('company', reader, command)
		).rejects.toBeInstanceOf(ForbiddenException);
		await expect(
			service.archive('company', reader, record.id, {
				schemaVersion: 2,
				workspaceId,
				commandId: randomUUID(),
				expectedVersion: 1
			})
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});
	it('keeps company archival and activities versioned without changing stored audit fields', async () => {
		const { service, tx } = setup();
		const archive = {
			schemaVersion: 2 as const,
			workspaceId,
			commandId: randomUUID(),
			expectedVersion: 1
		};
		const result = await service.archive(
			'company',
			context,
			record.id,
			archive
		);
		expect(result).toMatchObject({
			schemaVersion: 2,
			company: { ...fields, version: 2, archivedAt: expect.any(String) }
		});
		expect(
			tx.customerActivity.create.mock.calls[0][0].data.changedFields
		).toEqual(['archivedAt']);
		tx.customerCommand.findUnique.mockResolvedValue(
			tx.customerCommand.create.mock.calls[0][0].data
		);
		expect(
			await service.archive('company', context, record.id, archive)
		).toBe(result);
		const query = { workspaceId, page: 1, pageSize: 25 };
		expect(
			await service.activities('company', context, record.id, query, 2)
		).toMatchObject({ schemaVersion: 2, page: 1, pageSize: 25 });
		expect(
			await service.activities('company', context, record.id, query)
		).toMatchObject({ schemaVersion: 1 });
	});
	it('does not enable any v2 contact operation', async () => {
		const { service, prisma } = setup();
		await expect(
			service.create('contact', context, command)
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			service.list(
				'contact',
				context,
				{ workspaceId, page: 1, pageSize: 25 },
				2
			)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});
});
