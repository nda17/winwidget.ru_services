import {
	ArrayMaxSize,
	IsArray,
	IsBoolean,
	IsDefined,
	IsEmail,
	IsIn,
	IsInt,
	IsObject,
	IsOptional,
	IsString,
	Matches,
	MaxLength,
	MinLength,
	Min,
	ValidateIf
} from 'class-validator';

export class CreateWidgetDto {
	@IsOptional()
	@IsString()
	@MaxLength(50)
	name?: string;
}

export class UpdateWidgetDto {
	@IsOptional()
	@IsInt()
	@Min(0)
	expectedDraftRevision?: number;

	@IsOptional()
	@IsString()
	@MaxLength(50)
	name?: string;

	@IsOptional()
	@IsBoolean()
	isActive?: boolean;

	@IsOptional()
	@IsString()
	@MaxLength(253)
	installDomain?: string;

	@IsOptional()
	@IsObject()
	config?: Record<string, unknown>;
}

export class ExpectedDraftRevisionDto {
	@IsInt()
	@Min(0)
	expectedDraftRevision: number;
}

export class CloneWidgetDto {
	@IsOptional()
	@IsString()
	@MaxLength(50)
	name?: string;
}

export class CalculatorAnswerDto {
	@IsString()
	@MaxLength(64)
	fieldId: string;

	@IsDefined()
	value: unknown;
}

export class SubmitWidgetLeadDto {
	@IsOptional()
	@IsString()
	@MaxLength(200)
	key?: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	contact?: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	name?: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	phone?: string;

	@IsOptional()
	@IsEmail({}, { message: 'Укажите корректный email' })
	@MaxLength(200)
	email?: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	bonus?: string;

	@IsOptional()
	@IsString()
	@MaxLength(500)
	result?: string;

	@IsOptional()
	@IsString()
	@MaxLength(100)
	timeSlot?: string;

	@IsOptional()
	@IsString()
	@MaxLength(100)
	timezone?: string;

	@IsOptional()
	@IsString()
	@MaxLength(120)
	actionLabel?: string;

	@IsOptional()
	@IsString()
	@MaxLength(2000)
	actionValue?: string;

	@IsOptional()
	@IsString()
	@MaxLength(500)
	url?: string;

	@IsOptional()
	@IsArray()
	@ArrayMaxSize(20)
	answers?: unknown[];
}

export const WIDGET_RUNTIME_EVENTS = [
	'IMPRESSION',
	'OPEN',
	'START',
	'COMPLETE',
	'STEP'
] as const;
export type WidgetRuntimeEvent = (typeof WIDGET_RUNTIME_EVENTS)[number];

export class RecordWidgetRuntimeEventDto {
	@IsIn(WIDGET_RUNTIME_EVENTS)
	event: WidgetRuntimeEvent;

	@IsString()
	@MaxLength(32)
	runtimeVersion: string;

	@IsInt()
	@Min(1)
	publishedVersion: number;

	@ValidateIf(
		(value: RecordWidgetRuntimeEventDto) => value.event === 'STEP'
	)
	@IsDefined()
	@IsString()
	@MaxLength(32)
	@Matches(/^(?:question|field):(?:[1-9]|1[0-9]|20)$/)
	stepKey?: string;
}

export class AdminOwnerOverviewDto {
	@IsString()
	@MaxLength(255)
	userId: string;
}

export class ReportingSeedDto {
	@IsString()
	@Matches(/^[0-9a-f]{64}$/)
	sourceDatabaseFingerprint: string;

	@IsString()
	sourceExportedAt: string;

	@IsString()
	@Matches(/^(?:0|[1-9][0-9]{0,18})$/)
	sourceSequenceHighWater: string;

	@IsArray()
	aggregates: Array<{
		aggregateType: string;
		aggregateId: string;
		version: string;
		sourceSequence: string;
		stateHash: string;
	}>;
}

export class RetryDeliveryDto {
	@IsString()
	@MaxLength(255)
	widgetId: string;

	@IsString()
	@MaxLength(64)
	widgetType: string;
}

export class CloseDeliveryFailureDto {
	@IsString()
	@MinLength(3)
	@MaxLength(1000)
	comment: string;
}
