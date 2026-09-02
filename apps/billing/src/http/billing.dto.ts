import { Type } from 'class-transformer';
import {
	IsArray,
	IsBoolean,
	IsDateString,
	Equals,
	IsEnum,
	IsIn,
	IsInt,
	IsOptional,
	IsString,
	IsUUID,
	Max,
	MaxLength,
	Matches,
	Min,
	MinLength,
	ValidateNested
} from 'class-validator';
import {
	BillingPeriod,
	Plan,
	SubscriptionBonusAudience
} from '@prisma/billing-client';

export class CreatePaymentDto {
	@IsEnum(Plan)
	plan!: Plan;

	@IsEnum(BillingPeriod)
	billingPeriod!: BillingPeriod;

	@IsInt()
	@Min(1)
	expectedAmount!: number;

	@IsOptional()
	@IsBoolean()
	autoRenew?: boolean;

	@IsOptional()
	@IsString()
	@MaxLength(100)
	consentVersion?: string;
}

export class VerifyPaymentDto {
	@IsOptional()
	@IsString()
	paymentId?: string;
}

export class CancelPaymentDto {
	@IsString()
	@MinLength(1)
	@MaxLength(100)
	paymentId!: string;
}

export class AdminPaymentCheckDto {
	@IsString()
	paymentId!: string;
}

export class DevResolveUnknownProviderPaymentDto {
	@IsInt()
	@Equals(1)
	schemaVersion!: number;

	@IsUUID()
	commandId!: string;

	@IsString()
	@MinLength(1)
	@MaxLength(100)
	paymentId!: string;

	@IsIn(['PROVIDER_PAYMENT_NOT_FOUND'])
	resolution!: 'PROVIDER_PAYMENT_NOT_FOUND';

	@IsString()
	@MinLength(3)
	@MaxLength(1000)
	reason!: string;

	@IsBoolean()
	@Equals(true)
	providerReconciliationConfirmed!: true;

	@IsString()
	@MinLength(1)
	@MaxLength(100)
	checkedMetadataPaymentId!: string;

	@IsString()
	@MinLength(1)
	@MaxLength(128)
	checkedProviderIdempotencyKey!: string;
}

export class AdminAutoRenewalActionDto {
	@IsString()
	@MinLength(3)
	@MaxLength(500)
	reason!: string;
}

export class AdminActivateSubscriptionDto {
	@IsString()
	userId!: string;

	@IsEnum(Plan)
	plan!: Plan;

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
	@IsOptional()
	@IsString()
	userId?: string;

	@IsOptional()
	@IsIn(Object.values(SubscriptionBonusAudience))
	audience?: SubscriptionBonusAudience;

	@IsInt()
	@Min(1)
	@Max(3650)
	days!: number;
}

export class TariffPriceItemDto {
	@IsEnum(Plan)
	plan!: Plan;

	@IsEnum(BillingPeriod)
	billingPeriod!: BillingPeriod;

	@IsInt()
	@Min(1)
	@Max(10_000_000)
	amount!: number;
}

export class UpdateTariffPricesDto {
	@IsArray()
	@ValidateNested({ each: true })
	@Type(() => TariffPriceItemDto)
	prices!: TariffPriceItemDto[];
}

export class UpdateAffiliateSettingsDto {
	@IsOptional()
	@IsBoolean()
	enabled?: boolean;

	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(50)
	cashbackPercent?: number;
}

export class RevokeEntitlementsCommandDto {
	@IsInt()
	@Equals(1)
	schemaVersion!: number;

	@IsUUID()
	commandId!: string;

	@IsString()
	userId!: string;

	@IsIn(['USER_DEACTIVATION', 'USER_SOFT_DELETE'])
	reason!: string;

	@IsString()
	actorId!: string;

	@IsIn(['ADMIN', 'DEV'])
	actorRole!: 'ADMIN' | 'DEV';

	@IsDateString()
	occurredAt!: string;
}

export class EnsureTrialCommandDto {
	@IsInt()
	@Equals(1)
	schemaVersion!: number;

	@IsUUID()
	commandId!: string;

	@IsString()
	userId!: string;

	@IsInt()
	@Equals(7)
	trialDays!: number;

	@IsDateString()
	registeredAt!: string;
}

export class ActivateCrmTrialCommandDto {
	@IsInt()
	@Equals(1)
	schemaVersion!: number;

	@IsUUID('4')
	commandId!: string;

	@IsUUID('4')
	workspaceId!: string;

	@IsString()
	@MinLength(1)
	@MaxLength(256)
	@Matches(/^[A-Za-z0-9_-]+$/)
	activatedByUserId!: string;
}

export class BillingSettingsPatchDto {
	@IsOptional()
	@IsBoolean()
	paymentEnabled?: boolean;

	@IsOptional()
	@IsBoolean()
	autoRenewalSignupEnabled?: boolean;

	@IsOptional()
	@IsBoolean()
	autoRenewalChargesEnabled?: boolean;

	@IsOptional()
	@IsBoolean()
	affiliateProgramEnabled?: boolean;

	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(50)
	affiliateCashbackPercent?: number;
}

export class BillingFailureCommandDto {
	@IsInt()
	@Equals(1)
	schemaVersion!: number;

	@IsUUID()
	commandId!: string;

	@IsString()
	actorId!: string;

	@IsIn(['ADMIN', 'DEV'])
	actorRole!: 'ADMIN' | 'DEV';

	@IsDateString()
	occurredAt!: string;
}

export class BillingFailureCloseCommandDto extends BillingFailureCommandDto {
	@IsString()
	@MinLength(3)
	@MaxLength(1000)
	comment!: string;
}
