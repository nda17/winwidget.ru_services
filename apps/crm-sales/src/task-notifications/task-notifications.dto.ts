import { IsBoolean, IsIn, IsUUID, ValidateIf } from 'class-validator';
import { ReminderPageQuery } from '../reminders/reminder-rules.dto';
import { WorkspaceQuery } from '../sales/sales.dto';

export class TaskNotificationsQuery extends ReminderPageQuery {
	@IsIn(['true', 'false']) unreadOnly: 'true' | 'false' = 'false';
}
export class TaskNotificationReadDto extends WorkspaceQuery {
	@ValidateIf((_object, value) => value !== null)
	@IsUUID('4')
	actorMembershipId!: string | null;
	@IsBoolean() read!: boolean;
}
