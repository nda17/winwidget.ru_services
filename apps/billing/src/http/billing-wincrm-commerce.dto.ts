import { Type } from 'class-transformer';
import {
	Equals,
	IsBoolean,
	IsIn,
	IsInt,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	ValidateIf,
	ValidateNested
} from 'class-validator';

export class WincrmCommerceContextDto {
	@Equals(1) schemaVersion!: 1;
	@IsUUID('4') workspaceId!: string;
	@IsString()
	@Matches(/^[^\s\u0000-\u001f\u007f]{1,256}$/u)
	actorSubject!: string;
}
export class WincrmCommerceCommandDto extends WincrmCommerceContextDto {
	@IsUUID('4') commandId!: string;
	@Matches(/^(0|[1-9][0-9]{0,18})$/) expectedBillingVersion!: string;
}
export class WincrmCapacityFenceDto {
	@IsUUID('4') operationId!: string;
	@Matches(/^[a-f0-9]{64}$/) requestHash!: string;
	@IsInt() @Min(1) @Max(2147483646) fenceRevision!: number;
	@IsInt() @Min(2) @Max(10000) targetSeats!: number;
}
export class WincrmCheckoutDto extends WincrmCommerceCommandDto {
	@IsInt() @Min(1) @Max(2147483646) expectedPolicyVersion!: number;
	@IsIn(['MONTHLY', 'YEARLY']) cycle!: 'MONTHLY' | 'YEARLY';
	@IsInt() @Min(2) @Max(10000) totalSeats!: number;
	@IsBoolean() autoRenew!: boolean;
	@ValidateIf((_object, value) => value !== null)
	@IsString()
	@MaxLength(128)
	consentVersion!: string | null;
	@ValidateNested()
	@Type(() => WincrmCapacityFenceDto)
	capacityFence!: WincrmCapacityFenceDto;
}
export class WincrmSeatChangeDto extends WincrmCommerceCommandDto {
	@IsUUID('4') expectedPeriodId!: string;
	@IsInt() @Min(1) @Max(2147483646) expectedPeriodVersion!: number;
	@IsInt() @Min(2) @Max(10000) newTotalSeats!: number;
	@ValidateNested()
	@Type(() => WincrmCapacityFenceDto)
	capacityFence!: WincrmCapacityFenceDto;
}
export class WincrmDisableRenewalDto extends WincrmCommerceCommandDto {
	@IsInt() @Min(1) @Max(2147483646) expectedRenewalVersion!: number;
}
export class WincrmConfirmRenewalDto extends WincrmDisableRenewalDto {
	@IsInt() @Min(1) @Max(2147483646) expectedPolicyVersion!: number;
	@IsString() @MaxLength(128) consentVersion!: string;
}
export class WincrmQuoteDto extends WincrmCommerceContextDto {
	@IsIn(['CHECKOUT', 'SEAT_CHANGE', 'RENEWAL']) intent!:
		| 'CHECKOUT'
		| 'SEAT_CHANGE'
		| 'RENEWAL';
	@IsIn(['MONTHLY', 'YEARLY']) cycle!: 'MONTHLY' | 'YEARLY';
	@IsInt() @Min(2) @Max(10000) totalSeats!: number;
}
export class WincrmOrderDto extends WincrmCommerceContextDto {
	@IsUUID('4') orderId!: string;
}
export class WincrmVerifyOrderDto extends WincrmCommerceCommandDto {
	@IsUUID('4') orderId!: string;
	@IsInt() @Min(1) @Max(2147483646) expectedOrderVersion!: number;
}
export class WincrmHistoryDto extends WincrmCommerceContextDto {
	@IsInt() @Min(1) @Max(1000000) page!: number;
	@IsInt() @Min(1) @Max(100) pageSize!: number;
}
export class WincrmCommandStatusDto extends WincrmCommerceContextDto {
	@IsUUID('4') commandId!: string;
	@Matches(/^[a-f0-9]{64}$/) requestHash!: string;
}
export class WincrmCloseCommandDto extends WincrmCommandStatusDto {
	@IsIn(['WINCRM_CHECKOUT', 'WINCRM_SEAT_CHANGE']) commandType!:
		| 'WINCRM_CHECKOUT'
		| 'WINCRM_SEAT_CHANGE';
	@ValidateNested()
	@Type(() => WincrmCapacityFenceDto)
	capacityFence!: WincrmCapacityFenceDto;
}
