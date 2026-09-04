import {
	Equals,
	IsInt,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min
} from 'class-validator';

export class InstallPipelineTemplateDto {
	@IsInt()
	@Equals(1)
	schemaVersion!: 1;

	@IsUUID('4')
	commandId!: string;

	@IsUUID('4')
	workspaceId!: string;

	@IsString()
	@MaxLength(64)
	@Matches(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
	templateKey!: string;

	@IsInt()
	@Min(1)
	@Max(32_767)
	templateVersion!: number;

	@IsString()
	@MaxLength(256)
	@Matches(/^[^\s\x00-\x1f\x7f]{1,256}$/)
	installedBySubject!: string;
}
