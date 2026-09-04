import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CustomersAuthorizationClient } from '../access/customers-authorization.client';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

describe('CustomersController request boundary', () => {
	const workspaceId = randomUUID();
	const command = {
		schemaVersion: 1 as const,
		workspaceId,
		commandId: randomUUID(),
		name: 'Контакт'
	};
	const setup = () => {
		const authorization = {
			authorize: jest
				.fn()
				.mockResolvedValue({ workspaceId, subject: 'actor' })
		};
		const customers = { create: jest.fn(), list: jest.fn() };
		return {
			authorization,
			customers,
			controller: new CustomersController(
				authorization as unknown as CustomersAuthorizationClient,
				customers as unknown as CustomersService
			)
		};
	};

	it.each([undefined, '', 'another-key'])(
		'rejects mismatched idempotency %s before authorization or mutation',
		async key => {
			const { controller, customers, authorization } = setup();
			await expect(
				controller.createContact('Bearer token', key, command)
			).rejects.toBeInstanceOf(BadRequestException);
			expect(authorization.authorize).not.toHaveBeenCalled();
			expect(customers.create).not.toHaveBeenCalled();
		}
	);

	it('uses freshly authorized workspace and subject for every request', async () => {
		const { controller, customers, authorization } = setup();
		await controller.createContact(
			'Bearer first',
			command.commandId,
			command
		);
		await controller.createContact(
			'Bearer second',
			command.commandId,
			command
		);
		expect(authorization.authorize.mock.calls).toEqual([
			['Bearer first', workspaceId],
			['Bearer second', workspaceId]
		]);
		expect(customers.create).toHaveBeenLastCalledWith(
			'contact',
			{ workspaceId, subject: 'actor' },
			command
		);
	});

	it('does not read customer data after access revocation', async () => {
		const { controller, customers, authorization } = setup();
		authorization.authorize.mockRejectedValue(new ForbiddenException());
		await expect(
			controller.contacts('Bearer token', {
				workspaceId,
				page: 1,
				pageSize: 25
			})
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(customers.list).not.toHaveBeenCalled();
	});
});
