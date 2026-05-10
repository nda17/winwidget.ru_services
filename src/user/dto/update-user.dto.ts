import {
	IsBoolean,
	IsEmail,
	IsOptional,
	IsString,
	Matches,
	ValidateIf
} from 'class-validator';

export class UpdateUserDto {
	@IsOptional()
	@ValidateIf((_, value) => value !== '')
	@IsEmail()
	email?: string;

	@IsOptional()
	@ValidateIf((_, value) => value !== '')
	@Matches(/^[0-9+()\-\s]{10,20}$/)
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
	@IsString()
	avatarPath?: string;

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
