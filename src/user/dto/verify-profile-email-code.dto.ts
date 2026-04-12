import { IsEmail, IsString, Matches } from 'class-validator'

export class VerifyProfileEmailCodeDto {
	@IsEmail({}, { message: 'Please enter a valid email' })
	email: string

	@IsString()
	@Matches(/^\d{4,6}$/, {
		message: 'Please enter a valid verification code'
	})
	code: string
}
