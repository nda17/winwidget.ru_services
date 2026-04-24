import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitQuizLeadDto {
	@IsString()
	key: string;

	@IsString()
	@MaxLength(200)
	contact: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	phone?: string;

	@IsOptional()
	@IsString()
	@MaxLength(200)
	email?: string;

	// [{ questionId: string, optionIds: string[] }]
	@IsArray()
	answers: { questionId: string; optionIds: string[] }[];

	@IsOptional()
	@IsString()
	@MaxLength(500)
	url?: string;
}
