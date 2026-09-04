import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
	CreateCompanyDto,
	CreateContactDto,
	CustomerListQuery,
	UpdateContactDto
} from './customers.dto';

const pipe = new ValidationPipe({
	transform: true,
	whitelist: true,
	forbidNonWhitelisted: true,
	validationError: { target: false, value: false }
});
const command = {
	schemaVersion: 1,
	commandId: randomUUID(),
	workspaceId: randomUUID(),
	name: 'Ирина',
	phone: '+79000000001',
	email: 'irina@example.test'
};

describe('Customers HTTP validation', () => {
	it('accepts a bounded contact command', async () => {
		await expect(
			pipe.transform(command, { type: 'body', metatype: CreateContactDto })
		).resolves.toEqual(command);
	});
	it.each([
		{ name: '  ' },
		{ name: 'a'.repeat(201) },
		{ phone: '89000000001' },
		{ email: 'bad email' },
		{ schemaVersion: 2 },
		{ ownerSubject: 'another-user' },
		{ notes: 'a'.repeat(5001) },
		{ companyId: 'bad' },
		{ workspaceId: '' }
	])('rejects invalid create %j', override => {
		return expect(
			pipe.transform(
				{ ...command, ...override },
				{ type: 'body', metatype: CreateContactDto }
			)
		).rejects.toBeInstanceOf(BadRequestException);
	});
	it('requires optimistic version for PUT', () => {
		return expect(
			pipe.transform(command, { type: 'body', metatype: UpdateContactDto })
		).rejects.toBeInstanceOf(BadRequestException);
	});
	it.each([
		'javascript:alert(1)',
		'https://user:password@example.test',
		'ftp://example.test'
	])('rejects unsafe company URL %s', website => {
		return expect(
			pipe.transform(
				{
					schemaVersion: 1,
					commandId: randomUUID(),
					workspaceId: randomUUID(),
					name: 'Компания',
					website
				},
				{ type: 'body', metatype: CreateCompanyDto }
			)
		).rejects.toBeInstanceOf(BadRequestException);
	});
	it('provides server paging defaults and rejects over-limit or non-scalar query values', async () => {
		await expect(
			pipe.transform(
				{ workspaceId: command.workspaceId },
				{ type: 'query', metatype: CustomerListQuery }
			)
		).resolves.toMatchObject({ page: 1, pageSize: 25 });
		for (const query of [
			{ pageSize: '101' },
			{ page: '0' },
			{ search: 'a'.repeat(201) },
			{ workspaceId: [command.workspaceId] }
		]) {
			await expect(
				pipe.transform(
					{ workspaceId: command.workspaceId, ...query },
					{ type: 'query', metatype: CustomerListQuery }
				)
			).rejects.toBeInstanceOf(BadRequestException);
		}
	});
});
