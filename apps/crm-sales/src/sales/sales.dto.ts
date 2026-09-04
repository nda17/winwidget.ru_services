import { Type } from 'class-transformer';
import {
	Equals,
	IsDefined,
	IsIn,
	IsInt,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	MinLength,
	ValidateNested
} from 'class-validator';

export class WorkspaceQuery {
	@IsUUID('4') workspaceId!: string;
}
export class SalesListQuery extends WorkspaceQuery {
	@Type(() => Number) @IsInt() @Min(1) @Max(1000000) page = 1;
	@Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
	@IsOptional() @IsString() @MaxLength(200) search?: string;
}
export class DealListQuery extends SalesListQuery {
	@IsOptional() @IsUUID('4') pipelineId?: string;
	@IsOptional() @IsUUID('4') stageId?: string;
	@IsOptional() @IsIn(['OPEN', 'WON', 'LOST']) status?:
		| 'OPEN'
		| 'WON'
		| 'LOST';
}
export class NextTaskDto {
	@IsString() @MinLength(1) @MaxLength(200) @Matches(/\S/) title!: string;
	@IsString()
	@Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
	dueAt!: string;
}
export class SalesCommandDto {
	@Equals(1) schemaVersion!: 1;
	@IsUUID('4') commandId!: string;
	@IsUUID('4') workspaceId!: string;
}
export class CreateDealDto extends SalesCommandDto {
	@IsString() @MinLength(1) @MaxLength(200) @Matches(/\S/) title!: string;
	@Equals('RUB') currency!: 'RUB';
	@IsInt() @Min(0) @Max(2147483647) amountMinor!: number;
	@IsUUID('4') pipelineId!: string;
	@IsUUID('4') stageId!: string;
	@IsUUID('4') contactId!: string;
	@IsOptional() @IsUUID('4') teamId?: string;
	@IsDefined()
	@ValidateNested()
	@Type(() => NextTaskDto)
	nextTask!: NextTaskDto;
}
export class VersionedSalesCommand extends SalesCommandDto {
	@IsInt() @Min(1) @Max(2147483646) expectedVersion!: number;
}
export class TransitionDealDto extends VersionedSalesCommand {
	@IsUUID('4') targetStageId!: string;
	@IsString()
	@MinLength(1)
	@MaxLength(4000)
	@Matches(/\S/)
	outcome!: string;
	@IsOptional()
	@ValidateNested()
	@Type(() => NextTaskDto)
	nextTask?: NextTaskDto;
}
export class CompleteTaskDto extends VersionedSalesCommand {
	@IsString()
	@MinLength(1)
	@MaxLength(4000)
	@Matches(/\S/)
	outcome!: string;
	@IsDefined()
	@ValidateNested()
	@Type(() => NextTaskDto)
	nextTask!: NextTaskDto;
}
