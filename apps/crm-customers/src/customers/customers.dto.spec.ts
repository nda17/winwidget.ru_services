import { BadRequestException, Type, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
	ArchiveCompanyV2Dto,
	ArchiveContactV2Dto,
	CreateCompanyDto,
	CreateCompanyV2Dto,
	CreateContactDto,
	CreateContactV2Dto,
	CustomerListQuery,
	UpdateCompanyV2Dto,
	UpdateContactDto,
	UpdateContactV2Dto
} from './customers.dto';

const pipe = new ValidationPipe({
	transform: true,
	whitelist: true,
	forbidNonWhitelisted: true,
	validationError: { target: false, value: false }
});

describe('Contact v2 field validation without widening v1', () => {
	const contact = {
		schemaVersion: 2,
		workspaceId: randomUUID(),
		commandId: randomUUID(),
		name: 'Ирина'
	};
	const body = (
		value: unknown,
		metatype: Type<unknown> = CreateContactV2Dto
	) => pipe.transform(value, { type: 'body', metatype });
	it.each(['Europe/Moscow', 'America/New_York', 'UTC'])(
		'accepts explicit IANA zone %s and strict local times',
		async timeZone => {
			await expect(
				body({
					...contact,
					timeZone,
					preferredCallStart: '23:00',
					preferredCallEnd: '07:00'
				})
			).resolves.toMatchObject({ timeZone });
		}
	);
	it('allows absent/null fields and separate v2 update/archive ancestry', async () => {
		await expect(body(contact)).resolves.toMatchObject(contact);
		await expect(
			body(
				{
					...contact,
					timeZone: null,
					preferredCallStart: null,
					preferredCallEnd: null,
					expectedVersion: 1
				},
				UpdateContactV2Dto
			)
		).resolves.toMatchObject({ timeZone: null });
		const archive = {
			schemaVersion: 2,
			workspaceId: contact.workspaceId,
			commandId: contact.commandId
		};
		await expect(
			body({ ...archive, expectedVersion: 1 }, ArchiveContactV2Dto)
		).resolves.toMatchObject({ schemaVersion: 2 });
		await expect(
			body({ ...contact, expectedVersion: 1 }, ArchiveContactV2Dto)
		).rejects.toBeInstanceOf(BadRequestException);
	});
	it.each([
		{ schemaVersion: 1 },
		{ schemaVersion: '2' },
		{ timeZone: 'Mars/Test' },
		{ timeZone: '+03:00' },
		{ timeZone: '' },
		{ timeZone: 'x'.repeat(101) },
		{ timeZone: 3 },
		{ preferredCallStart: '24:00' },
		{ preferredCallEnd: '12:60' },
		{ preferredCallStart: '8:00' },
		{ preferredCallEnd: '08:00:00' },
		{ preferredCallEnd: 800 },
		{ expectedVersion: 1 },
		{ legalName: 'company-only' }
	])('rejects invalid contact input %j', extra =>
		expect(body({ ...contact, ...extra })).rejects.toBeInstanceOf(
			BadRequestException
		)
	);
	it('does not let legacy commands accept new fields or v2', async () => {
		await expect(body(contact, CreateContactDto)).rejects.toBeInstanceOf(
			BadRequestException
		);
		await expect(
			body(
				{ ...contact, schemaVersion: 1, timeZone: 'UTC' },
				CreateContactDto
			)
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			body({ ...contact, expectedVersion: 0 }, UpdateContactV2Dto)
		).rejects.toBeInstanceOf(BadRequestException);
	});
});

describe('Company v2 validation is isolated from legacy commands', () => {
	const company = {
		schemaVersion: 2,
		workspaceId: randomUUID(),
		commandId: randomUUID(),
		name: 'Компания',
		inn: '1234567890',
		legalName: 'Общество с ограниченной ответственностью Компания',
		kpp: '123456789',
		ogrn: '1234567890123',
		legalAddress: 'г. Москва',
		entityType: 'LEGAL'
	};
	const body = (
		value: unknown,
		metatype: Type<unknown> = CreateCompanyV2Dto
	) => pipe.transform(value, { type: 'body', metatype });

	it('accepts requisites without adding an INN checksum requirement to manual entry', async () => {
		await expect(body(company)).resolves.toMatchObject(company);
		await expect(
			body({
				...company,
				inn: '123456789012',
				ogrn: '123456789012345',
				entityType: 'INDIVIDUAL'
			})
		).resolves.toMatchObject({ entityType: 'INDIVIDUAL' });
	});
	it('allows omitted fields and explicit nulls without inherited Equals(1)', async () => {
		const basic = {
			schemaVersion: 2,
			workspaceId: company.workspaceId,
			commandId: company.commandId,
			name: company.name
		};
		await expect(body(basic)).resolves.toMatchObject(basic);
		await expect(
			body({
				...basic,
				legalName: null,
				kpp: null,
				ogrn: null,
				legalAddress: null,
				entityType: null
			})
		).resolves.toMatchObject({ entityType: null });
	});
	it.each([
		{ schemaVersion: 1 },
		{ schemaVersion: '2' },
		{ entityType: 'UNKNOWN' },
		{ kpp: '12345678' },
		{ kpp: '1234567890' },
		{ kpp: 123456789 },
		{ ogrn: '123456789012' },
		{ ogrn: '12345678901234' },
		{ ogrn: '1234567890123456' },
		{ ogrn: '123456789012x' },
		{ legalName: 'a'.repeat(2001) },
		{ legalAddress: 'a'.repeat(2001) },
		{ legalName: {} },
		{ legalAddress: [] },
		{ entityType: ['LEGAL'] },
		{ website: 'https://user:password@example.test' },
		{ phone: '+79000000001' },
		{ createdBySubject: 'injected' }
	])('rejects invalid v2 payload %j', override => {
		return expect(
			body({ ...company, ...override })
		).rejects.toBeInstanceOf(BadRequestException);
	});
	it('bounds text at 2000 and rejects missing/invalid CAS versions', async () => {
		await expect(
			body({
				...company,
				legalName: 'a'.repeat(2000),
				legalAddress: 'я'.repeat(2000)
			})
		).resolves.toBeDefined();
		for (const expectedVersion of [undefined, 0, 2_147_483_647, '1']) {
			await expect(
				body({ ...company, expectedVersion }, UpdateCompanyV2Dto)
			).rejects.toBeInstanceOf(BadRequestException);
		}
		await expect(
			body({ ...company, expectedVersion: 1 }, UpdateCompanyV2Dto)
		).resolves.toMatchObject({ expectedVersion: 1 });
	});
	it('retains strict v1 body shape and isolates archive schema', async () => {
		await expect(
			body({ ...company, schemaVersion: 1 }, CreateCompanyDto)
		).rejects.toBeInstanceOf(BadRequestException);
		const archive = {
			schemaVersion: 2,
			workspaceId: company.workspaceId,
			commandId: company.commandId,
			expectedVersion: 1
		};
		await expect(
			pipe.transform(archive, {
				type: 'body',
				metatype: ArchiveCompanyV2Dto
			})
		).resolves.toMatchObject(archive);
		await expect(
			pipe.transform(
				{ ...archive, schemaVersion: 1 },
				{ type: 'body', metatype: ArchiveCompanyV2Dto }
			)
		).rejects.toBeInstanceOf(BadRequestException);
	});
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
