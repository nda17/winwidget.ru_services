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
	ValidateNested
} from 'class-validator';
import { createHash } from 'node:crypto';
import { VersionedIntakeCommandDto } from '../intake/intake.dto';

export function canonicalAcceptance(value: unknown): string {
	if (Array.isArray(value))
		return `[${value.map(canonicalAcceptance).join(',')}]`;
	if (value && typeof value === 'object')
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(
				([key, item]) =>
					`${JSON.stringify(key)}:${canonicalAcceptance(item)}`
			)
			.join(',')}}`;
	return JSON.stringify(value);
}
export const acceptanceHash = (value: unknown) =>
	createHash('sha256').update(canonicalAcceptance(value)).digest('hex');
export const ACCEPTANCE_UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class AcceptanceContactDto {
	@IsIn(['CREATE_FROM_ENTRY', 'EXISTING']) mode!:
		| 'CREATE_FROM_ENTRY'
		| 'EXISTING';
	@IsOptional() @IsUUID('4') contactId?: string;
}
export class AcceptanceNextTaskDto {
	@IsString() @MaxLength(200) @Matches(/\S/) title!: string;
	@IsString()
	@Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
	dueAt!: string;
}
export class AcceptanceDealDto {
	@IsString() @MaxLength(200) @Matches(/\S/) title!: string;
	@Equals('RUB') currency!: 'RUB';
	@IsInt() @Min(0) @Max(2147483647) amountMinor!: number;
	@IsUUID('4') pipelineId!: string;
	@IsUUID('4') stageId!: string;
	@IsDefined()
	@ValidateNested()
	@Type(() => AcceptanceNextTaskDto)
	nextTask!: AcceptanceNextTaskDto;
}
export class AcceptInboxDto extends VersionedIntakeCommandDto {
	@IsDefined()
	@ValidateNested()
	@Type(() => AcceptanceContactDto)
	contact!: AcceptanceContactDto;
	@IsDefined()
	@ValidateNested()
	@Type(() => AcceptanceDealDto)
	deal!: AcceptanceDealDto;
}
export interface OperationBinding {
	schemaVersion: 1;
	workspaceId: string;
	workflowId: string;
	operationId: string;
	actorSubject: string;
	payloadHash: string;
}
export interface OperationProof extends OperationBinding {
	state: 'ABSENT' | 'COMMITTED' | 'CANCELLED';
	result: Record<string, string | number> | null;
	committedAt: string | null;
}
export interface AcceptanceEvent {
	schemaVersion: 1;
	eventId: string;
	workspaceId: string;
	workflowId: string;
	generation: number;
	mode: 'EXECUTE' | 'RECOVER';
}
export function parseAcceptanceEvent(value: unknown): AcceptanceEvent {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('INVALID_EVENT');
	const event = value as Record<string, unknown>;
	if (
		Object.keys(event).sort().join(',') !==
			'eventId,generation,mode,schemaVersion,workflowId,workspaceId' ||
		event.schemaVersion !== 1 ||
		!['eventId', 'workflowId', 'workspaceId'].every(
			key =>
				typeof event[key] === 'string' && ACCEPTANCE_UUID.test(event[key])
		) ||
		!Number.isSafeInteger(event.generation) ||
		Number(event.generation) < 1 ||
		Number(event.generation) > 2147483647 ||
		!['EXECUTE', 'RECOVER'].includes(String(event.mode))
	)
		throw new Error('INVALID_EVENT');
	return event as unknown as AcceptanceEvent;
}
