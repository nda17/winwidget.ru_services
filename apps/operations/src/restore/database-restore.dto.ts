import { DatabaseRestoreRecoveryActionType } from '@prisma/operations-client';
import {
	IsEnum,
	IsIn,
	IsString,
	IsUUID,
	Matches,
	MaxLength
} from 'class-validator';
import {
	DATABASE_RESTORE_SERVICES_SHA_PATTERN,
	DATABASE_RESTORE_SHA256_PATTERN,
	DATABASE_RESTORE_TARGETS
} from './database-restore.contract';

export class EnqueueDatabaseRestoreDto {
	@IsString()
	@MaxLength(100)
	confirmation!: string;

	@IsUUID('4')
	requestId!: string;
}

export class CreateDatabaseRestorePermitDto {
	@IsString()
	@IsIn(DATABASE_RESTORE_TARGETS)
	target!: string;

	@Matches(DATABASE_RESTORE_SHA256_PATTERN)
	sourceSha256!: string;

	@Matches(DATABASE_RESTORE_SERVICES_SHA_PATTERN)
	expectedServicesSha!: string;

	@IsString()
	@MaxLength(16384)
	backupProvenance!: string;
}

export class CreateDatabaseRestoreRecoveryActionDto {
	@IsEnum(DatabaseRestoreRecoveryActionType)
	action!: DatabaseRestoreRecoveryActionType;
}
