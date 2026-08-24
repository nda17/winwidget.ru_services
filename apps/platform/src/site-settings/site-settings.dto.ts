import {
	IsBoolean,
	IsOptional,
	IsString,
	MaxLength
} from 'class-validator';

export class UpdatePlatformSiteSettingsDto {
	@IsOptional()
	@IsBoolean()
	bannerEnabled?: boolean;

	@IsOptional()
	@IsString()
	@MaxLength(300)
	bannerText?: string;

	@IsOptional()
	@IsBoolean()
	snowflakeEnabled?: boolean;
}
