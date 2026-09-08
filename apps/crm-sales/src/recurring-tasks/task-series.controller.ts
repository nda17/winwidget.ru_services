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
import {
	CreateTaskSeriesDto,
	EditTaskSeriesDto,
	SetTaskSeriesStatusDto,
	TaskSeriesQuery
} from './task-series.dto';
import { TaskSeriesService } from './task-series.service';

@Controller('crm/sales/workday/task-series')
@UseGuards(SalesAccessGuard)
export class TaskSeriesController {
	constructor(private readonly service: TaskSeriesService) {}
	@Get()
	@SalesPermission('sales:read')
	list(@Query() query: TaskSeriesQuery, @Req() request: SalesRequest) {
		return this.service.list(request.salesAccess, query);
	}
	@Post()
	@HttpCode(200)
	@SalesPermission('sales:write')
	create(
		@Body() dto: CreateTaskSeriesDto,
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
		@Body() dto: EditTaskSeriesDto,
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
		@Body() dto: SetTaskSeriesStatusDto,
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
	private key(id: string, key: string | undefined) {
		if (key !== id)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
	}
}
