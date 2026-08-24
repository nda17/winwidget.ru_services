import {
	Controller,
	Get,
	HttpCode,
	Query,
	UseGuards
} from '@nestjs/common';
import {
	OperationsAuth,
	OperationsAuthGuard
} from '../auth/operations-auth.guard';
import { AdminEventLogService } from './admin-event-log.service';

@Controller('admin-event-log')
@OperationsAuth(['ADMIN'])
@UseGuards(OperationsAuthGuard)
export class AdminEventLogController {
	constructor(private readonly service: AdminEventLogService) {}

	@Get()
	@HttpCode(200)
	getAll(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('userId') userId?: string,
		@Query('adminId') adminId?: string,
		@Query('section') section?: string,
		@Query('action') action?: string,
		@Query('createdFrom') createdFrom?: string,
		@Query('createdTo') createdTo?: string
	) {
		return this.service.getAll(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20,
			{
				userId,
				adminId,
				section,
				action,
				createdFrom,
				createdTo
			}
		);
	}
}
