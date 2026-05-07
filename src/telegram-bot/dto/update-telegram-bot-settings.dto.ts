import {
	IsBoolean,
	IsOptional,
	IsString,
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
}
