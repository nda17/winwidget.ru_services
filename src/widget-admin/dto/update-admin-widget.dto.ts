import {
	IsBoolean,
	IsObject,
	IsOptional,
	IsString,
	MaxLength
} from 'class-validator';

export class UpdateAdminWidgetDto {
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
