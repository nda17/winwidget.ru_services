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
	ArchiveReminderRuleDto,
	CreateReminderRuleDto,
	EditReminderRuleDto,
	ReminderActorQuery,
	ReminderPageQuery,
	ReminderRulesQuery
} from './reminder-rules.dto';
import { ReminderRulesService } from './reminder-rules.service';

@Controller('crm/sales/reminder-rules')
@UseGuards(SalesAccessGuard)
export class ReminderRulesController {
	constructor(private readonly service: ReminderRulesService) {}
	@Get()
	@SalesPermission('sales:read')
	@Header('Cache-Control', 'no-store')
	list(@Query() query: ReminderRulesQuery, @Req() request: SalesRequest) {
		return this.service.list(
			request.salesAccess,
			query,
			request.headers.authorization!
		);
	}
	@Get(':id')
	@SalesPermission('sales:read')
	@Header('Cache-Control', 'no-store')
	detail(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() query: ReminderActorQuery,
		@Req() request: SalesRequest
	) {
		return this.service.detail(
			request.salesAccess,
			id,
			query,
			request.headers.authorization!
		);
	}
	@Get(':id/history')
	@SalesPermission('sales:read')
	@Header('Cache-Control', 'no-store')
	history(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Query() query: ReminderPageQuery,
		@Req() request: SalesRequest
	) {
		return this.service.history(
			request.salesAccess,
			id,
			query,
			request.headers.authorization!
		);
	}
	@Post()
	@HttpCode(200)
	@SalesPermission('sales:write')
	@Header('Cache-Control', 'no-store')
	create(
		@Body() dto: CreateReminderRuleDto,
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
	@Header('Cache-Control', 'no-store')
	edit(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: EditReminderRuleDto,
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
	@Post(':id/archive')
	@HttpCode(200)
	@SalesPermission('sales:write')
	@Header('Cache-Control', 'no-store')
	archive(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: ArchiveReminderRuleDto,
		@Req() request: SalesRequest,
		@Headers('idempotency-key') key?: string
	) {
		this.key(dto.commandId, key);
		return this.service.archive(
			request.salesAccess,
			id,
			dto,
			request.headers.authorization!
		);
	}
	private key(commandId: string, key?: string) {
		if (key !== commandId)
			throw new BadRequestException(
				'Idempotency-Key must match commandId'
			);
	}
}
