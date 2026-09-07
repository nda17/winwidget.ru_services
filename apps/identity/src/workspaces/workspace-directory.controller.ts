import {
	Body,
	Controller,
	Header,
	HttpCode,
	NotFoundException,
	Param,
	ParseUUIDPipe,
	Post,
	ServiceUnavailableException,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import {
	ArrayMaxSize,
	ArrayUnique,
	Equals,
	IsArray,
	IsBoolean,
	IsUUID
} from 'class-validator';
import {
	IdentityInternalGuard,
	InternalServices
} from '../internal/internal.guard';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';

export class WorkspaceDirectoryDto {
	@Equals(1) schemaVersion!: 1;
	@IsArray()
	@ArrayMaxSize(100)
	@ArrayUnique()
	@IsUUID('4', { each: true })
	membershipIds!: string[];
}

// A bounded internal batch, not the public/admin employee directory. Missing,
// inactive and deleted bindings are omitted rather than represented as active.
export class AssigneeDirectoryDto {
	@Equals(1) schemaVersion!: 1;
	@IsArray()
	@ArrayMaxSize(1000)
	@ArrayUnique()
	@IsUUID('4', { each: true })
	membershipIds!: string[];
	@IsBoolean() includeOwner!: boolean;
}

export class ReminderDirectoryDto extends WorkspaceDirectoryDto {
	@IsBoolean() includeOwner!: boolean;
}

@Controller('internal/v1/crm-access/workspaces')
@UseGuards(IdentityInternalGuard)
@InternalServices('crm-access')
@UsePipes(
	new ValidationPipe({
		transform: true,
		whitelist: true,
		forbidNonWhitelisted: true,
		forbidUnknownValues: true
	})
)
export class WorkspaceDirectoryController {
	constructor(private readonly prisma: IdentityPrismaService) {}

	// Private delivery destinations, never included in the browser directory.
	@Post(':workspaceId/reminder-directory')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	async reminderDirectory(
		@Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
		workspaceId: string,
		@Body() dto: ReminderDirectoryDto
	) {
		return this.prisma.$transaction(
			async tx => {
				await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
				await tx.$executeRawUnsafe(
					"SET LOCAL statement_timeout = '1500ms'"
				);
				if (
					!(await tx.workspace.findFirst({
						where: { id: workspaceId, status: 'ACTIVE' },
						select: { id: true }
					}))
				)
					throw new NotFoundException(
						'Workspace directory is unavailable'
					);
				const members = await tx.workspaceMember.findMany({
					where: {
						workspaceId,
						status: 'ACTIVE',
						user: { status: 'ACTIVE', deletedAt: null },
						OR: [
							{ id: { in: dto.membershipIds } },
							...(dto.includeOwner ? [{ role: 'OWNER' as const }] : [])
						]
					},
					select: {
						id: true,
						userId: true,
						role: true,
						user: {
							select: {
								authIdentities: {
									where: { type: 'EMAIL', verifiedAt: { not: null } },
									select: { value: true },
									orderBy: { id: 'asc' },
									take: 1
								},
								telegramNotificationChannel: {
									select: {
										chatId: true,
										isActive: true,
										disabledAt: true
									}
								}
							}
						}
					},
					orderBy: { id: 'asc' },
					take: 102
				});
				if (
					members.length >
						dto.membershipIds.length + Number(dto.includeOwner) ||
					members.filter(member => member.role === 'OWNER').length > 1
				)
					throw new ServiceUnavailableException(
						'Workspace owner binding is ambiguous'
					);
				return {
					schemaVersion: 1 as const,
					workspaceId,
					items: members.map(member => {
						const email =
							member.user.authIdentities[0]?.value.trim().toLowerCase() ??
							null;
						const channel = member.user.telegramNotificationChannel;
						const chatId = channel?.chatId.trim();
						return {
							membershipId: member.id,
							subject: member.userId,
							workspaceRole: member.role,
							email:
								email &&
								email.length <= 254 &&
								/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
									? email
									: null,
							telegramChatId:
								channel?.isActive &&
								channel.disabledAt === null &&
								chatId &&
								/^[1-9][0-9]{0,18}$/.test(chatId)
									? chatId
									: null
						};
					})
				};
			},
			{ isolationLevel: 'RepeatableRead', maxWait: 500, timeout: 2000 }
		);
	}

	@Post(':workspaceId/assignee-directory')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	async assignees(
		@Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
		workspaceId: string,
		@Body() dto: AssigneeDirectoryDto
	) {
		return this.prisma.$transaction(
			async tx => {
				await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
				await tx.$executeRawUnsafe(
					"SET LOCAL statement_timeout = '1500ms'"
				);
				if (
					!(await tx.workspace.findFirst({
						where: { id: workspaceId, status: 'ACTIVE' },
						select: { id: true }
					}))
				)
					throw new NotFoundException(
						'Workspace directory is unavailable'
					);
				const members = await tx.workspaceMember.findMany({
					where: {
						workspaceId,
						status: 'ACTIVE',
						user: { status: 'ACTIVE', deletedAt: null },
						OR: [
							{ id: { in: dto.membershipIds } },
							...(dto.includeOwner ? [{ role: 'OWNER' as const }] : [])
						]
					},
					select: {
						id: true,
						userId: true,
						role: true,
						user: {
							select: {
								name: true,
								authIdentities: {
									where: { type: 'EMAIL', verifiedAt: { not: null } },
									select: { value: true },
									orderBy: { id: 'asc' },
									take: 1
								}
							}
						}
					},
					orderBy: { id: 'asc' },
					take: 1002
				});
				if (
					members.length > 1001 ||
					members.filter(member => member.role === 'OWNER').length > 1
				)
					throw new ServiceUnavailableException(
						'Workspace owner binding is ambiguous'
					);
				return {
					schemaVersion: 1 as const,
					workspaceId,
					items: members.map(member => ({
						membershipId: member.id,
						subject: member.userId,
						workspaceRole: member.role,
						displayName: member.user.name,
						verifiedEmail: member.user.authIdentities[0]?.value ?? null
					}))
				};
			},
			{ isolationLevel: 'RepeatableRead', maxWait: 500, timeout: 2000 }
		);
	}

	@Post(':workspaceId/member-directory')
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	async directory(
		@Param('workspaceId', new ParseUUIDPipe({ version: '4' }))
		workspaceId: string,
		@Body() dto: WorkspaceDirectoryDto
	) {
		const workspace = await this.prisma.workspace.findFirst({
			where: { id: workspaceId, status: 'ACTIVE' },
			select: { id: true }
		});
		if (!workspace)
			throw new NotFoundException('Workspace directory is unavailable');
		const members = await this.prisma.workspaceMember.findMany({
			where: { workspaceId, id: { in: dto.membershipIds } },
			select: {
				id: true,
				userId: true,
				user: {
					select: {
						name: true,
						status: true,
						deletedAt: true,
						authIdentities: {
							where: { type: 'EMAIL', verifiedAt: { not: null } },
							select: { value: true },
							take: 1
						}
					}
				}
			}
		});
		if (members.length !== dto.membershipIds.length)
			throw new NotFoundException('Workspace directory is unavailable');
		return {
			schemaVersion: 1,
			workspaceId,
			items: members.map(member => ({
				membershipId: member.id,
				subject: member.userId,
				displayName:
					member.user.status === 'ACTIVE' && !member.user.deletedAt
						? member.user.name
						: null,
				verifiedEmail:
					member.user.status === 'ACTIVE' && !member.user.deletedAt
						? (member.user.authIdentities[0]?.value ?? null)
						: null
			}))
		};
	}
}
