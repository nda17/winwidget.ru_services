import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Headers,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Post,
	Put,
	Query
} from '@nestjs/common';
import { CustomersAuthorizationClient } from '../access/customers-authorization.client';
import {
	ArchiveCustomerDto,
	CreateCompanyDto,
	CreateContactDto,
	CustomerDuplicateQuery,
	CustomerListQuery,
	CustomerWorkspaceQuery,
	UpdateCompanyDto,
	UpdateContactDto
} from './customers.dto';
import { CustomersService } from './customers.service';

@Controller('crm/customers')
export class CustomersController {
	constructor(
		private readonly authorization: CustomersAuthorizationClient,
		private readonly customers: CustomersService
	) {}

	@Get('contacts')
	async contacts(
		@Headers('authorization') bearer: string | undefined,
		@Query() query: CustomerListQuery
	) {
		return this.customers.list(
			'contact',
			await this.authorization.authorize(bearer, query.workspaceId),
			query
		);
	}

	@Get('companies')
	async companies(
		@Headers('authorization') bearer: string | undefined,
		@Query() query: CustomerListQuery
	) {
		return this.customers.list(
			'company',
			await this.authorization.authorize(bearer, query.workspaceId),
			query
		);
	}

	@Get('contacts/duplicates')
	async duplicates(
		@Headers('authorization') bearer: string | undefined,
		@Query() query: CustomerDuplicateQuery
	) {
		return this.customers.duplicates(
			await this.authorization.authorize(bearer, query.workspaceId),
			query
		);
	}

	@Get('contacts/:id')
	async contact(
		@Headers('authorization') bearer: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() query: CustomerWorkspaceQuery
	) {
		return this.customers.get(
			'contact',
			await this.authorization.authorize(bearer, query.workspaceId),
			id,
			query.workspaceId
		);
	}

	@Get('companies/:id')
	async company(
		@Headers('authorization') bearer: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() query: CustomerWorkspaceQuery
	) {
		return this.customers.get(
			'company',
			await this.authorization.authorize(bearer, query.workspaceId),
			id,
			query.workspaceId
		);
	}

	@Get('contacts/:id/activities')
	async contactActivities(
		@Headers('authorization') bearer: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() query: CustomerListQuery
	) {
		return this.customers.activities(
			'contact',
			await this.authorization.authorize(bearer, query.workspaceId),
			id,
			query
		);
	}

	@Get('companies/:id/activities')
	async companyActivities(
		@Headers('authorization') bearer: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() query: CustomerListQuery
	) {
		return this.customers.activities(
			'company',
			await this.authorization.authorize(bearer, query.workspaceId),
			id,
			query
		);
	}

	@Post('contacts')
	@HttpCode(200)
	async createContact(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: CreateContactDto
	) {
		this.assertIdempotency(key, dto.commandId);
		return this.customers.create(
			'contact',
			await this.authorization.authorize(bearer, dto.workspaceId),
			dto
		);
	}

	@Post('companies')
	@HttpCode(200)
	async createCompany(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: CreateCompanyDto
	) {
		this.assertIdempotency(key, dto.commandId);
		return this.customers.create(
			'company',
			await this.authorization.authorize(bearer, dto.workspaceId),
			dto
		);
	}

	@Put('contacts/:id')
	async updateContact(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: UpdateContactDto
	) {
		this.assertIdempotency(key, dto.commandId);
		return this.customers.update(
			'contact',
			await this.authorization.authorize(bearer, dto.workspaceId),
			id,
			dto
		);
	}

	@Put('companies/:id')
	async updateCompany(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: UpdateCompanyDto
	) {
		this.assertIdempotency(key, dto.commandId);
		return this.customers.update(
			'company',
			await this.authorization.authorize(bearer, dto.workspaceId),
			id,
			dto
		);
	}

	@Post('contacts/:id/archive')
	@HttpCode(200)
	async archiveContact(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: ArchiveCustomerDto
	) {
		this.assertIdempotency(key, dto.commandId);
		return this.customers.archive(
			'contact',
			await this.authorization.authorize(bearer, dto.workspaceId),
			id,
			dto
		);
	}

	@Post('companies/:id/archive')
	@HttpCode(200)
	async archiveCompany(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: ArchiveCustomerDto
	) {
		this.assertIdempotency(key, dto.commandId);
		return this.customers.archive(
			'company',
			await this.authorization.authorize(bearer, dto.workspaceId),
			id,
			dto
		);
	}

	private assertIdempotency(key: string | undefined, commandId: string) {
		if (key !== commandId)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
	}
}
