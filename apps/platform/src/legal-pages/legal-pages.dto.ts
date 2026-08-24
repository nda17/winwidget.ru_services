import { IsString, MaxLength } from 'class-validator';

export class UpdatePlatformLegalPageDto {
	@IsString()
	@MaxLength(1024 * 1024)
	content!: string;
}
