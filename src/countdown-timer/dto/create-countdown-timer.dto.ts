import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCountdownTimerDto {
	@IsOptional()
	@IsString()
	@MaxLength(50)
	name?: string;
}
