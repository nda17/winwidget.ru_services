import {
	IsBoolean,
	IsOptional,
	IsString,
	MaxLength
} from 'class-validator';

export class UpdateSiteSettingsDto {
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

	@IsOptional()
	@IsBoolean()
	paymentEnabled?: boolean;
}
