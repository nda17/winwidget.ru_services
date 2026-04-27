import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitCountdownTimerLeadDto {
	@IsString()
	key: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	phone?: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	email?: string;

	@IsOptional()
	@IsString()
	@MaxLength(500)
	url?: string;
}
