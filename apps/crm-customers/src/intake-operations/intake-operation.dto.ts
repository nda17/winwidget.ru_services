import { Type } from 'class-transformer';
import {
	Equals,
	IsDefined,
	IsEmail,
	IsIn,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	MaxLength,
	ValidateNested
} from 'class-validator';
import { createHash } from 'node:crypto';

export function canonicalOperation(value: unknown): string {
	if (Array.isArray(value))
		return `[${value.map(canonicalOperation).join(',')}]`;
	if (value && typeof value === 'object')
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(
				([key, item]) =>
					`${JSON.stringify(key)}:${canonicalOperation(item)}`
			)
			.join(',')}}`;
	return JSON.stringify(value);
}
export const operationHash = (value: unknown) =>
	createHash('sha256').update(canonicalOperation(value)).digest('hex');

export class IntakeOperationBinding {
	@Equals(1) schemaVersion!: 1;
	@IsUUID('4') workspaceId!: string;
	@IsUUID('4') workflowId!: string;
	@IsUUID('4') operationId!: string;
	@IsString()
	@MaxLength(256)
	@Matches(/^[^\s\x00-\x1f\x7f]+$/)
	actorSubject!: string;
	@Matches(/^[a-f0-9]{64}$/) payloadHash!: string;
}
export class ContactOperationPayload {
	@IsIn(['CREATE', 'EXISTING']) mode!: 'CREATE' | 'EXISTING';
	@IsOptional() @IsUUID('4') contactId?: string;
	@IsOptional() @IsString() @MaxLength(200) @Matches(/\S/) name?: string;
	@IsOptional() @Matches(/^\+[1-9][0-9]{6,14}$/) phone?: string | null;
	@IsOptional() @IsEmail() @MaxLength(254) email?: string | null;
	@IsOptional() @IsUUID('4') teamId?: string | null;
}
export class ExecuteContactOperationDto extends IntakeOperationBinding {
	@IsUUID('4') commandId!: string;
	@IsDefined()
	@ValidateNested()
	@Type(() => ContactOperationPayload)
	payload!: ContactOperationPayload;
}
export class CloseContactOperationDto extends IntakeOperationBinding {
	@IsUUID('4') commandId!: string;
	@IsString()
	@MaxLength(256)
	@Matches(/^[^\s\x00-\x1f\x7f]+$/)
	recoverySubject!: string;
}
