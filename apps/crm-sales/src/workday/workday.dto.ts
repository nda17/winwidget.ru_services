import { Type } from 'class-transformer';
import {
	IsDefined,
	IsIn,
	IsString,
	IsUUID,
	Matches,
	MaxLength,
	MinLength,
	ValidateIf,
	ValidateNested
} from 'class-validator';
import {
	SalesCommandDto,
	SalesListQuery,
	VersionedSalesCommand
} from '../sales/sales.dto';

const optional = (_object: unknown, value: unknown) => value !== undefined;

export class TaskAssigneeDto {
	@IsString() @Matches(/^[^\s\x00-\x1f\x7f]{1,256}$/) subject!: string;
	@IsUUID('4') membershipId!: string;
}
export class CreateWorkdayTaskDto extends SalesCommandDto {
	@IsString() @MinLength(1) @MaxLength(200) @Matches(/\S/) title!: string;
	@IsString()
	@Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
	dueAt!: string;
	@ValidateIf(optional) @IsUUID('4') dealId?: string;
	@ValidateIf(optional) @IsUUID('4') teamId?: string;
	// The selector defaults to the creator's current directory binding.
	@IsDefined()
	@ValidateNested()
	@Type(() => TaskAssigneeDto)
	assignee!: TaskAssigneeDto;
}
export class EditWorkdayTaskDto extends VersionedSalesCommand {
	@IsString() @MinLength(1) @MaxLength(200) @Matches(/\S/) title!: string;
	@IsString()
	@Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
	dueAt!: string;
}
export class SetTaskStatusDto extends VersionedSalesCommand {
	@IsIn(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']) status!:
		| 'OPEN'
		| 'IN_PROGRESS'
		| 'COMPLETED'
		| 'CANCELLED';
}
export class AssignWorkdayTaskDto extends VersionedSalesCommand {
	@IsDefined()
	@ValidateNested()
	@Type(() => TaskAssigneeDto)
	assignee!: TaskAssigneeDto;
}
export class WorkdayQuery extends SalesListQuery {
	@IsIn(['MINE', 'TEAM', 'ALL']) scope: 'MINE' | 'TEAM' | 'ALL' = 'MINE';
	@ValidateIf(optional) @IsUUID('4') teamId?: string;
	@ValidateIf(optional)
	@IsString()
	@Matches(/^[^\s\x00-\x1f\x7f]{1,256}$/)
	assigneeSubject?: string;
	@IsIn(['TODAY', 'TOMORROW', 'WEEK', 'DAY', 'RANGE', 'ALL', 'OVERDUE'])
	period:
		| 'TODAY'
		| 'TOMORROW'
		| 'WEEK'
		| 'DAY'
		| 'RANGE'
		| 'ALL'
		| 'OVERDUE' = 'TODAY';
	@IsString() @MinLength(1) @MaxLength(100) timeZone = 'Europe/Moscow';
	@ValidateIf(optional)
	@IsString()
	@Matches(/^\d{4}-\d{2}-\d{2}$/)
	from?: string;
	@ValidateIf(optional)
	@IsString()
	@Matches(/^\d{4}-\d{2}-\d{2}$/)
	to?: string;
	@ValidateIf(optional)
	@IsIn(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])
	status?: SetTaskStatusDto['status'];
}
