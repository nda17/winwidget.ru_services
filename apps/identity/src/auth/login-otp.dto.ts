import {
	IsIn,
	IsString,
	IsUUID,
	Matches,
	MaxLength
} from 'class-validator';

export type LoginOtpChannel = 'EMAIL' | 'SMS';

export class RequestLoginOtpDto {
	@IsIn(['EMAIL', 'SMS'])
	channel!: LoginOtpChannel;

	@IsString()
	@MaxLength(254)
	destination!: string;
}

export class VerifyLoginOtpDto {
	@IsUUID('4')
	challengeId!: string;

	@Matches(/^[A-Za-z0-9_-]{43}$/)
	browserToken!: string;

	@Matches(/^\d{6}$/)
	code!: string;
}
