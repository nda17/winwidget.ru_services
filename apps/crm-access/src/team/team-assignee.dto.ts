import { Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayUnique,
	Equals,
	IsArray,
	IsObject,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	MaxLength,
	ValidateIf,
	ValidateNested
} from 'class-validator';
import { TeamQueryDto } from './team.dto';

export class AssigneeQueryDto extends TeamQueryDto {
	@IsOptional() @IsString() @MaxLength(200) search?: string;
	@IsOptional()
	@IsString()
	@Matches(/^[^\s\x00-\x1f\x7f]{1,256}$/)
	selectedSubject?: string;
	@IsOptional() @IsUUID('4') teamId?: string;
}

export class AssigneeLabelBindingDto {
	@IsString() @Matches(/^[^\s\x00-\x1f\x7f]{1,256}$/) subject!: string;
	@ValidateIf((_object, value) => value !== null)
	@IsUUID('4')
	membershipId!: string | null;
}

export class AssigneeLabelsDto {
	@Equals(1) schemaVersion!: 1;
	@IsUUID('4') workspaceId!: string;
	@IsArray()
	@IsObject({ each: true })
	@ArrayMaxSize(100)
	@ArrayUnique((binding: AssigneeLabelBindingDto | null) =>
		JSON.stringify([binding?.subject, binding?.membershipId])
	)
	@ValidateNested({ each: true })
	@Type(() => AssigneeLabelBindingDto)
	bindings!: AssigneeLabelBindingDto[];
}

export class AuthorizeAssigneeDto {
	@Equals(1) schemaVersion!: 1;
	@Equals('SALES_ASSIGNMENT') purpose!: 'SALES_ASSIGNMENT';
	@IsUUID('4') workspaceId!: string;
	@IsString() @Matches(/^[^\s\x00-\x1f\x7f]{1,256}$/) subject!: string;
	@IsUUID('4') membershipId!: string;
	@IsOptional() @IsUUID('4') teamId?: string;
}
