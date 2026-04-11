import { IsEmail, IsOptional, IsString, ValidateIf } from 'class-validator'

export class RestorePasswordDto {
	@ValidateIf((value) => !value.phone)
	@IsEmail()
	@IsOptional()
	email?: string

	@ValidateIf((value) => !value.email)
	@IsString()
	@IsOptional()
	phone?: string
}
