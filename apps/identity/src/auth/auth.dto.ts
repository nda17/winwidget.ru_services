import {
	Equals,
	IsArray,
	IsBoolean,
	IsEmail,
	IsIn,
	IsInt,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	ValidateIf
} from 'class-validator';

const PASSWORD = /(?=.*[0-9])(?=.*[a-z])(?=.*[A-Z])\S{6,}/;
const PHONE = /^[0-9+()\-\s]{10,20}$/;
const CODE = /^\d{4,6}$/;

export class AuthDto {
	@Matches(
		/^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
		{ message: 'Please enter a valid email' }
	)
	@IsEmail()
	email!: string;

	@Matches(PASSWORD, {
		message:
			'Min length should more 6 symbols. Contains 1 number 0-9, 1 Latin letter a-z, 1 Latin letter A-Z'
	})
	@IsString()
	password!: string;
}

export class EmailRegisterDto {
	@IsEmail({}, { message: 'Please enter a valid email' })
	@IsString()
	email!: string;

	@Matches(CODE, { message: 'Please enter a valid verification code' })
	@IsString()
	code!: string;

	@IsOptional()
	@IsString()
	@MaxLength(80)
	referrerId?: string;
}

export class ResendEmailCodeDto {
	@IsEmail({}, { message: 'Please enter a valid email' })
	@IsString()
	email!: string;
}

export class PhoneDto {
	@Matches(PHONE, { message: 'Please enter a valid phone number' })
	@IsString()
	phone!: string;
}

export class PhoneRegisterDto extends PhoneDto {
	@Matches(PASSWORD, {
		message:
			'Min length should more 6 symbols. Contains 1 number 0-9, 1 Latin letter a-z, 1 Latin letter A-Z'
	})
	@IsString()
	password!: string;

	@Matches(CODE, { message: 'Please enter a valid verification code' })
	@IsString()
	code!: string;

	@IsOptional()
	@IsString()
	@MaxLength(80)
	referrerId?: string;
}

export class PhoneLoginDto extends PhoneDto {
	@Matches(PASSWORD, {
		message:
			'Min length should more 6 symbols. Contains 1 number 0-9, 1 Latin letter a-z, 1 Latin letter A-Z'
	})
	@IsString()
	password!: string;
}

export class RestorePasswordDto {
	@ValidateIf(value => !value.phone)
	@IsEmail()
	@IsOptional()
	email?: string;

	@ValidateIf(value => !value.email)
	@IsString()
	@IsOptional()
	phone?: string;
}

export class VerificationDto {
	@Matches(CODE)
	@IsString()
	code!: string;
}

export class BindEmailStartDto {
	@IsEmail()
	email!: string;
}

export class BindEmailVerifyDto extends BindEmailStartDto {
	@Matches(CODE)
	@IsString()
	code!: string;
}

export class BindPhoneVerifyDto extends PhoneDto {
	@Matches(CODE)
	@IsString()
	code!: string;
}

export class UpdateProfileDto {
	@IsOptional()
	@IsString()
	@Matches(/^[a-zA-Z][a-zA-Z0-9-]+$/)
	name?: string;

	@IsOptional()
	@ValidateIf(value => value.avatarPath !== null)
	@IsString()
	avatarPath?: string | null;

	@IsOptional()
	@IsString()
	@Matches(PASSWORD, {
		message:
			'Мин. длина 6 символов. Должен содержать 1 цифру 0-9, 1 строчную букву a-z и 1 заглавную букву A-Z.'
	})
	password?: string;
}

export class UpdateUserDto {
	@IsOptional()
	@ValidateIf((_, value) => value !== '')
	@IsEmail()
	email?: string;

	@IsOptional()
	@ValidateIf((_, value) => value !== '')
	@Matches(PHONE)
	phone?: string;

	@IsOptional()
	@IsBoolean()
	isPhoneVerified?: boolean;

	@IsOptional()
	@IsString()
	password?: string;

	@IsOptional()
	@IsString()
	name?: string;

	@IsOptional()
	@ValidateIf((_, value) => value !== null)
	@IsString()
	avatarPath?: string | null;

	@IsOptional()
	@IsBoolean()
	isUser?: boolean;

	@IsOptional()
	@IsBoolean()
	isAdmin?: boolean;

	@IsOptional()
	@IsBoolean()
	isDev?: boolean;
}

export class UpdateAuthSettingsDto {
	@IsOptional()
	@IsBoolean()
	recaptchaEnabled?: boolean;
	@IsOptional()
	@IsBoolean()
	googleAuthEnabled?: boolean;
	@IsOptional()
	@IsBoolean()
	yandexAuthEnabled?: boolean;
	@IsOptional()
	@IsBoolean()
	githubAuthEnabled?: boolean;
	@IsOptional()
	@IsBoolean()
	vkAuthEnabled?: boolean;
	@IsOptional()
	@IsBoolean()
	telegramAuthEnabled?: boolean;
}

export class TelegramRequestDto {
	@IsString()
	@MaxLength(255)
	requestId!: string;
}

export class TelegramCompleteDto extends TelegramRequestDto {
	@IsOptional()
	@IsString()
	@MaxLength(128)
	referrerId?: string;
}

export class TelegramVerifyDto extends TelegramCompleteDto {
	@Matches(CODE, { message: 'Please enter a valid verification code' })
	code!: string;
}

export class DirectoryResolveDto {
	@IsArray()
	@IsString({ each: true })
	userIds!: string[];
}

export class DirectorySearchDto {
	@IsOptional()
	@IsString()
	@MaxLength(200)
	search?: string;

	@IsOptional()
	@IsString()
	@MaxLength(255)
	afterId?: string;

	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(100)
	limit?: number;

	@IsOptional()
	@IsIn(['TRIAL', 'EASY', 'HARD', 'NONE'])
	plan?: string;
}

export class LifecycleCompleteDto {
	@IsInt()
	@Equals(1)
	schemaVersion!: number;
	@IsUUID()
	commandId!: string;
	@IsString()
	userId!: string;
	@IsIn(['DEACTIVATE', 'DELETE'])
	operation!: 'DEACTIVATE' | 'DELETE';
	@IsString()
	actorId!: string;
	@IsIn(['ADMIN', 'DEV'])
	actorRole!: 'ADMIN' | 'DEV';
	@IsString()
	requestedAt!: string;
}
