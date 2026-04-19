import { IsString, Matches } from 'class-validator';

export class PhoneLoginDto {
	@Matches(/^[0-9+()\-\s]{10,20}$/, {
		message: 'Please enter a valid phone number'
	})
	@IsString()
	phone: string;

	@Matches(/(?=.*[0-9])(?=.*[a-z])(?=.*[A-Z])[0-9a-zA-Z]{6,}/, {
		message:
			'Min length should more 6 symbols. Contains 1 number 0-9, 1 Latin letter a-z, 1 Latin letter A-Z'
	})
	@IsString()
	password: string;
}
