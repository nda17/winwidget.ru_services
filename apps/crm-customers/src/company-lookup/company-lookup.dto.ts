import {
	Equals,
	IsString,
	IsUUID,
	Matches,
	MaxLength,
	MinLength
} from 'class-validator';

export class CompanyLookupDto {
	@Equals(1) schemaVersion!: 1;
	@IsUUID('4') workspaceId!: string;
	@IsString()
	@MinLength(10)
	@MaxLength(12)
	@Matches(/^(?:[0-9]{10}|[0-9]{12})$/)
	inn!: string;
}
