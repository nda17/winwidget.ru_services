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
	IntakeWorkspaceQuery,
	VersionedIntakeCommandDto
} from '../intake/intake.dto';
import { AcceptInboxDto } from './acceptance.contract';
import { AcceptanceService } from './acceptance.service';

@Controller('crm/intake/inbox')
export class AcceptanceController {
	constructor(
		private readonly authorization: IntakeAuthorizationClient,
		private readonly acceptance: AcceptanceService
	) {}
	@Get(':id/acceptance') async get(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() query: IntakeWorkspaceQuery,
		@Headers('authorization') token?: string
	) {
		return this.acceptance.get(
			await this.authorization.authorize(token, query.workspaceId),
			id,
			query.workspaceId
		);
	}
	@Post(':id/accept') @HttpCode(202) async accept(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: AcceptInboxDto,
		@Headers('authorization') token?: string,
		@Headers('idempotency-key') key?: string
	) {
		this.key(dto.commandId, key);
		return this.acceptance.accept(
			await this.authorization.authorize(token, dto.workspaceId),
			id,
			dto
		);
	}
	@Post(':id/acceptance/retry') @HttpCode(202) async retry(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: VersionedIntakeCommandDto,
		@Headers('authorization') token?: string,
		@Headers('idempotency-key') key?: string
	) {
		this.key(dto.commandId, key);
		return this.acceptance.retry(
			await this.authorization.authorize(token, dto.workspaceId),
			id,
			dto
		);
	}
	@Post(':id/acceptance/recover') @HttpCode(202) async recover(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: VersionedIntakeCommandDto,
		@Headers('authorization') token?: string,
		@Headers('idempotency-key') key?: string
	) {
		this.key(dto.commandId, key);
		return this.acceptance.retry(
			await this.authorization.authorize(token, dto.workspaceId),
			id,
			dto,
			true
		);
	}
	private key(commandId: string, key?: string) {
		if (commandId !== key)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
	}
}
