import { Auth } from '@/auth/decorators/auth.decorator';
import { UpdateTariffPricesDto } from '@/tariff-prices/dto/update-tariff-prices.dto';
import { TariffPricesService } from '@/tariff-prices/tariff-prices.service';
import {
	Body,
	Controller,
	Get,
	HttpCode,
	Patch,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import { Role } from '@prisma/client';

@Controller('/tariff-prices')
export class TariffPricesController {
	constructor(private readonly tariffPricesService: TariffPricesService) {}

	@HttpCode(200)
	@Get()
	getAll() {
		return this.tariffPricesService.getAll();
	}

	@HttpCode(200)
	@Auth(Role.ADMIN)
	@Patch()
	@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
	update(@Body() dto: UpdateTariffPricesDto) {
		return this.tariffPricesService.updateAll(dto);
	}
}
