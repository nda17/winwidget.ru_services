import { Type } from 'class-transformer';
import {
	ArrayMaxSize,
	IsArray,
	IsDefined,
	IsEmail,
	IsOptional,
	IsString,
	MaxLength,
	ValidateNested
} from 'class-validator';

export class CalculatorAnswerDto {
	@IsString()
	@MaxLength(64)
	fieldId: string;

	@IsDefined()
	value: unknown;
}

export class SubmitCalculatorLeadDto {
	@IsOptional()
	@IsString()
	@MaxLength(200)
	contact?: string;

	@IsOptional()
	@IsString()
	@MaxLength(30)
	phone?: string;

	@IsOptional()
	@IsEmail()
	@MaxLength(200)
	email?: string;

	@IsArray()
	@ArrayMaxSize(20)
	@ValidateNested({ each: true })
	@Type(() => CalculatorAnswerDto)
	answers: CalculatorAnswerDto[];

	@IsOptional()
	@IsString()
	@MaxLength(500)
	url?: string;
}
