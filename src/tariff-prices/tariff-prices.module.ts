import { TariffPricesController } from '@/tariff-prices/tariff-prices.controller';
import { TariffPricesService } from '@/tariff-prices/tariff-prices.service';
import { Module } from '@nestjs/common';

@Module({
	controllers: [TariffPricesController],
	providers: [TariffPricesService],
	exports: [TariffPricesService]
})
export class TariffPricesModule {}
