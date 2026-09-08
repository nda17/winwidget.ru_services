import { Type } from 'class-transformer';
import {
	IsDefined,
	IsIn,
	IsInt,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	MinLength,
	ValidateIf,
	ValidateNested
} from 'class-validator';
import { SalesCommandDto, SalesListQuery } from '../sales/sales.dto';

export class SeriesAssigneeDto {
	@IsString() @Matches(/^[^\s\x00-\x1f\x7f]{1,256}$/) subject!: string;
	@ValidateIf((_object, value) => value !== null)
	@IsUUID('4')
	membershipId!: string | null;
}
export class SeriesContentDto {
	@IsString() @MinLength(1) @MaxLength(200) @Matches(/\S/) title!: string;
	@IsString() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) localTime!: string;
	@IsString() @MinLength(1) @MaxLength(100) timeZone!: string;
	@IsDefined()
	@ValidateNested()
	@Type(() => SeriesAssigneeDto)
	assignee!: SeriesAssigneeDto;
}
export class SeriesCommandDto extends SalesCommandDto {
	@ValidateIf((_object, value) => value !== null)
	@IsUUID('4')
	actorMembershipId!: string | null;
}
export class CreateTaskSeriesDto extends SeriesCommandDto {
	@IsDefined()
	@ValidateNested()
	@Type(() => SeriesContentDto)
	content!: SeriesContentDto;
	@IsIn(['DAILY', 'WEEKLY', 'MONTHLY']) frequency!:
		| 'DAILY'
		| 'WEEKLY'
		| 'MONTHLY';
	@IsString() @Matches(/^20\d{2}-\d{2}-\d{2}$/) startDate!: string;
	@ValidateIf((_object, value) => value !== undefined)
	@IsUUID('4')
	dealId?: string;
	@ValidateIf((_object, value) => value !== undefined)
	@IsUUID('4')
	teamId?: string;
}
export class VersionedTaskSeriesDto extends SeriesCommandDto {
	@IsInt() @Min(1) @Max(2147483646) expectedVersion!: number;
}
export class EditTaskSeriesDto extends VersionedTaskSeriesDto {
	// Frequency, startDate and deal binding are immutable. A different calendar
	// is a new series, not a reinterpretation of already committed period keys.
	@IsDefined()
	@ValidateNested()
	@Type(() => SeriesContentDto)
	content!: SeriesContentDto;
}
export class SetTaskSeriesStatusDto extends VersionedTaskSeriesDto {
	@IsIn(['ACTIVE', 'PAUSED', 'CANCELLED']) status!:
		| 'ACTIVE'
		| 'PAUSED'
		| 'CANCELLED';
}
export class TaskSeriesQuery extends SalesListQuery {
	@IsIn(['ACTIVE', 'PAUSED', 'CANCELLED', 'ALL']) status:
		| 'ACTIVE'
		| 'PAUSED'
		| 'CANCELLED'
		| 'ALL' = 'ACTIVE';
}
