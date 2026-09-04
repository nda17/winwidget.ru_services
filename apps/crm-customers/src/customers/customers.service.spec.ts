import {
	ConflictException,
	ForbiddenException,
	NotFoundException
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { CustomersAuthorization } from '../access/customers-authorization.client';
import { CrmCustomersPrismaService } from '../prisma/crm-customers-prisma.service';
import { customerScope, CustomersService } from './customers.service';

const workspaceId = randomUUID();
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
const row = {
	id: randomUUID(),
	workspaceId,
	name: 'Ирина',
	notes: null,
	phone: '+79000000001',
	email: 'irina@example.test',
	companyId: null,
	teamId: null,
	createdBySubject: 'owner',
	version: 1,
	archivedAt: null,
	createdAt: new Date('2026-09-05T00:00:00.000Z'),
	updatedAt: new Date('2026-09-05T00:00:00.000Z')
};
const command = {
	schemaVersion: 1 as const,
	workspaceId,
	commandId: randomUUID(),
	name: row.name,
	phone: row.phone,
	email: row.email
};

describe('CustomersService authorization and transaction semantics', () => {
	const setup = () => {
		const tx = {
			$executeRaw: jest.fn(),
			contact: {
				findFirst: jest.fn().mockResolvedValue(row),
				findMany: jest.fn().mockResolvedValue([row]),
				count: jest.fn().mockResolvedValue(1),
				create: jest.fn().mockResolvedValue(row),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			company: {
				findFirst: jest.fn(),
				findMany: jest.fn().mockResolvedValue([]),
				count: jest.fn().mockResolvedValue(0)
			},
			customerCommand: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn()
			},
			customerActivity: { create: jest.fn() }
		};
		const prisma = {
			...tx,
			$transaction: jest
				.fn()
				.mockImplementation(input =>
					typeof input === 'function' ? input(tx) : Promise.all(input)
				)
		};
		return {
			tx,
			prisma,
			service: new CustomersService(
				prisma as unknown as CrmCustomersPrismaService
			)
		};
	};

	it.each(['ACTIVE', 'GRACE'] as const)(
		'atomically stores row, audit and replay receipt in %s',
		async state => {
			const { service, tx, prisma } = setup();
			const result = await service.create(
				'contact',
				{ ...context, state },
				command
			);
			expect(tx.contact.create).toHaveBeenCalledWith({
				data: expect.objectContaining({
					workspaceId,
					createdBySubject: 'owner',
					email: row.email
				})
			});
			expect(tx.customerActivity.create).toHaveBeenCalledWith({
				data: expect.objectContaining({
					commandId: command.commandId,
					actorSubject: 'owner',
					entityVersion: 1,
					action: 'CREATED'
				})
			});
			expect(tx.customerCommand.create).toHaveBeenCalledWith({
				data: expect.objectContaining({
					commandId: command.commandId,
					actorSubject: 'owner',
					response: result
				})
			});
			expect(prisma.$transaction).toHaveBeenCalledWith(
				expect.any(Function),
				{ isolationLevel: 'Serializable' }
			);
		}
	);

	it('blocks write for read-only, permission-less and foreign-workspace callers before touching DB', async () => {
		const { service, prisma } = setup();
		for (const denied of [
			{ ...context, state: 'READ_ONLY' as const },
			{ ...context, permissions: ['customers:read'] },
			{ ...context, workspaceId: randomUUID() }
		]) {
			await expect(
				service.create('contact', denied, command)
			).rejects.toBeInstanceOf(ForbiddenException);
		}
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it('allows read-only read while applying workspace and own/team scope in database query', async () => {
		const { service, tx } = setup();
		await service.get(
			'contact',
			{ ...context, state: 'READ_ONLY', dataScope: 'OWN' },
			row.id,
			workspaceId
		);
		expect(tx.contact.findFirst).toHaveBeenCalledWith({
			where: {
				AND: [
					{ workspaceId, archivedAt: null, createdBySubject: 'owner' },
					{ id: row.id }
				]
			}
		});
		const teamId = randomUUID();
		expect(
			customerScope({ ...context, dataScope: 'TEAM', teamIds: [teamId] })
		).toEqual({
			workspaceId,
			archivedAt: null,
			OR: [{ createdBySubject: 'owner' }, { teamId: { in: [teamId] } }]
		});
	});

	it('does not reveal whether an inaccessible ID exists', async () => {
		const { service, tx } = setup();
		tx.contact.findFirst.mockResolvedValue(null);
		await expect(
			service.get('contact', context, row.id, workspaceId)
		).rejects.toBeInstanceOf(NotFoundException);
	});

	it('requires exact expected version and does not mutate after conflict', async () => {
		const { service, tx } = setup();
		await expect(
			service.update('contact', context, row.id, {
				...command,
				expectedVersion: 2
			})
		).rejects.toBeInstanceOf(ConflictException);
		expect(tx.contact.updateMany).not.toHaveBeenCalled();
		expect(tx.customerActivity.create).not.toHaveBeenCalled();
	});

	it('rejects contact links to inaccessible or foreign-workspace companies', async () => {
		const { service, tx } = setup();
		await expect(
			service.create('contact', context, {
				...command,
				companyId: randomUUID()
			})
		).rejects.toBeInstanceOf(NotFoundException);
		expect(tx.contact.create).not.toHaveBeenCalled();
	});

	it('does not let callers assign a team outside verified context', async () => {
		const { service, prisma } = setup();
		await expect(
			service.create('contact', context, {
				...command,
				teamId: randomUUID()
			})
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(prisma.$transaction).not.toHaveBeenCalled();
	});

	it('replays a request-bound response without a duplicate mutation', async () => {
		const { service, tx } = setup();
		const first = await service.create('contact', context, command);
		const receipt = tx.customerCommand.create.mock.calls[0][0].data;
		tx.customerCommand.findUnique.mockResolvedValue(receipt);
		expect(await service.create('contact', context, command)).toEqual(
			first
		);
		expect(tx.contact.create).toHaveBeenCalledTimes(1);
		expect(tx.customerActivity.create).toHaveBeenCalledTimes(1);
		await expect(
			service.create('contact', context, { ...command, name: 'Другой' })
		).rejects.toBeInstanceOf(ConflictException);
		await expect(
			service.create(
				'contact',
				{ ...context, subject: 'another' },
				command
			)
		).rejects.toBeInstanceOf(ConflictException);
	});

	it('revalidates entity visibility before replaying previously accepted PII', async () => {
		const { service, tx } = setup();
		await service.create('contact', context, command);
		tx.customerCommand.findUnique.mockResolvedValue(
			tx.customerCommand.create.mock.calls[0][0].data
		);
		tx.contact.findFirst.mockResolvedValue(null);
		await expect(
			service.create('contact', { ...context, dataScope: 'OWN' }, command)
		).rejects.toBeInstanceOf(NotFoundException);
	});

	it('scopes duplicate candidates and refuses unfiltered duplicate requests', async () => {
		const { service, tx } = setup();
		await service.duplicates(
			{ ...context, dataScope: 'OWN' },
			{ workspaceId, phone: row.phone, page: 1, pageSize: 10 }
		);
		expect(tx.contact.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					AND: [
						customerScope({ ...context, dataScope: 'OWN' }),
						{ OR: [{ phone: row.phone }] }
					]
				},
				take: 10,
				skip: 0
			})
		);
		await expect(
			service.duplicates(context, { workspaceId, page: 1, pageSize: 25 })
		).rejects.toThrow('phone or email');
	});

	it('does not hash or return untrusted actor fields', async () => {
		const { service, tx } = setup();
		await service.create('contact', context, command);
		const requestHash = createHash('sha256')
			.update(
				JSON.stringify({
					schemaVersion: 1,
					kind: 'contact',
					operation: 'create',
					workspaceId,
					actorSubject: 'owner',
					id: null,
					expectedVersion: null,
					data: {
						name: row.name,
						notes: null,
						teamId: null,
						phone: row.phone,
						email: row.email,
						companyId: null
					}
				})
			)
			.digest('hex');
		expect(
			tx.customerCommand.create.mock.calls[0][0].data.requestHash
		).toBe(requestHash);
	});
});
