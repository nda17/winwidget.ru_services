import { Type } from 'class-transformer';
import {
	Equals,
	IsDefined,
	IsInt,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	MinLength,
	ValidateIf,
	ValidateNested
} from 'class-validator';
import { createHash } from 'node:crypto';
import { NextTaskDto } from '../sales/sales.dto';

export class IntakeOperationBinding {
	@Equals(1) schemaVersion!: 1;
	@IsUUID('4') @Matches(/^[0-9a-f-]+$/) workspaceId!: string;
	@IsUUID('4') @Matches(/^[0-9a-f-]+$/) workflowId!: string;
	@IsUUID('4') @Matches(/^[0-9a-f-]+$/) operationId!: string;
	@IsString()
	@Matches(/^[^\s\x00-\x1f\x7f]{1,256}$/)
	actorSubject!: string;
	@IsString() @Matches(/^[a-f0-9]{64}$/) payloadHash!: string;
}
export class IntakeContactOperation {
	@IsUUID('4') @Matches(/^[0-9a-f-]+$/) operationId!: string;
	@IsString() @Matches(/^[a-f0-9]{64}$/) payloadHash!: string;
}
export class IntakeDealPayload {
	@IsString() @MinLength(1) @MaxLength(200) @Matches(/\S/) title!: string;
	@Equals('RUB') currency!: 'RUB';
	@IsInt() @Min(0) @Max(2147483647) amountMinor!: number;
	@IsUUID('4') @Matches(/^[0-9a-f-]+$/) pipelineId!: string;
	@IsUUID('4') @Matches(/^[0-9a-f-]+$/) stageId!: string;
	@ValidateIf((_object, value) => value !== null)
	@IsUUID('4')
	@Matches(/^[0-9a-f-]+$/)
	teamId!: string | null;
	@IsDefined()
	@ValidateNested()
	@Type(() => NextTaskDto)
	nextTask!: NextTaskDto;
	@IsDefined()
	@ValidateNested()
	@Type(() => IntakeContactOperation)
	contactOperation!: IntakeContactOperation;
}
export class ExecuteIntakeOperation extends IntakeOperationBinding {
	@IsUUID('4') @Matches(/^[0-9a-f-]+$/) commandId!: string;
	@IsDefined()
	@ValidateNested()
	@Type(() => IntakeDealPayload)
	payload!: IntakeDealPayload;
}
export class CloseIntakeOperation extends IntakeOperationBinding {
	@IsUUID('4') @Matches(/^[0-9a-f-]+$/) commandId!: string;
	@IsString()
	@Matches(/^[^\s\x00-\x1f\x7f]{1,256}$/)
	recoverySubject!: string;
}

export function operationCanonical(value: unknown): string {
	if (Array.isArray(value))
		return '[' + value.map(operationCanonical).join(',') + ']';
	if (value && typeof value === 'object')
		return (
			'{' +
			Object.keys(value)
				.sort()
				.map(
					key =>
						JSON.stringify(key) +
						':' +
						operationCanonical((value as Record<string, unknown>)[key])
				)
				.join(',') +
			'}'
		);
	const result = JSON.stringify(value);
	if (result === undefined) throw new Error('Invalid canonical value');
	return result;
}
export const operationHash = (value: unknown) =>
	createHash('sha256').update(operationCanonical(value)).digest('hex');
export const operationBinding = (
	value: IntakeOperationBinding
): IntakeOperationBinding => ({
	schemaVersion: 1,
	workspaceId: value.workspaceId,
	workflowId: value.workflowId,
	operationId: value.operationId,
	actorSubject: value.actorSubject,
	payloadHash: value.payloadHash
});
export interface IntakeOperationProof extends IntakeOperationBinding {
	state: 'ABSENT' | 'COMMITTED' | 'CANCELLED';
	result: null | {
		contactId: string;
		dealId: string;
		firstTaskId: string;
	};
	committedAt: string | null;
}
