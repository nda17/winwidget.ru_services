import { IsString, MaxLength, MinLength } from 'class-validator';

export class CloseMessagingFailureDto {
	@IsString()
	@MinLength(3)
	@MaxLength(1_000)
	comment!: string;
}
