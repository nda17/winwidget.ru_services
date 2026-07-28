import { BillingPeriod, Plan } from '@prisma/client';
import {
	IsBoolean,
	IsEnum,
	IsInt,
	IsOptional,
	IsString,
	MaxLength,
	Min,
	MinLength
} from 'class-validator';

export class CreatePaymentDto {
	@IsEnum(Plan)
	plan: Plan;

	@IsEnum(BillingPeriod)
	billingPeriod: BillingPeriod;

	@IsInt()
	@Min(1)
	expectedAmount: number;

	@IsBoolean()
	@IsOptional()
	autoRenew?: boolean;

	@IsString()
	@MaxLength(100)
	@IsOptional()
	consentVersion?: string;
}

export class AdminCheckPaymentDto {
	@IsString()
	paymentId: string;
}

export class VerifyPaymentDto {
	@IsString()
	@IsOptional()
	paymentId?: string;
}

export class CancelPendingPaymentDto {
	@IsString()
	@MinLength(1)
	@MaxLength(100)
	paymentId: string;
}

export class AdminAutoRenewalActionDto {
	@IsString()
	@MinLength(3)
	@MaxLength(500)
	reason: string;
}
