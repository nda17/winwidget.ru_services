import {
	Body,
	Controller,
	Get,
	Header,
	Param,
	ParseUUIDPipe,
	Put,
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
	TaskNotificationReadDto,
	TaskNotificationsQuery
} from './task-notifications.dto';
import { TaskNotificationsService } from './task-notifications.service';

@Controller('crm/sales/notifications')
@UseGuards(SalesAccessGuard)
export class TaskNotificationsController {
	constructor(private readonly service: TaskNotificationsService) {}
	@Get()
	@SalesPermission('sales:read')
	@Header('Cache-Control', 'no-store')
	list(
		@Query() query: TaskNotificationsQuery,
		@Req() request: SalesRequest
	) {
		return this.service.list(
			request.salesAccess,
			query,
			request.headers.authorization!
		);
	}
	// A reading preference, not a task/business write: also available in READ_ONLY.
	@Put(':id/read')
	@SalesPermission('sales:read')
	@Header('Cache-Control', 'no-store')
	read(
		@Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
		@Body() dto: TaskNotificationReadDto,
		@Req() request: SalesRequest
	) {
		return this.service.setRead(
			request.salesAccess,
			id,
			dto,
			request.headers.authorization!
		);
	}
}
