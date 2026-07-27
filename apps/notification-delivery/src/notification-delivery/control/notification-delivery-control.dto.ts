import {
	NOTIFICATION_DELIVERY_KINDS,
	NotificationDeliveryKind
} from '../../messaging/messaging.constants';
import { Type } from 'class-transformer';
import {
	IsIn,
	IsInt,
	IsOptional,
	IsString,
	Matches,
	Max,
	MaxLength,
	Min,
	MinLength
} from 'class-validator';

export const NOTIFICATION_DELIVERY_CONTROL_KINDS =
	NOTIFICATION_DELIVERY_KINDS;

export const NOTIFICATION_DELIVERY_FAILURE_CATEGORIES = [
	'TRANSIENT',
	'RATE_LIMIT',
	'PERMANENT',
	'AUTH_CONFIGURATION'
] as const;

export const NOTIFICATION_DELIVERY_FAILURE_STATUSES = [
	'ALL',
	'FAILED',
	'RETRYING',
	'RESOLVED',
	'CLOSED'
] as const;

export type NotificationDeliveryControlKind = NotificationDeliveryKind;

export class NotificationDeliveryFailuresQueryDto {
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	page = 1;

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(10_000)
	limit = 20;

	@IsOptional()
	@IsString()
	@IsIn(NOTIFICATION_DELIVERY_CONTROL_KINDS)
	integration?: NotificationDeliveryControlKind;

	@IsOptional()
	@IsString()
	@IsIn(NOTIFICATION_DELIVERY_FAILURE_CATEGORIES)
	category?: (typeof NOTIFICATION_DELIVERY_FAILURE_CATEGORIES)[number];

	@IsOptional()
	@IsString()
	@IsIn(NOTIFICATION_DELIVERY_FAILURE_STATUSES)
	status?: (typeof NOTIFICATION_DELIVERY_FAILURE_STATUSES)[number];
}

export class RetryNotificationDeliveryFailureDto {
	@IsString()
	@MinLength(1)
	@MaxLength(255)
	@Matches(/\S/)
	actorId: string;
}

export class CloseNotificationDeliveryFailureDto extends RetryNotificationDeliveryFailureDto {
	@IsString()
	@MinLength(3)
	@MaxLength(1000)
	comment: string;
}
