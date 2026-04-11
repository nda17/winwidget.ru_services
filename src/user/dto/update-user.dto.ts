import { IsBoolean, IsEmail, IsOptional, IsString, Matches } from 'class-validator'

export class UpdateUserDto {
	@IsOptional()
	@IsEmail()
	email?: string

	@IsOptional()
	@Matches(/^[0-9+()\-\s]{10,20}$/)
	phone?: string

	@IsOptional()
	@IsBoolean()
	isPhoneVerified?: boolean

	@IsOptional()
	@IsString()
	id?: string

	@IsOptional()
	@IsString()
	password?: string

	@IsOptional()
	@IsString()
	name?: string

	@IsOptional()
	@IsString()
	avatarPath?: string

	@IsOptional()
	@IsBoolean()
	isUser?: boolean

	@IsOptional()
	@IsBoolean()
	isAdmin?: boolean

	@IsOptional()
	@IsBoolean()
	isManager?: boolean

	@IsOptional()
	@IsBoolean()
	isPremium?: boolean
}
