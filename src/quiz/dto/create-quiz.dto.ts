import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateQuizDto {
	@IsOptional()
	@IsString()
	@MaxLength(50)
	name?: string;
}
