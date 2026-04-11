import { IsString, Matches } from 'class-validator'

export class SendPhoneCodeDto {
	@Matches(/^[0-9+()\-\s]{10,20}$/, {
		message: 'Please enter a valid phone number'
	})
	@IsString()
	phone: string
}
