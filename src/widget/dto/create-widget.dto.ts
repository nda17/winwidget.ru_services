import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateWidgetDto {
	@IsOptional()
	@IsString()
	@MaxLength(50)
	name?: string;
}
