import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayUnique,
	IsArray,
	IsBoolean,
	IsEmail,
	IsIn,
	IsInt,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	MinLength,
	ValidateIf
} from 'class-validator';

export const SUPPORT_STATUSES = [
	'NEW',
	'IN_PROGRESS',
	'RESOLVED'
] as const;
export type WebStatus = (typeof SUPPORT_STATUSES)[number];
export const SUPPORT_SECTIONS = [
	'inbox',
	'customers',
	'deals',
	'planner',
	'settings',
	'other'
] as const;

export class SupportCommandDto {
	@IsUUID('4') commandId!: string;
	@IsString()
	@Matches(/^[^\s\x00-\x1f\x7f]{1,256}$/)
	expectedActorSubject!: string;
}
export class SupportMessageDto extends SupportCommandDto {
	@IsString() @MinLength(1) @MaxLength(10000) @Matches(/\S/) text!: string;
	@IsArray()
	@ArrayMaxSize(3)
	@ArrayUnique()
	@IsUUID('4', { each: true })
	attachmentIds!: string[];
}
export class CreateSupportConversationDto extends SupportMessageDto {
	@IsUUID('4') draftId!: string;
	@ValidateIf((_object, value) => value !== undefined)
	@IsUUID('4')
	workspaceId?: string;
	@IsString()
	@MinLength(1)
	@MaxLength(160)
	@Matches(/\S/)
	subject!: string;
	@IsIn(SUPPORT_SECTIONS) section!: string;
	@IsString() @Matches(/^[A-Za-z0-9._+-]{1,64}$/) appVersion!: string;
}
export class SupportListDto {
	@ValidateIf((_object, value) => value !== undefined)
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100000)
	page = 1;
	@ValidateIf((_object, value) => value !== undefined)
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	limit = 20;
}
export class SupportAdminListDto extends SupportListDto {
	@ValidateIf((_object, value) => value !== undefined)
	@IsIn(SUPPORT_STATUSES)
	status?: WebStatus;
	@ValidateIf((_object, value) => value !== undefined)
	@Transform(({ value }) =>
		value === 'true' ? true : value === 'false' ? false : value
	)
	@IsBoolean()
	unreadOnly?: boolean;
	@ValidateIf((_object, value) => value !== undefined)
	@IsString()
	@MaxLength(160)
	q?: string;
}
export class SupportHistoryDto {
	@ValidateIf((_object, value) => value !== undefined)
	@Type(() => Number)
	@IsInt()
	@Min(0)
	@Max(2147483647)
	beforeSequence?: number;
	@ValidateIf((_object, value) => value !== undefined)
	@Type(() => Number)
	@IsInt()
	@Min(0)
	@Max(2147483647)
	afterSequence?: number;
	@ValidateIf((_object, value) => value !== undefined)
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	limit = 50;
}
export class SupportReadDto {
	@IsInt() @Min(0) @Max(2147483647) throughSequence!: number;
}
export class SupportStatusDto extends SupportCommandDto {
	@IsInt() @Min(0) @Max(2147483647) expectedVersion!: number;
	@IsIn(SUPPORT_STATUSES) status!: WebStatus;
}
export class SupportUploadDto extends SupportCommandDto {
	@ValidateIf((_object, value) => value !== undefined)
	@IsUUID('4')
	draftId?: string;
	@ValidateIf((_object, value) => value !== undefined)
	@IsUUID('4')
	conversationId?: string;
}
export class SupportNotificationSettingsDto extends SupportCommandDto {
	@IsInt() @Min(0) @Max(2147483647) expectedVersion!: number;
	@IsBoolean() enabled!: boolean;
	@IsBoolean() emailEnabled!: boolean;
	@IsArray()
	@ArrayMaxSize(10)
	@ArrayUnique()
	@IsEmail({}, { each: true })
	@MaxLength(254, { each: true })
	staffEmails!: string[];
	@IsBoolean() telegramEnabled!: boolean;
	@ValidateIf((_object, value) => value !== null)
	@IsString()
	@Matches(/^-[1-9]\d{0,19}$/)
	telegramChatId!: string | null;
	@ValidateIf((_object, value) => value !== null)
	@IsInt()
	@Min(1)
	@Max(2147483647)
	telegramThreadId!: number | null;
	@IsBoolean() clientEmailEnabled!: boolean;
}
