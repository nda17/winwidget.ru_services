import { BillingPeriod, Plan } from '@prisma/client';
import {
	IsBoolean,
	IsDateString,
	IsEnum,
	IsOptional,
	IsString
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
