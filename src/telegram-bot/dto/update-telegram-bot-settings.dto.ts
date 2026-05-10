import {
	IsBoolean,
	IsOptional,
	IsString,
	Matches,
	MaxLength
} from 'class-validator';

export class UpdateTelegramBotSettingsDto {
	@IsOptional()
	@IsBoolean()
	dailySummaryEnabled?: boolean;

	@IsOptional()
	@IsString()
	@MaxLength(100)
	dailySummaryChatId?: string;

	@IsOptional()
	@IsString()
	@Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
	dailySummaryTime?: string;

	@IsOptional()
	@IsBoolean()
	databaseBackupEnabled?: boolean;

	@IsOptional()
	@IsString()
	@Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
	databaseBackupTime?: string;
}
