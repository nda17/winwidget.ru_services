import {
	Body,
	CanActivate,
	Controller,
	ExecutionContext,
	ForbiddenException,
	Header,
	Headers,
	HttpCode,
	Injectable,
	Post,
	UseGuards
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Equals, IsUUID } from 'class-validator';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { getCrmAccessCorrelationId } from '../common/crm-access-request-context';
import { IdentityAuthContextClient } from '../internal/identity-auth-context.client';
import { parseInternalToken } from '../internal/internal-http.config';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';

class SupportWorkspaceContextDto {
	@Equals(1) schemaVersion!: 1;
	@IsUUID('4') workspaceId!: string;
}

@Injectable()
export class SupportWorkspaceContextGuard implements CanActivate {
	private readonly token: Buffer | null;
	constructor(config: ConfigService) {
		const configured = config
			.get<string>('CRM_ACCESS_SUPPORT_TOKEN')
			?.trim();
		this.token = configured
			? Buffer.from(
					parseInternalToken('CRM_ACCESS_SUPPORT_TOKEN', configured, [
						'crm_access_support_token'
					])
				)
			: null;
	}
	canActivate(context: ExecutionContext): boolean {
		const request = context.switchToHttp().getRequest<Request>();
		const address = request.socket.remoteAddress?.replace(/^::ffff:/, '');
		const supplied = Buffer.from(
			request.header('x-winwidget-internal-token') || ''
		);
		if (
			!this.token ||
			request.header('x-winwidget-service') !== 'support' ||
			!(
				address === '::1' || /^127(?:\.\d{1,3}){3}$/.test(address || '')
			) ||
			supplied.length !== this.token.length ||
			!timingSafeEqual(supplied, this.token)
		) {
			throw new ForbiddenException('Invalid internal credentials');
		}
		return true;
	}
}

/** Support receives only company context; this grants no CRM business permission. */
@Controller('internal/v1/support/workspace-context')
@UseGuards(SupportWorkspaceContextGuard)
export class SupportWorkspaceContextController {
	constructor(
		private readonly identity: IdentityAuthContextClient,
		private readonly prisma: CrmAccessPrismaService
	) {}

	@Post()
	@HttpCode(200)
	@Header('Cache-Control', 'no-store')
	async context(
		@Headers('authorization') authorization: string | undefined,
		@Body() dto: SupportWorkspaceContextDto
	) {
		const identity = await this.identity.authContext(
			authorization,
			getCrmAccessCorrelationId()
		);
		const membership = identity.memberships.find(
			item => item.workspaceId === dto.workspaceId
		);
		if (!membership)
			throw new ForbiddenException('Workspace is not available');
		return this.prisma.$transaction(
			async tx => {
				const workspace = await tx.crmWorkspaceAccess.findUnique({
					where: { workspaceId: dto.workspaceId },
					select: { lifecycle: true }
				});
				if (
					!workspace ||
					!['ACTIVE', 'READ_ONLY'].includes(workspace.lifecycle)
				) {
					throw new ForbiddenException('Workspace is not available');
				}
				if (membership.role !== 'OWNER') {
					const member = await tx.crmWorkspaceMember.findUnique({
						where: {
							workspaceId_subject: {
								workspaceId: dto.workspaceId,
								subject: identity.subject
							}
						},
						select: { disabledAt: true, membershipId: true }
					});
					if (
						!member ||
						member.disabledAt ||
						member.membershipId !== membership.membershipId
					) {
						throw new ForbiddenException('Workspace is not available');
					}
				}
				const branding = await tx.crmWorkspaceBranding.findUnique({
					where: { workspaceId: dto.workspaceId },
					select: { displayName: true }
				});
				return {
					schemaVersion: 1 as const,
					subject: identity.subject,
					workspaceId: dto.workspaceId,
					companyName: branding?.displayName ?? null
				};
			},
			{ isolationLevel: 'RepeatableRead', maxWait: 500, timeout: 2000 }
		);
	}
}
