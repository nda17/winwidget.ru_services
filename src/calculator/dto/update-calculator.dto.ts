import {
	IsBoolean,
	IsInt,
	IsObject,
	IsOptional,
	IsString,
	MaxLength,
	Min
} from 'class-validator';

export class UpdateCalculatorDto {
	@IsOptional()
	@IsInt()
	@Min(0)
	expectedDraftRevision?: number;

	@IsOptional()
	@IsString()
	@MaxLength(50)
	name?: string;

	@IsOptional()
	@IsBoolean()
	isActive?: boolean;

	@IsOptional()
	@IsString()
	@MaxLength(253)
	installDomain?: string;

	@IsOptional()
	@IsObject()
	config?: Record<string, unknown>;
}
