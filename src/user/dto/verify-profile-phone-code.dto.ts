import { IsString, Matches } from 'class-validator';

export class VerifyProfilePhoneCodeDto {
	@Matches(/^[0-9+()\-\s]{10,20}$/, {
		message: 'Please enter a valid phone number'
	})
	phone: string;

	@IsString()
	@Matches(/^\d{4,6}$/, {
		message: 'Please enter a valid verification code'
	})
	code: string;
}
