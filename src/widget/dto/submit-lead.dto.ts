import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitLeadDto {
	@IsString()
	key: string;

	@IsString()
	@MaxLength(200)
	contact: string;

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
	@MaxLength(200)
	name?: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	bonus?: string;

	@IsOptional()
	@IsString()
	@MaxLength(500)
	url?: string;
}
