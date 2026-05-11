import {
	IsEmail,
	IsOptional,
	IsString,
	Matches,
	MaxLength
} from 'class-validator';

export class EmailRegisterDto {
	@IsEmail({}, { message: 'Please enter a valid email' })
	@IsString()
	email: string;

	@Matches(/^\d{4,6}$/, {
		message: 'Please enter a valid verification code'
	})
	@IsString()
	code: string;

	@IsOptional()
	@IsString()
	@MaxLength(80)
	referrerId?: string;
}
