import { Type } from 'class-transformer';
import {
	Equals,
	IsEmail,
	IsIn,
	IsInt,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min
} from 'class-validator';

export class IntakeWorkspaceQuery {
	@IsUUID('4') workspaceId!: string;
}

export class IntakePageQuery extends IntakeWorkspaceQuery {
	@Type(() => Number) @IsInt() @Min(1) @Max(1_000_000) page = 1;
	@Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
}

export class InboxListQuery extends IntakePageQuery {
	@IsOptional() @IsString() @MaxLength(200) search?: string;
	@IsOptional() @IsIn(['NEW', 'ACCEPTED', 'REJECTED']) status?:
		| 'NEW'
		| 'ACCEPTED'
		| 'REJECTED';
}

export class IntakeCommandDto {
	@Equals(1) schemaVersion!: 1;
	@IsUUID('4') workspaceId!: string;
	@IsUUID('4') commandId!: string;
}

export class VersionedIntakeCommandDto extends IntakeCommandDto {
	@IsInt() @Min(1) @Max(2_147_483_646) expectedVersion!: number;
}

export class CreateInboxEntryDto extends IntakeCommandDto {
	@IsString() @MaxLength(200) @Matches(/\S/) title!: string;
	@IsString() @MaxLength(200) @Matches(/\S/) name!: string;
	@IsOptional() @Matches(/^\+[1-9][0-9]{6,14}$/) phone?: string | null;
	@IsOptional() @IsEmail() @MaxLength(254) email?: string | null;
	@IsOptional() @IsString() @MaxLength(5000) message?: string | null;
	@IsOptional() @IsUUID('4') teamId?: string | null;
}

export class IngestInboxEntryDto {
	@Equals(1) schemaVersion!: 1;
	@IsString() @MaxLength(200) @Matches(/\S/) title!: string;
	@IsString() @MaxLength(200) @Matches(/\S/) name!: string;
	@IsOptional() @Matches(/^\+[1-9][0-9]{6,14}$/) phone?: string | null;
	@IsOptional() @IsEmail() @MaxLength(254) email?: string | null;
	@IsOptional() @IsString() @MaxLength(5000) message?: string | null;
}

export class RejectInboxEntryDto extends VersionedIntakeCommandDto {
	@IsString() @MaxLength(2000) @Matches(/\S/) reason!: string;
}

export class CreateIntakeSourceDto extends IntakeCommandDto {
	@IsString() @MaxLength(200) @Matches(/\S/) name!: string;
	@Matches(/^[A-Za-z0-9_-]{43}$/) token!: string;
	@IsOptional() @IsUUID('4') teamId?: string | null;
}

export class RotateIntakeSourceTokenDto extends VersionedIntakeCommandDto {
	@Matches(/^[A-Za-z0-9_-]{43}$/) token!: string;
}
