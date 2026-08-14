import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Headers,
	HttpCode,
	Param,
	Post,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { BillingIdentityGuard } from '../auth/billing-identity.guard';
import { InternalCommandsService } from '../domain/internal-commands.service';
import {
	EnsureTrialCommandDto,
	RevokeEntitlementsCommandDto
} from './billing.dto';

@Controller('internal/v1/identity/billing')
@UseGuards(BillingIdentityGuard)
@UsePipes(
	new ValidationPipe({
		whitelist: true,
		forbidNonWhitelisted: true,
		transform: true
	})
)
export class BillingIdentityController {
	constructor(private readonly commands: InternalCommandsService) {}

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

	@Get('users/:userId/admin-overview')
	@HttpCode(200)
	getAdminUserOverview(@Param('userId') userId: string) {
		if (
			!userId ||
			userId.length > 256 ||
			/[\s\x00-\x1f\x7f]/.test(userId)
		) {
			throw new BadRequestException('Invalid userId');
		}
		return this.commands.getAdminUserOverview(userId);
	}

	@Get('directory/subscription-user-ids')
	@HttpCode(200)
	getSubscriptionUserIds() {
		return this.commands.getSubscriptionUserIds();
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
