import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { Controller, Get, HttpCode, Query } from '@nestjs/common';
import { Role } from '@prisma/client';

@Controller('admin-event-log')
@Auth(Role.ADMIN)
export class AdminEventLogController {
	constructor(
		private readonly adminEventLogService: AdminEventLogService
	) {}

	@HttpCode(200)
	@Get()
	async getAll(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('userId') userId?: string
	) {
		return this.adminEventLogService.getAll(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20,
			userId
		);
	}
}
