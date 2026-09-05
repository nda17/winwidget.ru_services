import {
	Equals,
	IsBoolean,
	IsIn,
	IsInt,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	ValidateIf
} from 'class-validator';
import { WIDGET_TYPES, WidgetType } from './widget-control.contract';
import {
	IntakePageQuery,
	IntakeWorkspaceQuery
} from '../intake/intake.dto';
export {
	IntakePageQuery as WidgetSourcePageQuery,
	IntakeWorkspaceQuery as WidgetSourceWorkspaceQuery
};
export class WidgetSourceCommandDto {
	@Equals(1) schemaVersion!: 1;
	@IsUUID('4') workspaceId!: string;
	@IsUUID('4') commandId!: string;
}
export class CreateWidgetSourceDto extends WidgetSourceCommandDto {
	@IsString()
	@MaxLength(200)
	@Matches(/\S/)
	@Matches(/^[^\x00-\x1f\x7f\ufffd\ud800-\udfff]*$/u)
	name!: string;
	@IsIn(WIDGET_TYPES) widgetType!: WidgetType;
	@IsString()
	@MaxLength(255)
	@Matches(/^[^\s\x00-\x1f\x7f\ufffd\ud800-\udfff]+$/u)
	widgetId!: string;
	@ValidateIf((_object, value) => value !== null) @IsUUID('4') teamId!:
		| string
		| null;
}
export class VersionedWidgetSourceDto extends WidgetSourceCommandDto {
	@IsInt() @Min(1) @Max(2147483645) expectedVersion!: number;
}
export class ConfigureWidgetSourceDto extends VersionedWidgetSourceDto {
	@IsBoolean() enabled!: boolean;
}
