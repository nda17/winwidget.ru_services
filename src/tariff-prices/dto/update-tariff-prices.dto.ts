import { BillingPeriod, Plan } from '@prisma/client';
import { Type } from 'class-transformer';
import {
	IsArray,
	IsEnum,
	IsInt,
	Max,
	Min,
	ValidateNested
} from 'class-validator';

export class UpdateTariffPriceDto {
	@IsEnum(Plan)
	plan: Plan;

	@IsEnum(BillingPeriod)
	billingPeriod: BillingPeriod;

	@IsInt()
	@Min(1)
	@Max(10000000)
	amount: number;
}

export class UpdateTariffPricesDto {
	@IsArray()
	@ValidateNested({ each: true })
	@Type(() => UpdateTariffPriceDto)
	prices: UpdateTariffPriceDto[];
}
