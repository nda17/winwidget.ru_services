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
} from './sales-access';
import {
	CompleteTaskDto,
	CreateDealDto,
	DealListQuery,
	SalesListQuery,
	TransitionDealDto,
	VersionedSalesCommand,
	WorkspaceQuery
} from './sales.dto';
import { SalesService } from './sales.service';

@Controller('crm/sales')
@UseGuards(SalesAccessGuard)
export class SalesController {
	constructor(private readonly service: SalesService) {}

	@Get('pipelines')
	@SalesPermission('sales:read')
	pipelines(
		@Query() _query: WorkspaceQuery,
		@Req() request: SalesRequest
	) {
		return this.service.pipelines(request.salesAccess);
	}

	@Get('deals')
	@SalesPermission('sales:read')
	deals(@Query() query: DealListQuery, @Req() request: SalesRequest) {
		return this.service.deals(request.salesAccess, query);
	}

	@Get('deals/:id')
	@SalesPermission('sales:read')
	detail(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() _query: WorkspaceQuery,
		@Req() request: SalesRequest
	) {
		return this.service.detail(request.salesAccess, id);
	}

	@Get('deals/:id/timeline')
	@SalesPermission('sales:read')
	timeline(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() query: SalesListQuery,
		@Req() request: SalesRequest
	) {
		return this.service.timeline(request.salesAccess, id, query);
	}

	@Get('tasks')
	@SalesPermission('sales:read')
	tasks(@Query() query: SalesListQuery, @Req() request: SalesRequest) {
		return this.service.tasks(request.salesAccess, query);
	}

	@Get('analytics')
	@SalesPermission('sales:analytics')
	analytics(
		@Query() _query: WorkspaceQuery,
		@Req() request: SalesRequest
	) {
		return this.service.analytics(request.salesAccess);
	}

	@Post('deals')
	@HttpCode(200)
	@SalesPermission('sales:write')
	create(
		@Body() dto: CreateDealDto,
		@Req() request: SalesRequest,
		@Headers('idempotency-key') key?: string
	) {
		this.commandKey(dto.commandId, key);
		return this.service.create(
			request.salesAccess,
			dto,
			request.headers.authorization!
		);
	}

	@Post('deals/:id/transition')
	@HttpCode(200)
	@SalesPermission('sales:write')
	transition(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: TransitionDealDto,
		@Req() request: SalesRequest,
		@Headers('idempotency-key') key?: string
	) {
		this.commandKey(dto.commandId, key);
		return this.service.transition(request.salesAccess, id, dto);
	}

	@Post('tasks/:id/complete')
	@HttpCode(200)
	@SalesPermission('sales:write')
	complete(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: CompleteTaskDto,
		@Req() request: SalesRequest,
		@Headers('idempotency-key') key?: string
	) {
		this.commandKey(dto.commandId, key);
		return this.service.complete(request.salesAccess, id, dto);
	}

	@Post('deals/:id/archive')
	@HttpCode(200)
	@SalesPermission('sales:write')
	archive(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: VersionedSalesCommand,
		@Req() request: SalesRequest,
		@Headers('idempotency-key') key?: string
	) {
		this.commandKey(dto.commandId, key);
		return this.service.archive(request.salesAccess, id, dto);
	}

	private commandKey(commandId: string, key: string | undefined) {
		if (key !== commandId)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
	}
}
