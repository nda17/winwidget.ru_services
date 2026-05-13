import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateStopOfferDto {
	@IsOptional()
	@IsString()
	@MaxLength(50)
	name?: string;
}
