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
import { OPERATIONS_SCALAR_QUERY_PIPE } from '../common/operations-request-context';
import { AdminAlertsService } from './admin-alerts.service';

@Controller('admin-alerts')
@OperationsAuth(['ADMIN'])
@UseGuards(OperationsAuthGuard)
export class AdminAlertsController {
	constructor(private readonly alerts: AdminAlertsService) {}

	@Get()
	@HttpCode(200)
	getAll(
		@Query('page', OPERATIONS_SCALAR_QUERY_PIPE) page?: string,
		@Query('limit', OPERATIONS_SCALAR_QUERY_PIPE) limit?: string,
		@Query('type', OPERATIONS_SCALAR_QUERY_PIPE) type?: string,
		@Query('severity', OPERATIONS_SCALAR_QUERY_PIPE) severity?: string,
		@Query('search', OPERATIONS_SCALAR_QUERY_PIPE) search?: string
	) {
		return this.alerts.getAll(
			page ? Number(page) : 1,
			limit ? Number(limit) : 20,
			{ type, severity, search }
		);
	}
}
