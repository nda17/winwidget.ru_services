import { IsObject } from 'class-validator';

export class UpdateHomePageContentDto {
	@IsObject()
	content: Record<string, unknown>;
}
