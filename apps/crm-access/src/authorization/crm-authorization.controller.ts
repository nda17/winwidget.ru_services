import {
	Body,
	Controller,
	Get,
	Header,
	Headers,
	HttpCode,
	Post,
	Query,
	UseGuards
} from '@nestjs/common';
import { Equals, IsInt, IsUUID } from 'class-validator';
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
	@Post('authorize')
	@HttpCode(200)
	authorize(
		@Headers('authorization') token: string | undefined,
		@Headers('x-winwidget-service') caller: CrmCaller,
		@Body() dto: CrmAuthorizeDto
	) {
		return this.authorization.authorize(token, dto.workspaceId, caller);
	}
}
