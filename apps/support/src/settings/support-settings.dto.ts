import { IsInt, IsString, Matches, Max, Min } from 'class-validator';

export class UpdateSupportRoutingSettingsDto {
	@IsString()
	@Matches(/^(?:-?[1-9]\d*|@[A-Za-z][A-Za-z0-9_]{4,31})$/)
	adminChatId!: string;

	@IsInt()
	@Min(1)
	@Max(2_147_483_647)
	supportThreadId!: number;
}
