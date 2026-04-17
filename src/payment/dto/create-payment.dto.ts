import { BillingPeriod, Plan } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class CreatePaymentDto {
	@IsEnum(Plan)
	plan: Plan;

	@IsEnum(BillingPeriod)
	billingPeriod: BillingPeriod;
}
