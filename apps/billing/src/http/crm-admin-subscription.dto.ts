import { Transform, Type } from 'class-transformer';
import {
	Equals,
	IsInt,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	MinLength,
	ValidateIf
} from 'class-validator';

export class CrmAdminSubscriptionPageDto {
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(1_000_000)
	page = 1;

	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	pageSize = 20;
}

export class CrmAdminSubscriptionListDto extends CrmAdminSubscriptionPageDto {
	@IsOptional()
	@IsUUID('4')
	workspaceId?: string;

	@IsOptional()
	@IsString()
	@Matches(/^\S+$/)
	@MaxLength(256)
	ownerSubject?: string;
}

export class ExtendCrmSubscriptionDaysDto {
	@Equals(1)
	schemaVersion!: 1;

	@IsUUID('4')
	commandId!: string;

	@IsString()
	@Matches(/^\S+$/)
	@MaxLength(256)
	expectedActorSubject!: string;

	@IsString()
	@Matches(/^[1-9][0-9]{0,18}$/)
	expectedEntitlementVersion!: string;

	@IsString()
	@Matches(/^(0|[1-9][0-9]{0,18})$/)
	expectedBillingVersion!: string;

	@ValidateIf((_object, value) => value !== null)
	@IsUUID('4')
	expectedPeriodId!: string | null;

	@ValidateIf((_object, value) => value !== null)
	@IsInt()
	@Min(1)
	@Max(2_147_483_646)
	expectedPeriodVersion!: number | null;

	@IsInt()
	@Min(1)
	@Max(3650)
	days!: number;

	@Transform(({ value }) =>
		typeof value === 'string' ? value.trim() : value
	)
	@IsString()
	@MinLength(3)
	@MaxLength(1000)
	reason!: string;
}

export class CancelCrmSubscriptionGrantDto {
	@Equals(1)
	schemaVersion!: 1;

	@IsString()
	@Matches(/^\S+$/)
	@MaxLength(256)
	expectedActorSubject!: string;
}
