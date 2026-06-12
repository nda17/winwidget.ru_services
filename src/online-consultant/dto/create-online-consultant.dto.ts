import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateOnlineConsultantDto {
	@IsOptional()
	@IsString()
	@MaxLength(50)
	name?: string;
}
