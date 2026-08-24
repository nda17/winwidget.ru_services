import { IsObject } from 'class-validator';

export class UpdateStructuredHomePageContentDto {
	@IsObject()
	content!: Record<string, unknown>;
}

export class UpdateRawHomePageContentDto {
	@IsObject()
	content!: Record<string, unknown>;
}
