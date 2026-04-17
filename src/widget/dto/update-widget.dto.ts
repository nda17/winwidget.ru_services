import {
	IsBoolean,
	IsObject,
	IsOptional,
	IsString,
	MaxLength
} from 'class-validator';

export class UpdateWidgetDto {
	@IsOptional()
	@IsString()
	@MaxLength(15)
	name?: string;

	@IsOptional()
	@IsBoolean()
	isActive?: boolean;

	@IsOptional()
	@IsObject()
	config?: Record<string, any>;
}
