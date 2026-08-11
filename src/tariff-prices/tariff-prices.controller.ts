import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { Auth } from '@/auth/decorators/auth.decorator';
import { CurrentUser } from '@/auth/decorators/user.decorator';
import { BillingLegacyRouteGuard } from '@/billing-boundary/billing-legacy-route.guard';
import { BillingLegacyWriteFenceInterceptor } from '@/billing-boundary/billing-legacy-write-fence.interceptor';
import { UpdateTariffPricesDto } from '@/tariff-prices/dto/update-tariff-prices.dto';
import { TariffPricesService } from '@/tariff-prices/tariff-prices.service';
import {
	Body,
	Controller,
	Get,
	HttpCode,
	Patch,
	Req,
	UsePipes,
	UseGuards,
	UseInterceptors,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';

@Controller('/tariff-prices')
@UseGuards(BillingLegacyRouteGuard)
@UseInterceptors(BillingLegacyWriteFenceInterceptor)
export class TariffPricesController {
	constructor(
		private readonly tariffPricesService: TariffPricesService,
		private readonly adminEventLogService: AdminEventLogService
	) {}

	@HttpCode(200)
	@Get()
	getAll() {
		return this.tariffPricesService.getAll();
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Patch()
	@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
	async update(
		@Body() dto: UpdateTariffPricesDto,
		@CurrentUser('id') adminId: string,
		@CurrentUser('rights') adminRights: Role[] = [],
		@Req() request: Request
	) {
		const result = await this.tariffPricesService.updateAll(dto, {
			id: adminId,
			role: adminRights.includes(Role.DEV) ? Role.DEV : Role.ADMIN
		});
		await this.adminEventLogService.record({
			adminId,
			section: 'PAYMENTS',
			action: 'TARIFF_PRICES_UPDATE',
			description:
				'Обновлены тарифные цены; новые суммы автопродления требуют подтверждения пользователей',
			entityType: 'tariff_prices',
			entityId: 'paid-plans',
			entityLabel: 'Цены платных тарифов',
			metadata: {
				prices: dto.prices.map(price => ({
					plan: price.plan,
					billingPeriod: price.billingPeriod,
					amount: price.amount
				}))
			},
			request
		});
		return result;
	}
}
