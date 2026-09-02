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
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { BillingCrmAccessGuard } from '../auth/billing-crm-access.guard';
import { CrmEntitlementService } from '../domain/crm-entitlement.service';
import { ActivateCrmTrialCommandDto } from './billing.dto';

@Controller('internal/v1/crm-access/billing')
@UseGuards(BillingCrmAccessGuard)
@UsePipes(
	new ValidationPipe({
		whitelist: true,
		forbidNonWhitelisted: true,
		transform: true
	})
)
export class BillingCrmAccessController {
	constructor(private readonly entitlements: CrmEntitlementService) {}

	@Get('entitlements/:workspaceId')
	@HttpCode(200)
	get(
		@Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
		workspaceId: string
	) {
		return this.entitlements.get(workspaceId);
	}

	@Post('entitlements/trial')
	@HttpCode(200)
	activateTrial(
		@Body() dto: ActivateCrmTrialCommandDto,
		@Headers('idempotency-key') idempotencyKey?: string
	) {
		if (idempotencyKey !== dto.commandId) {
			throw new BadRequestException(
				'idempotency-key must match commandId'
			);
		}
		return this.entitlements.activateTrial(dto);
	}
}
