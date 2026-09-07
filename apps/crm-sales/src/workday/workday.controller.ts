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
	Query,
	Req,
	UseGuards
} from '@nestjs/common';
import {
	SalesAccessGuard,
	SalesPermission,
	type SalesRequest
} from '../sales/sales-access';
import { SalesListQuery, WorkspaceQuery } from '../sales/sales.dto';
import {
	AssignWorkdayTaskDto,
	CreateWorkdayTaskDto,
	EditWorkdayTaskDto,
	SetTaskStatusDto,
	WorkdayQuery
} from './workday.dto';
import { WorkdayService } from './workday.service';

@Controller('crm/sales/workday/tasks')
@UseGuards(SalesAccessGuard)
export class WorkdayController {
	constructor(private readonly service: WorkdayService) {}
	@Get()
	@SalesPermission('sales:read')
	list(@Query() query: WorkdayQuery, @Req() request: SalesRequest) {
		return this.service.list(request.salesAccess, query);
	}
	@Get(':id')
	@SalesPermission('sales:read')
	detail(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() _query: WorkspaceQuery,
		@Req() request: SalesRequest
	) {
		return this.service.detail(request.salesAccess, id);
	}
	@Get(':id/timeline')
	@SalesPermission('sales:read')
	timeline(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() query: SalesListQuery,
		@Req() request: SalesRequest
	) {
		return this.service.timeline(request.salesAccess, id, query);
	}
	@Post()
	@HttpCode(200)
	@SalesPermission('sales:write')
	create(
		@Body() dto: CreateWorkdayTaskDto,
		@Req() request: SalesRequest,
		@Headers('idempotency-key') key?: string
	) {
		this.key(dto.commandId, key);
		return this.service.create(
			request.salesAccess,
			dto,
			request.headers.authorization!
		);
	}
	@Post(':id/edit')
	@HttpCode(200)
	@SalesPermission('sales:write')
	edit(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: EditWorkdayTaskDto,
		@Req() request: SalesRequest,
		@Headers('idempotency-key') key?: string
	) {
		this.key(dto.commandId, key);
		return this.service.edit(
			request.salesAccess,
			id,
			dto,
			request.headers.authorization!
		);
	}
	@Post(':id/status')
	@HttpCode(200)
	@SalesPermission('sales:write')
	status(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: SetTaskStatusDto,
		@Req() request: SalesRequest,
		@Headers('idempotency-key') key?: string
	) {
		this.key(dto.commandId, key);
		return this.service.status(
			request.salesAccess,
			id,
			dto,
			request.headers.authorization!
		);
	}
	@Post(':id/assignee')
	@HttpCode(200)
	@SalesPermission('sales:write')
	assign(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: AssignWorkdayTaskDto,
		@Req() request: SalesRequest,
		@Headers('idempotency-key') key?: string
	) {
		this.key(dto.commandId, key);
		return this.service.assign(
			request.salesAccess,
			id,
			dto,
			request.headers.authorization!
		);
	}
	private key(id: string, key: string | undefined) {
		if (key !== id)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
	}
}
