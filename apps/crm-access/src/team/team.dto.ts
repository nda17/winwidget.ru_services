import { Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayUnique,
	Equals,
	IsArray,
	IsEmail,
	IsIn,
	IsInt,
	IsOptional,
	IsString,
	IsUUID,
	Max,
	MaxLength,
	Min,
	MinLength
} from 'class-validator';
import type { CrmMemberRole } from '@prisma/crm-access-client';

export class TeamQueryDto {
	@IsUUID('4')
	workspaceId!: string;

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(1000000)
	page = 1;

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	pageSize = 20;
}

export class TeamCommandDto {
	@Equals(1)
	schemaVersion!: 1;
	@IsUUID('4')
	commandId!: string;
	@IsUUID('4')
	workspaceId!: string;
}
export class VersionedTeamCommandDto extends TeamCommandDto {
	@IsInt()
	@Min(1)
	@Max(2147483647)
	expectedVersion!: number;
}
export class CreateTeamDto extends TeamCommandDto {
	@IsString()
	@MinLength(1)
	@MaxLength(100)
	name!: string;
}
export class UpdateTeamDto extends VersionedTeamCommandDto {
	@IsString()
	@MinLength(1)
	@MaxLength(100)
	name!: string;
}
export class ChangeRoleDto extends VersionedTeamCommandDto {
	@IsIn(['CRM_ADMIN', 'TEAM_LEAD', 'MANAGER', 'ANALYST'])
	role!: CrmMemberRole;
}
export class SetMemberTeamsDto extends VersionedTeamCommandDto {
	@IsArray()
	@ArrayUnique()
	@ArrayMaxSize(1000)
	@IsUUID('4', { each: true })
	teamIds!: string[];
}
export class CreateInvitationDto extends TeamCommandDto {
	@IsEmail()
	@MaxLength(254)
	email!: string;
	@IsIn(['CRM_ADMIN', 'TEAM_LEAD', 'MANAGER', 'ANALYST'])
	role!: CrmMemberRole;
	@IsArray()
	@ArrayUnique()
	@ArrayMaxSize(1000)
	@IsUUID('4', { each: true })
	teamIds!: string[];
	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(7)
	ttlDays = 7;
}
