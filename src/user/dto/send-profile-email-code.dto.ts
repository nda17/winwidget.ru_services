import { IsEmail } from 'class-validator';

export class SendProfileEmailCodeDto {
	@IsEmail({}, { message: 'Please enter a valid email' })
	email: string;
}
