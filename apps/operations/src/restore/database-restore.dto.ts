import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class EnqueueDatabaseRestoreDto {
	@IsString()
	@MaxLength(100)
	confirmation!: string;

	@IsOptional()
	@IsUUID('4')
	requestId?: string;
}
