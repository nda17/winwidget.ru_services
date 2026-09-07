import { Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayUnique,
	Equals,
	IsArray,
	IsDefined,
	IsEmail,
	IsIn,
	IsInt,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	MinLength,
	ValidateIf,
	ValidateNested
} from 'class-validator';
import type { CrmMemberRole } from '@prisma/crm-access-client';
import { EmployeeNameDto } from './team-profile.dto';

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

export class TeamOptionsQueryDto extends TeamQueryDto {
	@IsOptional()
	@IsUUID('4')
	selectedId?: string;
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
	@ValidateIf((_object, value) => value !== undefined)
	@IsDefined()
	@ValidateNested()
	@Type(() => EmployeeNameDto)
	profile?: EmployeeNameDto;

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

export class EmployeeProfileQueryDto {
	@IsUUID('4')
	workspaceId!: string;

	@IsOptional()
	@IsString()
	@Matches(/^[^\s\x00-\x1f\x7f]{1,256}$/)
	subject?: string;
}

export class UpdateEmployeeProfileDto extends TeamCommandDto {
	@IsString()
	@Matches(/^[^\s\x00-\x1f\x7f]{1,256}$/)
	subject!: string;

	@IsInt()
	@Min(0)
	@Max(2147483646)
	expectedVersion!: number;

	@IsDefined()
	@ValidateNested()
	@Type(() => EmployeeNameDto)
	profile!: EmployeeNameDto;
}
