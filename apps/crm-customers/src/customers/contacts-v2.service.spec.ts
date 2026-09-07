import {
	BadRequestException,
	ConflictException,
	ForbiddenException
} from '@nestjs/common';
import { Contact } from '@prisma/crm-customers-client';
import { randomUUID } from 'node:crypto';
import { CustomersAuthorization } from '../access/customers-authorization.client';
import { CrmCustomersPrismaService } from '../prisma/crm-customers-prisma.service';
import { CreateContactV2Dto } from './customers.dto';
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
	name: ' Ирина '
};
const preferences = {
	timeZone: 'America/New_York',
	preferredCallStart: '22:00',
	preferredCallEnd: '07:30'
};
const command: CreateContactV2Dto = {
	...legacy,
	schemaVersion: 2,
	...preferences
};
const record: Contact = {
	id: '22222222-2222-4222-8222-222222222222',
	workspaceId,
	name: 'Ирина',
	notes: null,
	phone: null,
	email: null,
	companyId: null,
	teamId: null,
	createdBySubject: 'owner',
	version: 1,
	archivedAt: null,
	createdAt: new Date('2026-09-07T00:00:00Z'),
	updatedAt: new Date('2026-09-07T00:00:00Z'),
	...preferences
};
function setup() {
	let stored = { ...record };
	const tx = {
		$executeRaw: jest.fn(),
		contact: {
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
					timeZone: null,
					preferredCallStart: null,
					preferredCallEnd: null,
					...data
				};
				return Promise.resolve(stored);
			}),
			updateMany: jest.fn().mockImplementation(({ data }) => {
				stored = { ...stored, ...data, version: stored.version + 1 };
				return Promise.resolve({ count: 1 });
			})
		},
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
	return {
		tx,
		prisma,
		service: new CustomersService(
			prisma as unknown as CrmCustomersPrismaService
		)
	};
}

