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
import {
	ArrayMaxSize,
	ArrayMinSize,
	ArrayUnique,
	IsArray,
	IsString,
	Matches,
	MaxLength,
	MinLength
} from 'class-validator';
import type { Request } from 'express';
import { WidgetsDeliveryFailuresService } from '../delivery-failures/widgets-delivery-failures.service';
import { requestCorrelationId } from '../http/widgets-http.util';
import { WidgetsMessagingOverviewService } from '../messaging/widgets-messaging-overview.service';
import { WidgetsAdminMonitoringService } from '../monitoring/widgets-admin-monitoring.service';
import { WidgetsInternalGuard } from './widgets-internal.guard';

export class OwnerOverviewDto {
	@IsString()
	@MinLength(1)
	@MaxLength(255)
	userId!: string;
}

class OwnerUsageDto {
	@IsArray()
	@ArrayMinSize(1)
	@ArrayMaxSize(100)
	@ArrayUnique()
	@IsString({ each: true })
	@MinLength(1, { each: true })
	@MaxLength(255, { each: true })
	userIds!: string[];
}

export class DeliveryFailureActionDto {
	@IsString()
	@MinLength(1)
	@MaxLength(255)
	@Matches(/\S/)
	actorId!: string;
}

export class CloseDeliveryFailureActionDto extends DeliveryFailureActionDto {
	@IsString()
	@MinLength(3)
	@MaxLength(1000)
	comment!: string;
}

@Controller('internal/v1/widgets')
@UseGuards(WidgetsInternalGuard)
@UsePipes(
	new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })
)
export class WidgetsInternalController {
	constructor(
		private readonly monitoring: WidgetsAdminMonitoringService,
		private readonly failures: WidgetsDeliveryFailuresService,
		private readonly messagingOverview: WidgetsMessagingOverviewService
	) {}

	@Post('admin-owner-overview')
	@HttpCode(200)
	overview(@Body() dto: OwnerOverviewDto) {
		return this.monitoring.ownerOverview(dto.userId);
	}

	@Post('admin-alerts')
	@HttpCode(200)
	adminAlerts() {
		return this.monitoring.adminAlerts();
	}

	@Post('owner-usage')
	@HttpCode(200)
	ownerUsage(@Body() dto: OwnerUsageDto) {
		return this.monitoring.ownerUsage(dto.userIds);
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
