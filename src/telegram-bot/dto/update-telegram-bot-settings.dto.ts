import {
	IsBoolean,
	IsInt,
	IsOptional,
	IsString,
	Matches,
	Max,
	MaxLength,
	Min
} from 'class-validator';

export class UpdateTelegramBotSettingsDto {
	@IsOptional()
	@IsString()
	@MaxLength(100)
	dailySummaryChatId?: string;

	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(2147483647)
	supportThreadId?: number | null;

	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(2147483647)
	databaseBackupThreadId?: number | null;

	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(2147483647)
	paymentsThreadId?: number | null;

	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(2147483647)
	operationalAlertsThreadId?: number | null;

	@IsOptional()
	@IsBoolean()
	databaseBackupEnabled?: boolean;

	@IsOptional()
	@IsString()
	@Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
	databaseBackupTime?: string;
}
