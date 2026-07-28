import { IsIn, IsString, MaxLength } from 'class-validator';

export const WIDGET_RUNTIME_EVENTS = [
	'IMPRESSION',
	'OPEN',
	'START'
] as const;

export type WidgetRuntimeEvent = (typeof WIDGET_RUNTIME_EVENTS)[number];

export class RecordWidgetRuntimeEventDto {
	@IsIn(WIDGET_RUNTIME_EVENTS)
	event: WidgetRuntimeEvent;

	@IsString()
	@MaxLength(32)
	runtimeVersion: string;
}
