import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitOnlineConsultantLeadDto {
	@IsOptional()
	@IsString()
	@MaxLength(30)
	phone?: string;

	@IsOptional()
	@IsString()
	@IsEmail({}, { message: 'Укажите корректный email' })
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
