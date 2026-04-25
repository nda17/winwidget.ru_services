import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitCallbackLeadDto {
	@IsString()
	key: string;

	@IsString()
	@MaxLength(30)
	phone: string;

	@IsOptional()
	@IsString()
	@MaxLength(100)
	timeSlot?: string;

	@IsOptional()
	@IsString()
	@MaxLength(100)
	timezone?: string;

	@IsOptional()
	@IsString()
	@MaxLength(500)
	url?: string;
}
