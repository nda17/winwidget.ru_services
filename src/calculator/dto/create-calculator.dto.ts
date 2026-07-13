import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCalculatorDto {
	@IsOptional()
	@IsString()
	@MaxLength(50)
	name?: string;
}
