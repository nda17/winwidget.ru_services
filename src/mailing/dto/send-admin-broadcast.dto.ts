import {
	IsIn,
	IsOptional,
	IsString,
	MaxLength,
	MinLength
} from 'class-validator';

export const ADMIN_BROADCAST_AUDIENCES = [
	'ACTIVE_SUBSCRIPTION',
	'ALL'
] as const;

export type AdminBroadcastAudience =
	(typeof ADMIN_BROADCAST_AUDIENCES)[number];

export const ADMIN_BROADCAST_CHANNELS = [
	'EMAIL',
	'TELEGRAM',
	'BOTH'
] as const;

export type AdminBroadcastChannel =
	(typeof ADMIN_BROADCAST_CHANNELS)[number];

export class SendAdminBroadcastDto {
	@IsString()
	@MinLength(3)
	@MaxLength(120)
	subject: string;

	@IsString()
	@MinLength(10)
	@MaxLength(5000)
	message: string;

	@IsIn([...ADMIN_BROADCAST_AUDIENCES])
	audience: AdminBroadcastAudience;

	@IsOptional()
	@IsIn([...ADMIN_BROADCAST_CHANNELS])
	channel?: AdminBroadcastChannel;
}
