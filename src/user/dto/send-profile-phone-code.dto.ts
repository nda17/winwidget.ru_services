import { Matches } from 'class-validator'

export class SendProfilePhoneCodeDto {
	@Matches(/^[0-9+()\-\s]{10,20}$/, {
		message: 'Please enter a valid phone number'
	})
	phone: string
}
