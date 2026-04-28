import {
	IsOptional,
	IsString,
	Matches,
	ValidateIf
} from 'class-validator';

export class UpdateProfileDto {
	@IsOptional()
	@Matches(/^[a-zA-Z][a-zA-Z0-9-]+$/)
	name?: string;

	@IsOptional()
	@ValidateIf(o => o.avatarPath !== null)
	@IsString()
	avatarPath?: string | null;

	@IsOptional()
	@IsString()
	@Matches(/(?=.*[0-9])(?=.*[a-z])(?=.*[A-Z])\S{6,}/, {
		message:
			'Мин. длина 6 символов. Должен содержать 1 цифру 0-9, 1 строчную букву a-z и 1 заглавную букву A-Z.'
	})
	password?: string;
}
