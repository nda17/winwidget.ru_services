import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Post,
	Query,
	Req,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import type { Request } from 'express';
import { WidgetsDeliveryFailuresService } from '../delivery-failures/widgets-delivery-failures.service';
import { requestCorrelationId } from '../http/widgets-http.util';
import { WidgetsMessagingOverviewService } from '../messaging/widgets-messaging-overview.service';
import { WidgetsAdminMonitoringService } from '../monitoring/widgets-admin-monitoring.service';
import {
	CloseDeliveryFailureActionDto,
	DeliveryFailureActionDto
} from './widgets-internal.controller';
import { WidgetsOperationsGuard } from './widgets-operations.guard';

@Controller('internal/v1/operations/widgets')
@UseGuards(WidgetsOperationsGuard)
@UsePipes(
	new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })
)
export class WidgetsOperationsController {
	constructor(
		private readonly monitoring: WidgetsAdminMonitoringService,
		private readonly failures: WidgetsDeliveryFailuresService,
		private readonly messagingOverview: WidgetsMessagingOverviewService
	) {}

	@Post('admin-alerts')
	@HttpCode(200)
	adminAlerts() {
		return this.monitoring.adminAlerts();
	}

	@Get('messaging-overview')
	@HttpCode(200)
	getMessagingOverview() {
		return this.messagingOverview.getOverview();
	}

	@Get('delivery-failures')
	@HttpCode(200)
	listDeliveryFailures(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('integration') integration?: string,
		@Query('category') category?: string,
		@Query('status') status?: string
	) {
		return this.failures.list(Number(page) || 1, Number(limit) || 20, {
			integration,
			category,
			status
		});
	}

	@Post('delivery-failures/:id/retry')
	@HttpCode(200)
	retryDeliveryFailure(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() dto: DeliveryFailureActionDto,
		@Req() request: Request
	) {
		return this.failures.retry(
			id,
			dto.actorId,
			requestCorrelationId(request)
		);
	}

	@Post('delivery-failures/:id/close')
	@HttpCode(200)
	closeDeliveryFailure(
		@Param('id', ParseUUIDPipe) id: string,
		@Body() dto: CloseDeliveryFailureActionDto,
		@Req() request: Request
	) {
		return this.failures.close(
			id,
			dto.actorId,
			dto.comment,
			requestCorrelationId(request)
		);
	}
}
