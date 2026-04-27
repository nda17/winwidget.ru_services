import {
	IsBoolean,
	IsObject,
	IsOptional,
	IsString,
	MaxLength
} from 'class-validator';

export class UpdateCountdownTimerDto {
	@IsOptional()
	@IsString()
	@MaxLength(50)
	name?: string;

	@IsOptional()
	@IsBoolean()
	isActive?: boolean;

	@IsOptional()
	@IsObject()
	config?: Record<string, any>;
}
