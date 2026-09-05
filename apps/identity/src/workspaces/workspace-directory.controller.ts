import {
	Body,
	Controller,
	Header,
	HttpCode,
	NotFoundException,
	Param,
	ParseUUIDPipe,
	Post,
	UseGuards,
	UsePipes,
	ValidationPipe
} from '@nestjs/common';
import {
	ArrayMaxSize,
	ArrayUnique,
	Equals,
	IsArray,
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
