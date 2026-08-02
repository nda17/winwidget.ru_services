import {
	IsBoolean,
	IsInt,
	IsString,
	MaxLength,
	Max,
	IsOptional,
	Matches,
	Min,
	ValidateIf
} from 'class-validator';

export class UpdateDailySummarySettingsDto {
	@IsOptional()
	@IsBoolean()
	enabled?: boolean;

	@IsOptional()
	@ValidateIf((_object, value) => value !== null)
	@IsString()
	@MaxLength(255)
	destinationChatId?: string | null;

	@IsOptional()
	@ValidateIf((_object, value) => value !== null)
	@IsInt()
	@Min(1)
	@Max(2147483647)
	messageThreadId?: number | null;

	@IsOptional()
	@IsString()
	@Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
	scheduleTime?: string;

	@IsOptional()
	@IsString()
	@Matches(/^(?:0|[1-9]\d*)$/)
	expectedScheduleGeneration?: string;
}
