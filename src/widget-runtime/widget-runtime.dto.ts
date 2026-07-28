import {
	IsDefined,
	IsIn,
	IsInt,
	IsString,
	Matches,
	Min,
	MaxLength,
	ValidateIf
} from 'class-validator';

export const WIDGET_RUNTIME_EVENTS = [
	'IMPRESSION',
	'OPEN',
	'START',
	'COMPLETE',
	'STEP'
] as const;

export type WidgetRuntimeEvent = (typeof WIDGET_RUNTIME_EVENTS)[number];
export type WidgetRuntimeFunnelEvent = Exclude<WidgetRuntimeEvent, 'STEP'>;

export const WIDGET_RUNTIME_STEP_KEY_PATTERN =
	/^(?:question|field):(?:[1-9]|1[0-9]|20)$/;

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
	@Matches(WIDGET_RUNTIME_STEP_KEY_PATTERN)
	stepKey?: string;
}
