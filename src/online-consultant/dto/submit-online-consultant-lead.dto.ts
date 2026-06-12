import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitOnlineConsultantLeadDto {
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
	@MaxLength(120)
	actionLabel?: string;

	@IsOptional()
	@IsString()
	@MaxLength(2000)
	actionValue?: string;

	@IsOptional()
	@IsString()
	@MaxLength(500)
	url?: string;
}
