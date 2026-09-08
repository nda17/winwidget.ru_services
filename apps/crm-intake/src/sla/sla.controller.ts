import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Header,
	Headers,
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
import { parseSlaCommand } from './sla.contract';
import { SlaService } from './sla.service';
import { IsString, Matches, MaxLength } from 'class-validator';

class SlaInboxStatusQuery extends IntakeWorkspaceQuery {
	@IsString()
	@MaxLength(3699)
	@Matches(/^[0-9a-f-]+(?:,[0-9a-f-]+)*$/i)
	entryIds!: string;
}

@Controller('crm/intake/sla')
export class SlaController {
	constructor(
		private readonly access: IntakeAuthorizationClient,
		private readonly service: SlaService
	) {}
	@Get('inbox-status')
	@Header('Cache-Control', 'no-store')
	async inboxStatus(
		@Headers('authorization') bearer: string | undefined,
		@Query() query: SlaInboxStatusQuery
	) {
		const ids = query.entryIds.split(',');
		if (
			ids.length > 100 ||
			new Set(ids).size !== ids.length ||
			!ids.every(id =>
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
					id
				)
			)
		)
			throw new BadRequestException('Invalid Intake SLA entry ids');
		return this.service.inboxStatus(
			await this.access.authorize(bearer, query.workspaceId),
			ids
		);
	}
	@Get('rule')
	@Header('Cache-Control', 'no-store')
	async read(
		@Headers('authorization') bearer: string | undefined,
		@Query() query: IntakeWorkspaceQuery
	) {
		return this.service.read(
			await this.access.authorize(bearer, query.workspaceId)
		);
	}
	@Post('rule')
	@Header('Cache-Control', 'no-store')
	async save(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Body() body: unknown
	) {
		const command = parseSlaCommand(body);
		if (key !== command.commandId)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
		return this.service.save(
			await this.access.authorize(bearer, command.workspaceId),
			command
		);
	}
	@Post('jobs/:id/retry')
	async retry(
		@Headers('authorization') bearer: string | undefined,
		@Headers('idempotency-key') key: string | undefined,
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() body: VersionedIntakeCommandDto
	) {
		if (key !== body.commandId)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
		return this.service.retry(
			await this.access.authorize(bearer, body.workspaceId),
			id,
			body.commandId,
			body.expectedVersion
		);
	}
}
