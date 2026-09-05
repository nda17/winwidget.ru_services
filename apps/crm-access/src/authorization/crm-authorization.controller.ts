import {
	Body,
	Controller,
	Get,
	ForbiddenException,
	Header,
	Headers,
	HttpCode,
	Post,
	Query,
	UseGuards
} from '@nestjs/common';
import {
	Equals,
	IsInt,
	IsUUID,
	IsString,
	Matches,
	MaxLength
} from 'class-validator';
import {
	CrmAuthorizationService,
	type CrmCaller
} from './crm-authorization.service';
import { CrmInternalGuard } from './crm-internal.guard';

export class CrmAuthorizeDto {
	@IsInt()
	@Equals(1)
	schemaVersion!: 1;
	@IsUUID('4')
	workspaceId!: string;
}

export class CrmPermissionsQueryDto {
	@IsUUID('4')
	workspaceId!: string;
}

export class CrmAuthorizeSourceDto extends CrmAuthorizeDto {
	@IsString()
	@MaxLength(256)
	@Matches(/^[^\s\x00-\x1f\x7f]{1,256}$/)
	subject!: string;
}

export class CrmAuthorizeWorkflowDto extends CrmAuthorizeSourceDto {
	@Equals('INTAKE_ACCEPT')
	purpose!: 'INTAKE_ACCEPT';
}

/** UI capabilities are advisory; every domain endpoint reauthorizes independently. */
@Controller('crm/access')
export class CrmPermissionsController {
	constructor(private readonly authorization: CrmAuthorizationService) {}

	@Get('permissions')
	@Header('Cache-Control', 'no-store')
	permissions(
		@Headers('authorization') token: string | undefined,
		@Query() query: CrmPermissionsQueryDto
	) {
		return this.authorization.authorize(token, query.workspaceId);
	}
}

@Controller('internal/v1/crm-access')
@UseGuards(CrmInternalGuard)
export class CrmAuthorizationController {
	constructor(private readonly authorization: CrmAuthorizationService) {}
	@Post('authorize-workflow')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	authorizeWorkflow(
		@Headers('x-winwidget-service') caller: CrmCaller,
		@Body() dto: CrmAuthorizeWorkflowDto
	) {
		return this.authorization.authorizeWorkflow(
			dto.workspaceId,
			dto.subject,
			dto.purpose,
			caller
		);
	}
	@Post('authorize')
	@HttpCode(200)
	authorize(
		@Headers('authorization') token: string | undefined,
		@Headers('x-winwidget-service') caller: CrmCaller,
		@Body() dto: CrmAuthorizeDto
	) {
		return this.authorization.authorize(token, dto.workspaceId, caller);
	}

	@Post('authorize-source')
	@HttpCode(200)
	authorizeSource(
		@Headers('x-winwidget-service') caller: CrmCaller,
		@Body() dto: CrmAuthorizeSourceDto
	) {
		if (caller !== 'crm-intake')
			throw new ForbiddenException(
				'Only CRM Intake can authorize a durable source'
			);
		return this.authorization.authorizeSource(
			dto.workspaceId,
			dto.subject
		);
	}
}
