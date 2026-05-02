import { BillingPeriod, Plan } from '@prisma/client';
import { IsEnum, IsString } from 'class-validator';

export class CreatePaymentDto {
	@IsEnum(Plan)
	plan: Plan;

	@IsEnum(BillingPeriod)
	billingPeriod: BillingPeriod;
}

export class AdminCheckPaymentDto {
	@IsString()
	paymentId: string;
}
