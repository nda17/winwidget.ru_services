import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCallbackDto {
	@IsOptional()
	@IsString()
	@MaxLength(15)
	name?: string;
}
