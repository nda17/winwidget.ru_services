import { IsEmail, IsString } from 'class-validator'

export class ResendEmailCodeDto {
	@IsEmail({}, { message: 'Please enter a valid email' })
	@IsString()
	email: string
}
