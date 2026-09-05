import {
	Equals,
	IsEmail,
	IsInt,
	IsISO8601,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min
} from 'class-validator';

export class InvitationCommandDto {
	@Equals(1)
	schemaVersion!: 1;

	@IsUUID('4')
	commandId!: string;
}

export class CreateWorkspaceInvitationDto extends InvitationCommandDto {
	@IsUUID('4')
	invitationId!: string;

	@IsUUID('4')
	workspaceId!: string;

	@IsString()
	@Matches(/^[^\s\x00-\x1f\x7f]{1,256}$/)
	inviterSubject!: string;

	@IsEmail()
	@MaxLength(254)
	email!: string;

	@IsISO8601({ strict: true })
	expiresAt!: string;
}

export class AcceptWorkspaceInvitationDto extends InvitationCommandDto {
	@IsInt()
	@Min(1)
	@Max(2147483647)
	expectedVersion!: number;
}

export class RevokeWorkspaceInvitationDto extends InvitationCommandDto {
	@IsUUID('4')
	workspaceId!: string;
}

export class WorkspaceInvitationScopeDto {
	@Equals(1)
	schemaVersion!: 1;

	@IsUUID('4')
	workspaceId!: string;
}
export class WorkspaceInvitationDeliveryContextDto extends WorkspaceInvitationScopeDto {
	@IsUUID('4') eventId!: string;
}
