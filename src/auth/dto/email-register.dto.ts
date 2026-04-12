import { IsEmail, IsString, Matches } from 'class-validator';

export class EmailRegisterDto {
	@IsEmail({}, { message: 'Please enter a valid email' })
	@IsString()
	email: string;

	@Matches(/^\d{4,6}$/, {
		message: 'Please enter a valid verification code'
	})
	@IsString()
	code: string;
}
