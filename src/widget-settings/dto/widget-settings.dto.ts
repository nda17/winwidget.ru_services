import {
	IsInt,
	IsOptional,
	IsString,
	MaxLength,
	Min
} from 'class-validator';

export class ExpectedDraftRevisionDto {
	@IsInt()
	@Min(0)
	expectedDraftRevision: number;
}

export class CloneWidgetSettingsDto {
	@IsOptional()
	@IsString()
	@MaxLength(50)
	name?: string;
}
