import {
	IsBoolean,
	IsIn,
	IsOptional,
	Equals,
	IsUUID
} from 'class-validator';
import { IntakePageQuery } from '../intake/intake.dto';
export class InboxNotificationsQuery extends IntakePageQuery {
	@IsOptional() @IsIn(['true', 'false']) unreadOnly?: string;
}
export class InboxNotificationReadDto {
	@Equals(1) schemaVersion!: 1;
	@IsUUID('4') workspaceId!: string;
	@IsBoolean() read!: boolean;
}
