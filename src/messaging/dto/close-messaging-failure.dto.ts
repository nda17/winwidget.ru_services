import { IsString, MaxLength, MinLength } from 'class-validator';

export class CloseMessagingFailureDto {
	@IsString()
	@MinLength(3)
	@MaxLength(1000)
	comment: string;
}
