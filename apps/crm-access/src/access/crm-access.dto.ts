import { Equals, IsInt, IsOptional, IsUUID } from 'class-validator';

export class CrmBootstrapQueryDto {
	@IsOptional()
	@IsUUID('4')
	workspaceId?: string;
}

export class ActivateCrmTrialDto {
	@IsInt()
	@Equals(1)
	schemaVersion!: 1;

	@IsUUID('4')
	commandId!: string;

	@IsUUID('4')
	workspaceId!: string;
}
