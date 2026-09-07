import {
	Body,
	Controller,
	ForbiddenException,
	Get,
	Header,
	Headers,
	HttpCode,
	Post,
	Query,
	UseGuards
} from '@nestjs/common';
import { CrmInternalGuard } from '../authorization/crm-internal.guard';
import {
	AssigneeLabelsDto,
	AssigneeQueryDto,
	AuthorizeAssigneeDto
} from './team-assignee.dto';
import { CrmAssigneeService } from './team-assignee.service';

@Controller('crm/access/team')
export class CrmAssigneeController {
	constructor(private readonly assignees: CrmAssigneeService) {}
	@Get('assignees')
	@Header('Cache-Control', 'no-store')
	options(
		@Headers('authorization') token: string | undefined,
		@Query() query: AssigneeQueryDto
	) {
		return this.assignees.options(token, query);
	}
	@Post('assignee-labels')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	labels(
		@Headers('authorization') token: string | undefined,
		@Body() dto: AssigneeLabelsDto
	) {
		return this.assignees.labels(token, dto);
	}
}

@Controller('internal/v1/crm-access')
@UseGuards(CrmInternalGuard)
export class CrmAssigneeAuthorizationController {
	constructor(private readonly assignees: CrmAssigneeService) {}
	@Post('authorize-assignee')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	authorize(
		@Headers('x-winwidget-service') caller: string,
		@Headers('authorization') token: string | undefined,
		@Body() dto: AuthorizeAssigneeDto
	) {
		if (caller !== 'crm-sales')
			throw new ForbiddenException('Only Sales can authorize assignment');
		return this.assignees.authorize(token, dto);
	}
}
