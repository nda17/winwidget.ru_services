import { Type } from 'class-transformer';
import {
	IsDefined,
	IsIn,
	IsInt,
	IsObject,
	IsUUID,
	Max,
	Min,
	ValidateIf
} from 'class-validator';
import { SalesCommandDto, WorkspaceQuery } from '../sales/sales.dto';

export class ReminderActorQuery extends WorkspaceQuery {
	// Omitted only for the current OWNER; never a wildcard membership lookup.
	@ValidateIf((_object, value) => value !== undefined)
	@IsUUID('4')
	actorMembershipId?: string;
}
export class ReminderPageQuery extends ReminderActorQuery {
	@Type(() => Number) @IsInt() @Min(1) @Max(1000000) page = 1;
	@Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}
export class ReminderRulesQuery extends ReminderPageQuery {
	@IsIn(['WORKSPACE', 'PERSONAL']) scope: 'WORKSPACE' | 'PERSONAL' =
		'PERSONAL';
	@IsIn(['true', 'false']) archived: 'true' | 'false' = 'false';
}
export class ReminderCommandDto extends SalesCommandDto {
	@ValidateIf((_object, value) => value !== null)
	@IsUUID('4')
	actorMembershipId!: string | null;
}
export class CreateReminderRuleDto extends ReminderCommandDto {
	@IsDefined() @IsObject() rule!: unknown;
}
export class ArchiveReminderRuleDto extends ReminderCommandDto {
	@IsInt() @Min(1) @Max(2147483646) expectedVersion!: number;
}
export class EditReminderRuleDto extends ArchiveReminderRuleDto {
	@IsDefined() @IsObject() rule!: unknown;
}
