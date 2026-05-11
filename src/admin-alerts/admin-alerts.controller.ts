import { Auth } from '@/auth/decorators/auth.decorator';
import { Controller, Get, HttpCode, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AdminAlertsService } from './admin-alerts.service';

@Controller('admin-alerts')
@Auth(Role.ADMIN)
export class AdminAlertsController {
	constructor(private readonly adminAlertsService: AdminAlertsService) {}

	@HttpCode(200)
	@Get()
	getAll(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('type') type?: string,
		@Query('severity') severity?: string,
		@Query('search') search?: string
	) {
		return this.adminAlertsService.getAll(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20,
			{ type, severity, search }
		);
	}
}
