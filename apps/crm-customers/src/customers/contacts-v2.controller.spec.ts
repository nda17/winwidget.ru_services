import { BadRequestException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { randomUUID } from 'node:crypto';
import { CustomersAuthorizationClient } from '../access/customers-authorization.client';
import { ContactsV2Controller } from './contacts-v2.controller';
import {
	ArchiveContactV2Dto,
	CreateContactV2Dto,
	UpdateContactV2Dto
} from './customers.dto';
import { CustomersService } from './customers.service';

describe('Contact v2 controller binding', () => {
	const workspaceId = randomUUID(),
		id = randomUUID();
	const command = {
		schemaVersion: 2 as const,
		commandId: randomUUID(),
		workspaceId,
		name: 'Ирина',
		timeZone: 'UTC'
	};
	const query = { workspaceId, page: 2, pageSize: 20 };
	const authorized = { workspaceId, subject: 'actor' };
	function setup() {
		const authorization = {
			authorize: jest.fn().mockResolvedValue(authorized)
		};
		const customers = {
			list: jest.fn(),
			get: jest.fn(),
			activities: jest.fn(),
			duplicates: jest.fn(),
			create: jest.fn(),
			update: jest.fn(),
			archive: jest.fn()
		};
		return {
			authorization,
			customers,
			controller: new ContactsV2Controller(
				authorization as unknown as CustomersAuthorizationClient,
				customers as unknown as CustomersService
			)
		};
	}
	it('declares v2-only DTO metadata without inherited Equals(1)', () => {
		expect(Reflect.getMetadata(PATH_METADATA, ContactsV2Controller)).toBe(
			'crm/customers/v2/contacts'
		);
		for (const [method, index, dto] of [
			['create', 2, CreateContactV2Dto],
			['update', 3, UpdateContactV2Dto],
			['archive', 3, ArchiveContactV2Dto]
		] as const)
			expect(
				Reflect.getMetadata(
					'design:paramtypes',
					ContactsV2Controller.prototype,
					method
				)[index]
			).toBe(dto);
	});
	it('reuses confirmed workspace authority for server-paged reads and commands', async () => {
		const { controller, customers, authorization } = setup();
		await controller.list('Bearer token', query);
		await controller.get('Bearer token', id, { workspaceId });
		await controller.activities('Bearer token', id, query);
		await controller.duplicates('Bearer token', {
			...query,
			phone: '+79000000001'
		});
		await controller.create('Bearer token', command.commandId, command);
		await controller.update('Bearer token', command.commandId, id, {
			...command,
			expectedVersion: 1
		});
		await controller.archive('Bearer token', command.commandId, id, {
			schemaVersion: 2,
			commandId: command.commandId,
			workspaceId,
			expectedVersion: 1
		});
		expect(customers.list).toHaveBeenCalledWith(
			'contact',
			authorized,
			query,
			2
		);
		expect(customers.get).toHaveBeenCalledWith(
			'contact',
			authorized,
			id,
			workspaceId,
			2
		);
		expect(customers.activities).toHaveBeenCalledWith(
			'contact',
			authorized,
			id,
			query,
			2
		);
		expect(customers.duplicates).toHaveBeenCalledWith(
			authorized,
			{ ...query, phone: '+79000000001' },
			2
		);
		expect(customers.create).toHaveBeenCalledWith(
			'contact',
			authorized,
			command
		);
		expect(customers.update).toHaveBeenCalledWith(
			'contact',
			authorized,
			id,
			{ ...command, expectedVersion: 1 }
		);
		expect(customers.archive).toHaveBeenCalledWith(
			'contact',
			authorized,
			id,
			{
				schemaVersion: 2,
				commandId: command.commandId,
				workspaceId,
				expectedVersion: 1
			}
		);
		expect(authorization.authorize).toHaveBeenCalledTimes(7);
	});
	it('rejects all mismatched mutation keys before authorization', async () => {
		const { controller, authorization } = setup();
		await expect(
			controller.create('Bearer token', undefined, command)
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			controller.update('Bearer token', 'wrong', id, {
				...command,
				expectedVersion: 1
			})
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			controller.archive('Bearer token', 'wrong', id, {
				...command,
				expectedVersion: 1
			})
		).rejects.toBeInstanceOf(BadRequestException);
		expect(authorization.authorize).not.toHaveBeenCalled();
	});
});
