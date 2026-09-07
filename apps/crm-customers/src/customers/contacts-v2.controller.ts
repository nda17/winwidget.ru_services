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
	ArchiveContactV2Dto,
	CreateContactV2Dto,
	CustomerDuplicateQuery,
	CustomerListQuery,
	CustomerWorkspaceQuery,
	UpdateContactV2Dto
} from './customers.dto';
import { CustomersService } from './customers.service';

@Controller('crm/customers/v2/contacts')
export class ContactsV2Controller {
	constructor(
		private readonly authorization: CustomersAuthorizationClient,
		private readonly customers: CustomersService
	) {}

	@Get()
	async list(
		@Headers('authorization') bearer: string | undefined,
		@Query() query: CustomerListQuery
	) {
		return this.customers.list(
			'contact',
			await this.authorization.authorize(bearer, query.workspaceId),
			query,
			2
		);
	}

	@Get('duplicates')
	async duplicates(
		@Headers('authorization') bearer: string | undefined,
		@Query() query: CustomerDuplicateQuery
	) {
		return this.customers.duplicates(
			await this.authorization.authorize(bearer, query.workspaceId),
			query,
			2
		);
	}

	@Get(':id')
	async get(
		@Headers('authorization') bearer: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() query: CustomerWorkspaceQuery
	) {
		return this.customers.get(
			'contact',
			await this.authorization.authorize(bearer, query.workspaceId),
			id,
			query.workspaceId,
			2
		);
	}

	@Get(':id/activities')
	async activities(
		@Headers('authorization') bearer: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() query: CustomerListQuery
	) {
		return this.customers.activities(
			'contact',
			await this.authorization.authorize(bearer, query.workspaceId),
			id,
			query,
			2
		);
	}

	@Post()
	@HttpCode(200)
	async create(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: CreateContactV2Dto
	) {
		this.assertIdempotency(key, dto.commandId);
		return this.customers.create(
			'contact',
			await this.authorization.authorize(bearer, dto.workspaceId),
			dto
		);
	}

	@Put(':id')
	async update(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: UpdateContactV2Dto
	) {
		this.assertIdempotency(key, dto.commandId);
		return this.customers.update(
			'contact',
			await this.authorization.authorize(bearer, dto.workspaceId),
			id,
			dto
		);
	}

	@Post(':id/archive')
	@HttpCode(200)
	async archive(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: ArchiveContactV2Dto
	) {
		this.assertIdempotency(key, dto.commandId);
		return this.customers.archive(
			'contact',
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
