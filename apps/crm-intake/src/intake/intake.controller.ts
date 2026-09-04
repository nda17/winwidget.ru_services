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
	Query
} from '@nestjs/common';
import { IntakeAuthorizationClient } from '../access/intake-authorization.client';
import {
	CreateInboxEntryDto,
	CreateIntakeSourceDto,
	InboxListQuery,
	IntakePageQuery,
	IntakeWorkspaceQuery,
	RejectInboxEntryDto,
	RotateIntakeSourceTokenDto,
	VersionedIntakeCommandDto
} from './intake.dto';
import { IntakeService } from './intake.service';

@Controller('crm/intake')
export class IntakeController {
	constructor(
		private readonly authorization: IntakeAuthorizationClient,
		private readonly intake: IntakeService
	) {}

	@Get('inbox')
	async list(
		@Headers('authorization') bearer: string | undefined,
		@Query() query: InboxListQuery
	) {
		return this.intake.list(
			await this.authorization.authorize(bearer, query.workspaceId),
			query
		);
	}
	@Get('inbox/:id')
	async get(
		@Headers('authorization') bearer: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() query: IntakeWorkspaceQuery
	) {
		return this.intake.get(
			await this.authorization.authorize(bearer, query.workspaceId),
			query.workspaceId,
			id
		);
	}
	@Get('inbox/:id/activities')
	async activities(
		@Headers('authorization') bearer: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() query: IntakePageQuery
	) {
		return this.intake.activities(
			await this.authorization.authorize(bearer, query.workspaceId),
			id,
			query
		);
	}
	@Post('inbox')
	@HttpCode(200)
	async create(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: CreateInboxEntryDto
	) {
		this.idempotency(key, dto.commandId);
		return this.intake.createManual(
			await this.authorization.authorize(bearer, dto.workspaceId),
			dto
		);
	}
	@Post('inbox/:id/reject')
	@HttpCode(200)
	async reject(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: RejectInboxEntryDto
	) {
		this.idempotency(key, dto.commandId);
		return this.intake.reject(
			await this.authorization.authorize(bearer, dto.workspaceId),
			id,
			dto
		);
	}
	@Get('sources')
	async sources(
		@Headers('authorization') bearer: string | undefined,
		@Query() query: IntakePageQuery
	) {
		return this.intake.listSources(
			await this.authorization.authorize(bearer, query.workspaceId),
			query
		);
	}
	@Post('sources')
	@HttpCode(200)
	async createSource(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: CreateIntakeSourceDto
	) {
		this.idempotency(key, dto.commandId);
		return this.intake.createSource(
			await this.authorization.authorize(bearer, dto.workspaceId),
			dto
		);
	}
	@Post('sources/:id/rotate-token')
	@HttpCode(200)
	async rotateSource(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: RotateIntakeSourceTokenDto
	) {
		this.idempotency(key, dto.commandId);
		return this.intake.rotateSource(
			await this.authorization.authorize(bearer, dto.workspaceId),
			id,
			dto
		);
	}
	@Post('sources/:id/revoke')
	@HttpCode(200)
	async revokeSource(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: VersionedIntakeCommandDto
	) {
		this.idempotency(key, dto.commandId);
		return this.intake.revokeSource(
			await this.authorization.authorize(bearer, dto.workspaceId),
			id,
			dto
		);
	}
	private idempotency(key: string | undefined, commandId: string) {
		if (key !== commandId)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
	}
}
