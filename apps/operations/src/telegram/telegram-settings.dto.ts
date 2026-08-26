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

export class UpdateTelegramSettingsDto {
	@IsOptional()
	@IsString()
	@MaxLength(100)
	dailySummaryChatId?: string;

	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(2_147_483_647)
	databaseBackupThreadId?: number | null;

	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(2_147_483_647)
	paymentsThreadId?: number | null;

	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(2_147_483_647)
	operationalAlertsThreadId?: number | null;

	@IsOptional()
	@IsBoolean()
	databaseBackupEnabled?: boolean;

	@IsOptional()
	@IsString()
	@Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
	databaseBackupTime?: string;
}
