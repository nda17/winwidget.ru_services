import {
	Body,
	Controller,
	Get,
	HttpCode,
	Patch,
	Query,
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
import { TariffAffiliateService } from '../domain/tariff-affiliate.service';
import { UpdateAffiliateSettingsDto } from './billing.dto';

@Controller('affiliate')
export class AffiliateController {
	constructor(private readonly service: TariffAffiliateService) {}
	@Get('public-settings') @HttpCode(200) settings() {
		return this.service.affiliateSettings();
	}
	@Get('me')
	@HttpCode(200)
	@BillingAuth()
	@UseGuards(BillingAuthGuard)
	me(
		@Query('page') page: string | undefined,
		@Query('limit') limit: string | undefined,
		@CurrentBillingActor() actor: BillingActor
	) {
		return this.service.myAffiliate(
			actor.subject,
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20
		);
	}
	@Get('admin/referrals')
	@HttpCode(200)
	@BillingAuth(['ADMIN'])
	@UseGuards(BillingAuthGuard)
	referrals(
		@Query('page') page?: string,
		@Query('limit') limit?: string,
		@Query('status') status?: string,
		@Query('search') search?: string
	) {
		return this.service.adminReferrals(
			page ? parseInt(page, 10) : 1,
			limit ? parseInt(limit, 10) : 20,
			status,
			search
		);
	}
	@Get('admin/settings')
	@HttpCode(200)
	@BillingAuth(['ADMIN'])
	@UseGuards(BillingAuthGuard)
	adminSettings() {
		return this.service.affiliateSettings();
	}
	@Patch('admin/settings')
	@HttpCode(200)
	@BillingAuth(['ADMIN'])
	@UseGuards(BillingAuthGuard)
	@UsePipes(new ValidationPipe({ whitelist: true }))
	update(
		@Body() dto: UpdateAffiliateSettingsDto,
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		return this.service.updateAffiliateSettings(dto, {
			id: actor.subject,
			role: actor.roles.includes('DEV') ? 'DEV' : 'ADMIN',
			...getBillingClientContext(request)
		});
	}
}
