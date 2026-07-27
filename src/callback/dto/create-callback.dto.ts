import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCallbackDto {
	@IsOptional()
	@IsString()
	@MaxLength(50)
	name?: string;
}
