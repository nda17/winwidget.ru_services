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
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Auth, CurrentUser, IdentityAuthGuard } from '../auth/auth.guard';
import {
	IdentityInternalGuard,
	InternalServices
} from '../internal/internal.guard';
import {
	AcceptWorkspaceInvitationDto,
	CreateWorkspaceInvitationDto,
	RevokeWorkspaceInvitationDto,
	WorkspaceInvitationScopeDto,
	WorkspaceInvitationDeliveryContextDto
} from './workspace-invitation.dto';
import { WorkspaceInvitationService } from './workspace-invitation.service';

const exact = new ValidationPipe({
	transform: true,
	whitelist: true,
	forbidNonWhitelisted: true
});
const uuid = new ParseUUIDPipe({ version: '4' });
const commandHeader = (header: string | undefined, id: string) => {
	if (header !== id)
		throw new BadRequestException('Idempotency-Key must match commandId');
};

@Controller('workspace-invitations')
@UseGuards(IdentityAuthGuard)
@UsePipes(exact)
export class WorkspaceInvitationController {
	constructor(private readonly invitations: WorkspaceInvitationService) {}

	@Get(':id')
	@Auth()
	@Header('Cache-Control', 'no-store')
	preview(
		@Param('id', uuid) id: string,
		@CurrentUser('id') subject: string
	) {
		return this.invitations.preview(id, subject);
	}

	@Post(':id/accept')
	@Auth()
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	accept(
		@Param('id', uuid) id: string,
		@CurrentUser('id') subject: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: AcceptWorkspaceInvitationDto
	) {
		commandHeader(key, dto.commandId);
		return this.invitations.accept(id, subject, dto);
	}
}

@Controller('internal/v1/notification-delivery/wincrm-invitations')
@UseGuards(IdentityInternalGuard)
@InternalServices('notification-delivery')
@UsePipes(exact)
export class WorkspaceInvitationDeliveryController {
	constructor(private readonly invitations: WorkspaceInvitationService) {}
	@Post(':id/delivery-context')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	context(
		@Param('id', uuid) id: string,
		@Body() dto: WorkspaceInvitationDeliveryContextDto
	) {
		return this.invitations.deliveryContext(
			id,
			dto.workspaceId,
			dto.eventId
		);
	}
}

@Controller('internal/v1/crm-access/invitations')
@UseGuards(IdentityInternalGuard)
@InternalServices('crm-access')
@UsePipes(exact)
export class WorkspaceInvitationInternalController {
	constructor(private readonly invitations: WorkspaceInvitationService) {}

	@Post()
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	create(
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: CreateWorkspaceInvitationDto
	) {
		commandHeader(key, dto.commandId);
		return this.invitations.create(dto);
	}

	@Post(':id/revoke')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	revoke(
		@Param('id', uuid) id: string,
		@Headers('idempotency-key') key: string | undefined,
		@Body() dto: RevokeWorkspaceInvitationDto
	) {
		commandHeader(key, dto.commandId);
		return this.invitations.revoke(id, dto);
	}

	@Post(':id/acceptance-context')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	context(
		@Param('id', uuid) id: string,
		@Body() dto: WorkspaceInvitationScopeDto
	) {
		return this.invitations.acceptanceContext(id, dto.workspaceId);
	}
}
