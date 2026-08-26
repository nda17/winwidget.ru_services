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
import { AdminAlertsService } from './admin-alerts.service';

@Controller('admin-alerts')
@OperationsAuth(['ADMIN'])
@UseGuards(OperationsAuthGuard)
export class AdminAlertsController {
	constructor(private readonly alerts: AdminAlertsService) {}

	@Get()
	@HttpCode(200)
	getAll(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('type') type?: string,
		@Query('severity') severity?: string,
		@Query('search') search?: string
	) {
		return this.alerts.getAll(
			page ? Number(page) : 1,
			limit ? Number(limit) : 20,
			{ type, severity, search }
		);
	}
}
