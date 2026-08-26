import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Headers,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Post,
	Query,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { BillingOperationsGuard } from '../auth/billing-operations.guard';
import { BillingAdminAlertsService } from '../domain/billing-admin-alerts.service';
import { BillingMessagingAdminService } from '../domain/billing-messaging-admin.service';
import {
	BillingFailureCloseCommandDto,
	BillingFailureCommandDto
} from './billing.dto';

@Controller('internal/v1/operations/billing')
@UseGuards(BillingOperationsGuard)
@UsePipes(
	new ValidationPipe({
		whitelist: true,
		forbidNonWhitelisted: true,
		transform: true
	})
)
export class BillingOperationsController {
	constructor(
		private readonly messaging: BillingMessagingAdminService,
		private readonly alerts: BillingAdminAlertsService
	) {}

	@Get('admin-alerts')
	@HttpCode(200)
	getAdminAlerts() {
		return this.alerts.getAlerts();
	}

	@Get('messaging/overview')
	@HttpCode(200)
	getMessagingOverview() {
		return this.messaging.overview();
	}

	@Get('messaging/failures')
	@HttpCode(200)
	getMessagingFailures(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('consumer') consumer?: string,
		@Query('category') category?: string,
		@Query('status') status?: string
	) {
		return this.messaging.list({
			page: page ? parseInt(page, 10) : 1,
			limit: limit ? parseInt(limit, 10) : 20,
			consumer,
			category,
			status
		});
	}

	@Post('messaging/failures/:id/retry')
	@HttpCode(200)
	retryMessagingFailure(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() dto: BillingFailureCommandDto,
		@Headers('idempotency-key') idempotencyKey?: string
	) {
		this.assertIdempotencyKey(idempotencyKey, dto.commandId);
		return this.messaging.retry(id, dto);
	}

	@Post('messaging/failures/:id/close')
	@HttpCode(200)
	closeMessagingFailure(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() dto: BillingFailureCloseCommandDto,
		@Headers('idempotency-key') idempotencyKey?: string
	) {
		this.assertIdempotencyKey(idempotencyKey, dto.commandId);
		return this.messaging.close(id, dto);
	}

	private assertIdempotencyKey(
		value: string | undefined,
		commandId: string
	): void {
		if (value !== commandId) {
			throw new BadRequestException(
				'idempotency-key must match commandId'
			);
		}
	}
}
