import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateNoteDto {
	@IsOptional()
	@IsString()
	text?: string;

	@IsOptional()
	@IsBoolean()
	done?: boolean;
}
