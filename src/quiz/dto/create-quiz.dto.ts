import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateQuizDto {
	@IsOptional()
	@IsString()
	@MaxLength(15)
	name?: string;
}