describe('Contact v2 optional call preferences', () => {
	it.each([
		[
			'create',
			'835d000e7256a338d6a425bb7c022b2dd5de88c427817c5b525f97d4add6393b'
		],
		[
			'update',
			'303aad48265605b808edff20a4223cdb60598732a290dddea668d95a1bc461bc'
		],
		[
			'archive',
			'e3e10303e55f0653aef99cc2f77c8fcc90f22753a59e3609724d28a8d7d3a954'
		]
	] as const)(
		'preserves the v1 %s hash and projection',
		async (operation, hash) => {
			const { service, tx } = setup();
			const result =
				operation === 'create'
					? await service.create('contact', context, legacy)
					: await service[operation]('contact', context, record.id, {
							...legacy,
							expectedVersion: 1
						});
			expect(
				tx.customerCommand.create.mock.calls[0][0].data.requestHash
			).toBe(hash);
			expect(result).toMatchObject({ schemaVersion: 1 });
			expect(Object.keys((result as { contact: object }).contact)).toEqual(
				Object.keys(customerView('contact', record))
			);
			expect((result as { contact: object }).contact).not.toHaveProperty(
				'timeZone'
			);
			if (operation === 'update')
				expect(
					tx.contact.updateMany.mock.calls[0][0].data
				).not.toHaveProperty('timeZone');
		}
	);
	it('stores overnight preferences, receipt and field-only audit atomically', async () => {
		const { service, tx, prisma } = setup();
		const result = await service.create('contact', context, command);
		expect(result).toMatchObject({
			schemaVersion: 2,
			contact: preferences
		});
		expect(tx.customerCommand.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ response: result })
		});
		expect(
			tx.customerActivity.create.mock.calls[0][0].data.changedFields
		).toEqual(expect.arrayContaining(Object.keys(preferences)));
		expect(prisma.$transaction).toHaveBeenCalledWith(
			expect.any(Function),
			{ isolationLevel: 'Serializable' }
		);
	});
	it('replays immutable v1 and v2 receipts and rejects cross-version reuse', async () => {
		for (const input of [legacy, command]) {
			const { service, tx } = setup();
			const first = await service.create('contact', context, input);
			tx.customerCommand.findUnique.mockResolvedValue(
				tx.customerCommand.create.mock.calls[0][0].data
			);
			tx.contact.findFirst.mockResolvedValue({
				...record,
				version: 9,
				timeZone: 'UTC'
			});
			expect(await service.create('contact', context, input)).toEqual(
				first
			);
			expect(tx.contact.create).toHaveBeenCalledTimes(1);
			await expect(
				service.create('contact', context, {
					...input,
					schemaVersion: input.schemaVersion === 1 ? 2 : 1
				})
			).rejects.toBeInstanceOf(ConflictException);
		}
	});
	it('preserves omitted fields, accepts a partial valid patch and clears explicit nulls', async () => {
		const { service, tx } = setup();
		const update = {
			...legacy,
			schemaVersion: 2 as const,
			expectedVersion: 1
		};
		expect(
			await service.update('contact', context, record.id, update)
		).toMatchObject({ contact: preferences });
		expect(tx.contact.updateMany.mock.calls[0][0].data).not.toHaveProperty(
			'timeZone'
		);
		expect(
			await service.update('contact', context, record.id, {
				...update,
				expectedVersion: 2,
				preferredCallEnd: '08:00'
			})
		).toMatchObject({
			contact: { ...preferences, preferredCallEnd: '08:00' }
		});
		expect(
			await service.update('contact', context, record.id, {
				...update,
				expectedVersion: 3,
				timeZone: null,
				preferredCallStart: null,
				preferredCallEnd: null
			})
		).toMatchObject({
			contact: {
				timeZone: null,
				preferredCallStart: null,
				preferredCallEnd: null
			}
		});
	});
	it('allows all absent fields and timezone without a window', async () => {
		for (const extra of [{}, { timeZone: 'Europe/Moscow' }]) {
			const { service } = setup();
			expect(
				await service.create('contact', context, {
					...legacy,
					schemaVersion: 2,
					...extra
				})
			).toMatchObject({
				contact: {
					timeZone: 'timeZone' in extra ? extra.timeZone : null,
					preferredCallStart: null,
					preferredCallEnd: null
				}
			});
		}
	});
	it.each([
		{ timeZone: null },
		{ timeZone: 'Mars/Example' },
		{ timeZone: '+03:00' },
		{ preferredCallStart: null },
		{ preferredCallEnd: null },
		{ preferredCallStart: '07:30' },
		{ preferredCallStart: '24:00' },
		{ preferredCallEnd: '8:00' },
		{ preferredCallStart: '10:60' }
	])(
		'rejects invalid final combination before any row/audit/receipt write: %j',
		async patch => {
			const { service, tx } = setup();
			await expect(
				service.update('contact', context, record.id, {
					...legacy,
					schemaVersion: 2,
					expectedVersion: 1,
					...patch
				})
			).rejects.toBeInstanceOf(BadRequestException);
			expect(tx.contact.updateMany).not.toHaveBeenCalled();
			expect(tx.customerActivity.create).not.toHaveBeenCalled();
			expect(tx.customerCommand.create).not.toHaveBeenCalled();
		}
	);
	it('keeps CAS, current workspace and read-only write guards', async () => {
		const { service, tx } = setup();
		await expect(
			service.update('contact', context, record.id, {
				...command,
				expectedVersion: 2
			})
		).rejects.toBeInstanceOf(ConflictException);
		await expect(
			service.create(
				'contact',
				{ ...context, state: 'READ_ONLY' },
				command
			)
		).rejects.toBeInstanceOf(ForbiddenException);
		await expect(
			service.create('contact', context, {
				...command,
				workspaceId: randomUUID()
			})
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(tx.contact.create).not.toHaveBeenCalled();
		expect(tx.contact.updateMany).not.toHaveBeenCalled();
	});
	it('projects all v2 reads while preserving v1 and archived activity shape', async () => {
		const { service } = setup();
		expect(
			await service.get('contact', context, record.id, workspaceId, 2)
		).toMatchObject({ schemaVersion: 2, contact: preferences });
		expect(
			await service.list(
				'contact',
				context,
				{ workspaceId, page: 1, pageSize: 20 },
				2
			)
		).toMatchObject({
			schemaVersion: 2,
			items: [expect.objectContaining(preferences)],
			total: 1
		});
		expect(
			await service.duplicates(
				context,
				{ workspaceId, page: 1, pageSize: 20, phone: '+79000000001' },
				2
			)
		).toMatchObject({
			schemaVersion: 2,
			items: [expect.objectContaining(preferences)]
		});
		expect(
			await service.activities(
				'contact',
				context,
				record.id,
				{ workspaceId, page: 1, pageSize: 20 },
				2
			)
		).toMatchObject({ schemaVersion: 2, items: [], total: 0 });
		expect(
			await service.archive('contact', context, record.id, {
				schemaVersion: 2,
				workspaceId,
				commandId: randomUUID(),
				expectedVersion: 1
			})
		).toMatchObject({
			schemaVersion: 2,
			contact: { ...preferences, archivedAt: expect.any(String) }
		});
	});
});
