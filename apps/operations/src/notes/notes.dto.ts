import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class CreateNoteDto {
	@IsString()
	text!: string;
}

export class UpdateNoteDto {
	@IsOptional()
	@IsString()
	text?: string;

	@IsOptional()
	@IsBoolean()
	done?: boolean;
}
