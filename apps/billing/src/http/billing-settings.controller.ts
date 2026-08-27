import {
	Body,
	Controller,
	Get,
	HttpCode,
	Patch,
	Req,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import type { Request } from 'express';
import { BillingAuth, BillingAuthGuard } from '../auth/billing-auth.guard';
import { CurrentBillingActor } from '../auth/current-billing-actor.decorator';
import type { BillingActor } from '../auth/billing-request';
import { getBillingClientContext } from '../common/billing-request-context';
import { BillingSettingsService } from '../domain/billing-settings.service';
import { BillingSettingsPatchDto } from './billing.dto';

@Controller('billing-settings')
export class BillingSettingsController {
	constructor(private readonly service: BillingSettingsService) {}

	@Get('public')
	@HttpCode(200)
	publicSettings() {
		return this.service.publicSettings();
	}

	@Get('admin')
	@HttpCode(200)
	@BillingAuth(['ADMIN', 'DEV'])
	@UseGuards(BillingAuthGuard)
	adminSettings() {
		return this.service.adminSettings();
	}

	@Get('admin/provider-readiness')
	@HttpCode(200)
	@BillingAuth(['ADMIN', 'DEV'])
	@UseGuards(BillingAuthGuard)
	providerReadiness() {
		return this.service.providerReadiness();
	}

	@Patch('admin')
	@HttpCode(200)
	@BillingAuth(['ADMIN', 'DEV'])
	@UseGuards(BillingAuthGuard)
	@UsePipes(
		new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
			transform: true
		})
	)
	updateAdminSettings(
		@Body() dto: BillingSettingsPatchDto,
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		return this.service.updateAdminSettings(dto, {
			actor,
			...getBillingClientContext(request)
		});
	}
}
