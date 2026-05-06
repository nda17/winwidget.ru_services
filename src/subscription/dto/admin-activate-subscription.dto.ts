import { BillingPeriod, Plan } from '@prisma/client';
import {
	IsBoolean,
	IsDateString,
	IsEnum,
	IsIn,
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

export const ADMIN_BONUS_AUDIENCES = [
	'SINGLE',
	'ACTIVE_SUBSCRIPTION',
	'INACTIVE_SUBSCRIPTION',
	'ALL'
] as const;

export type AdminBonusAudience = (typeof ADMIN_BONUS_AUDIENCES)[number];

export class AdminExtendSubscriptionDto {
	@IsOptional()
	@IsString()
	userId?: string;

	@IsOptional()
	@IsIn([...ADMIN_BONUS_AUDIENCES])
	audience?: AdminBonusAudience;

	@IsInt()
	@Min(1)
	@Max(3650)
	days: number;
}
