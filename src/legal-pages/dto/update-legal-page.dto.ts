import { IsString } from 'class-validator';

export class UpdateLegalPageDto {
	@IsString()
	content: string;
}
