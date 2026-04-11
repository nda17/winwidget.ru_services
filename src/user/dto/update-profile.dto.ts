import { IsOptional, IsString, Matches } from 'class-validator'

export class UpdateProfileDto {
	@IsOptional()
	@Matches(/^[a-zA-Z][a-zA-Z0-9-]+$/)
	name?: string

	@IsOptional()
	@IsString()
	avatarPath?: string

	@IsOptional()
	@IsString()
	@Matches(/(?=.*[0-9])(?=.*[a-z])(?=.*[A-Z])[0-9a-zA-Z]{6,}/, {
		message:
			'Мин. длина 6 символов. Должен содержать 1 цифру 0-9, 1 строчную букву a-z и 1 заглавную букву A-Z.'
	})
	password?: string
}
