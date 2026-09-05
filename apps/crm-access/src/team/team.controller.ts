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
import {
	ChangeRoleDto,
	CreateInvitationDto,
	CreateTeamDto,
	SetMemberTeamsDto,
	TeamQueryDto,
	UpdateTeamDto,
	VersionedTeamCommandDto
} from './team.dto';
import { CrmTeamService } from './team.service';

const uuid = new ParseUUIDPipe({ version: '4' });
const key = (header: string | undefined, commandId: string) => {
	if (header !== commandId)
		throw new BadRequestException('Idempotency-Key must match commandId');
};

@Controller('crm/access/team')
export class CrmTeamController {
	constructor(private readonly team: CrmTeamService) {}
	@Get('deliveries')
	@Header('Cache-Control', 'no-store')
	deliveries(
		@Headers('authorization') token: string | undefined,
		@Query() query: TeamQueryDto
	) {
		return this.team.deliveries(token, query);
	}
	@Post('deliveries/:id/retry')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	retry(
		@Headers('authorization') token: string | undefined,
		@Headers('idempotency-key') commandKey: string | undefined,
		@Param('id', uuid) id: string,
		@Body() dto: VersionedTeamCommandDto
	) {
		key(commandKey, dto.commandId);
		return this.team.retryDelivery(token, id, dto);
	}
	@Get('members')
	@Header('Cache-Control', 'no-store')
	members(
		@Headers('authorization') token: string | undefined,
		@Query() query: TeamQueryDto
	) {
		return this.team.members(token, query);
	}
	@Get('teams')
	@Header('Cache-Control', 'no-store')
	teams(
		@Headers('authorization') token: string | undefined,
		@Query() query: TeamQueryDto
	) {
		return this.team.teams(token, query);
	}
	@Get('invitations')
	@Header('Cache-Control', 'no-store')
	invitations(
		@Headers('authorization') token: string | undefined,
		@Query() query: TeamQueryDto
	) {
		return this.team.invitations(token, query);
	}

	@Post('teams')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	createTeam(
		@Headers('authorization') token: string | undefined,
		@Headers('idempotency-key') commandKey: string | undefined,
		@Body() dto: CreateTeamDto
	) {
		key(commandKey, dto.commandId);
		return this.team.createTeam(token, dto);
	}
	@Post('teams/:id/rename')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	renameTeam(
		@Headers('authorization') token: string | undefined,
		@Headers('idempotency-key') commandKey: string | undefined,
		@Param('id', uuid) id: string,
		@Body() dto: UpdateTeamDto
	) {
		key(commandKey, dto.commandId);
		return this.team.updateTeam(token, id, dto);
	}
	@Post('teams/:id/archive')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	archiveTeam(
		@Headers('authorization') token: string | undefined,
		@Headers('idempotency-key') commandKey: string | undefined,
		@Param('id', uuid) id: string,
		@Body() dto: VersionedTeamCommandDto
	) {
		key(commandKey, dto.commandId);
		return this.team.archiveTeam(token, id, dto);
	}
	@Post('invitations')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	invite(
		@Headers('authorization') token: string | undefined,
		@Headers('idempotency-key') commandKey: string | undefined,
		@Body() dto: CreateInvitationDto
	) {
		key(commandKey, dto.commandId);
		return this.team.invite(token, dto);
	}
	@Post('invitations/:id/revoke')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	revoke(
		@Headers('authorization') token: string | undefined,
		@Headers('idempotency-key') commandKey: string | undefined,
		@Param('id', uuid) id: string,
		@Body() dto: VersionedTeamCommandDto
	) {
		key(commandKey, dto.commandId);
		return this.team.revokeInvitation(token, id, dto);
	}
	@Post('members/:id/change-role')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	changeRole(
		@Headers('authorization') token: string | undefined,
		@Headers('idempotency-key') commandKey: string | undefined,
		@Param('id', uuid) id: string,
		@Body() dto: ChangeRoleDto
	) {
		key(commandKey, dto.commandId);
		return this.team.changeRole(token, id, dto);
	}
	@Post('members/:id/set-teams')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	setTeams(
		@Headers('authorization') token: string | undefined,
		@Headers('idempotency-key') commandKey: string | undefined,
		@Param('id', uuid) id: string,
		@Body() dto: SetMemberTeamsDto
	) {
		key(commandKey, dto.commandId);
		return this.team.setTeams(token, id, dto);
	}
	@Post('members/:id/disable')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	disable(
		@Headers('authorization') token: string | undefined,
		@Headers('idempotency-key') commandKey: string | undefined,
		@Param('id', uuid) id: string,
		@Body() dto: VersionedTeamCommandDto
	) {
		key(commandKey, dto.commandId);
		return this.team.disable(token, id, dto);
	}
	@Post('members/:id/enable')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	enable(
		@Headers('authorization') token: string | undefined,
		@Headers('idempotency-key') commandKey: string | undefined,
		@Param('id', uuid) id: string,
		@Body() dto: VersionedTeamCommandDto
	) {
		key(commandKey, dto.commandId);
		return this.team.enable(token, id, dto);
	}
}
