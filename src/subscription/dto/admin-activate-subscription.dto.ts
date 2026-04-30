import { BillingPeriod, Plan } from '@prisma/client';
import {
	IsBoolean,
	IsDateString,
	IsEnum,
	IsInt,
	IsOptional,
	IsString,
	Max,
	Min
} from 'class-validator';

export class AdminActivateSubscriptionDto {
	@IsString()
	userId: string;

	@IsEnum(Plan)
	plan: Plan;

	@IsOptional()
	@IsEnum(BillingPeriod)
	billingPeriod?: BillingPeriod;

	@IsOptional()
	@IsDateString()
	startsAt?: string;

	@IsOptional()
	@IsBoolean()
	extendIfActive?: boolean;
}

export class AdminExtendSubscriptionDto {
	@IsString()
	userId: string;

	@IsInt()
	@Min(1)
	@Max(3650)
	days: number;
}
