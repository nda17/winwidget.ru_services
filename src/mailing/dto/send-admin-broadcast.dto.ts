import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export const ADMIN_BROADCAST_AUDIENCES = [
	'ACTIVE_SUBSCRIPTION',
	'ALL'
] as const;

export type AdminBroadcastAudience =
	(typeof ADMIN_BROADCAST_AUDIENCES)[number];

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
}
