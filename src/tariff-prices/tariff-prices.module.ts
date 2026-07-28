import { AdminEventLogModule } from '@/admin-event-log/admin-event-log.module';
import { TariffPricesController } from '@/tariff-prices/tariff-prices.controller';
import { TariffPricesService } from '@/tariff-prices/tariff-prices.service';
import { Module } from '@nestjs/common';

@Module({
	imports: [AdminEventLogModule],
	controllers: [TariffPricesController],
	providers: [TariffPricesService],
	exports: [TariffPricesService]
})
export class TariffPricesModule {}
