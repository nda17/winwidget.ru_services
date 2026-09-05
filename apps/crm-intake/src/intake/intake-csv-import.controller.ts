import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Header,
	Headers,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Post,
	Query
} from '@nestjs/common';
import { IntakeAuthorizationClient } from '../access/intake-authorization.client';
import { IntakeWorkspaceQuery } from './intake.dto';
import { ImportIntakeCsvDto } from './intake-csv-import.dto';
import { IntakeCsvImportService } from './intake-csv-import.service';

@Controller('crm/intake/imports')
export class IntakeCsvImportController {
	constructor(
		private readonly authorization: IntakeAuthorizationClient,
		private readonly imports: IntakeCsvImportService
	) {}

	@Post('csv')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	async create(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: ImportIntakeCsvDto
	) {
		if (key !== dto.commandId)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
		return this.imports.create(
			await this.authorization.authorize(bearer, dto.workspaceId),
			dto
		);
	}

	@Get(':id')
	@Header('Cache-Control', 'no-store')
	async get(
		@Headers('authorization') bearer: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() query: IntakeWorkspaceQuery
	) {
		return this.imports.get(
			await this.authorization.authorize(bearer, query.workspaceId),
			query.workspaceId,
			id
		);
	}
}
