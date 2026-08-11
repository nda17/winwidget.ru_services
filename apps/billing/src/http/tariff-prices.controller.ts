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
import { TariffAffiliateService } from '../domain/tariff-affiliate.service';
import { UpdateTariffPricesDto } from './billing.dto';

@Controller('tariff-prices')
export class TariffPricesController {
	constructor(private readonly service: TariffAffiliateService) {}
	@Get() @HttpCode(200) getAll() {
		return this.service.tariffPrices();
	}
	@Patch()
	@HttpCode(200)
	@BillingAuth(['ADMIN'])
	@UseGuards(BillingAuthGuard)
	@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
	update(
		@Body() dto: UpdateTariffPricesDto,
		@CurrentBillingActor() actor: BillingActor,
		@Req() request: Request
	) {
		return this.service.updateTariffPrices(dto, {
			id: actor.subject,
			role: actor.roles.includes('DEV') ? 'DEV' : 'ADMIN',
			...getBillingClientContext(request)
		});
	}
}
