import { Type } from 'class-transformer';
import {
	Equals,
	IsEmail,
	IsInt,
	IsOptional,
	IsString,
	IsUrl,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min
} from 'class-validator';

export class CustomerWorkspaceQuery {
	@IsUUID('4') workspaceId!: string;
}

export class CustomerListQuery extends CustomerWorkspaceQuery {
	@Type(() => Number) @IsInt() @Min(1) @Max(1_000_000) page = 1;
	@Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
	@IsOptional() @IsString() @MaxLength(200) search?: string;
}

export class CustomerDuplicateQuery extends CustomerWorkspaceQuery {
	@IsOptional() @Matches(/^\+[1-9][0-9]{6,14}$/) phone?: string;
	@IsOptional() @IsEmail() @MaxLength(254) email?: string;
	@Type(() => Number) @IsInt() @Min(1) @Max(1_000_000) page = 1;
	@Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 25;
}

export class CustomerCommandDto {
	@Equals(1) schemaVersion!: 1;
	@IsUUID('4') workspaceId!: string;
	@IsUUID('4') commandId!: string;
}

export class CreateCustomerDto extends CustomerCommandDto {
	@IsString() @MaxLength(200) @Matches(/\S/) name!: string;
	@IsOptional() @IsString() @MaxLength(5000) notes?: string | null;
	@IsOptional() @IsUUID('4') teamId?: string | null;
}

export class CreateContactDto extends CreateCustomerDto {
	@IsOptional() @Matches(/^\+[1-9][0-9]{6,14}$/) phone?: string | null;
	@IsOptional() @IsEmail() @MaxLength(254) email?: string | null;
	@IsOptional() @IsUUID('4') companyId?: string | null;
}

export class UpdateContactDto extends CreateContactDto {
	@IsInt() @Min(1) @Max(2_147_483_646) expectedVersion!: number;
}

export class CreateCompanyDto extends CreateCustomerDto {
	@IsOptional() @Matches(/^(?:[0-9]{10}|[0-9]{12})$/) inn?: string | null;
	@IsOptional()
	@MaxLength(2048)
	@IsUrl({
		protocols: ['http', 'https'],
		require_protocol: true,
		require_valid_protocol: true,
		disallow_auth: true
	})
	website?: string | null;
}

export class UpdateCompanyDto extends CreateCompanyDto {
	@IsInt() @Min(1) @Max(2_147_483_646) expectedVersion!: number;
}

export class ArchiveCustomerDto extends CustomerCommandDto {
	@IsInt() @Min(1) @Max(2_147_483_646) expectedVersion!: number;
}
