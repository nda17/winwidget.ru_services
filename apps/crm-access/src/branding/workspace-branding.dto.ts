import { BadRequestException } from '@nestjs/common';
import {
	Equals,
	IsInt,
	IsString,
	IsUUID,
	Max,
	MaxLength,
	Min,
	MinLength,
	ValidateIf
} from 'class-validator';

export class WorkspaceBrandingQueryDto {
	@IsUUID('4')
	workspaceId!: string;
}

export class UpdateWorkspaceBrandingDto extends WorkspaceBrandingQueryDto {
	@Equals(1)
	schemaVersion!: 1;

	@IsUUID('4')
	commandId!: string;

	@IsString()
	@MinLength(1)
	@MaxLength(256)
	expectedActorSubject!: string;

	@IsInt()
	@Min(0)
	@Max(2147483646)
	expectedVersion!: number;

	@ValidateIf((_object, value) => value !== null)
	@IsString()
	@MaxLength(4096)
	displayName!: string | null;
}

export function normalizeWorkspaceDisplayName(
	value: unknown
): string | null {
	if (value === null) return null;
	if (
		typeof value !== 'string' ||
		value.length > 4096 ||
		/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}<>]/u.test(value)
	)
		throw new BadRequestException('Workspace display name is invalid');
	const normalized = value.normalize('NFC').trim();
	if (Array.from(normalized).length > 40)
		throw new BadRequestException(
			'Workspace display name must not exceed 40 characters'
		);
	return normalized || null;
}
