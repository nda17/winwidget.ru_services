import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Headers,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
	Query,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { BillingInternalGuard } from '../auth/billing-internal.guard';
import { InternalCommandsService } from '../domain/internal-commands.service';
import { BillingMessagingAdminService } from '../domain/billing-messaging-admin.service';
import {
	BillingFailureCloseCommandDto,
	BillingFailureCommandDto,
	EnsureTrialCommandDto,
	RevokeEntitlementsCommandDto,
	UpdateBillingSettingsCommandDto
} from './billing.dto';

@Controller('internal/v1/billing')
@UseGuards(BillingInternalGuard)
@UsePipes(
	new ValidationPipe({
		whitelist: true,
		forbidNonWhitelisted: true,
		transform: true
	})
)
export class BillingInternalController {
	constructor(
		private readonly commands: InternalCommandsService,
		private readonly messaging: BillingMessagingAdminService
	) {}

	@Post('users/revoke-entitlements')
	@HttpCode(200)
	revoke(
		@Body() dto: RevokeEntitlementsCommandDto,
		@Headers('idempotency-key') idempotencyKey?: string
	) {
		this.assertIdempotencyKey(idempotencyKey, dto.commandId);
		return this.commands.revokeBeforeDeactivate(dto);
	}

	@Post('trials/ensure')
	@HttpCode(200)
	ensureTrial(
		@Body() dto: EnsureTrialCommandDto,
		@Headers('idempotency-key') idempotencyKey?: string
	) {
		this.assertIdempotencyKey(idempotencyKey, dto.commandId);
		return this.commands.ensureTrial(dto);
	}

	@Get('settings')
	@HttpCode(200)
	getSettings() {
		return this.commands.getSettings();
	}

	@Patch('settings')
	@HttpCode(200)
	updateSettings(
		@Body() dto: UpdateBillingSettingsCommandDto,
		@Headers('idempotency-key') idempotencyKey?: string
	) {
		this.assertIdempotencyKey(idempotencyKey, dto.commandId);
		return this.commands.updateSettings(dto);
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
