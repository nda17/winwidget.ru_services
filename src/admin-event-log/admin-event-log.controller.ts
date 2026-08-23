import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { Controller, Get, HttpCode, Query } from '@nestjs/common';

@Controller('admin-event-log')
@Auth('ADMIN')
export class AdminEventLogController {
	constructor(
		private readonly adminEventLogService: AdminEventLogService
	) {}

	@HttpCode(200)
	@Get()
	async getAll(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('userId') userId?: string,
		@Query('adminId') adminId?: string,
		@Query('section') section?: string,
		@Query('action') action?: string,
		@Query('createdFrom') createdFrom?: string,
		@Query('createdTo') createdTo?: string
	) {
		return this.adminEventLogService.getAll(
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
