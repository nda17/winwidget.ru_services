import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	AuthIdentityType,
	Prisma,
	UserStatus,
	WorkspaceMemberStatus,
	WorkspaceStatus,
	type WorkspaceInvitation
} from '@prisma/identity-client';
import { randomUUID } from 'node:crypto';
import { normalizeEmail, sha256 } from '../common/identity.util';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import type {
	AcceptWorkspaceInvitationDto,
	CreateWorkspaceInvitationDto,
	RevokeWorkspaceInvitationDto
} from './workspace-invitation.dto';

const ACCEPTED_EVENT = 'identity.wincrm.invitation-accepted.v1';
const MAX_TTL_MS = 7 * 86400000;
const SCOPE = { client: 'wincrm', command: 'workspace-invitation' };

@Injectable()
export class WorkspaceInvitationService {
	private readonly emailEnabled: boolean;
	constructor(
		private readonly prisma: IdentityPrismaService,
		config: ConfigService = new ConfigService()
	) {
		const enabled =
			config.get<string>('WINCRM_INVITATION_EMAIL_ENABLED')?.trim() ||
			'false';
		if (!['true', 'false'].includes(enabled))
			throw new Error(
				'WINCRM_INVITATION_EMAIL_ENABLED must be true or false'
			);
		this.emailEnabled = enabled === 'true';
	}
	async deliveryContext(
		invitationId: string,
		workspaceId: string,
		eventId: string
	) {
		const invitation = await this.prisma.workspaceInvitation.findFirst({
			where: {
				id: invitationId,
				workspaceId,
				notificationEventId: eventId,
				productCode: 'WINCRM'
			}
		});
		if (!invitation)
			throw new NotFoundException('Invitation delivery is unavailable');
		const workspace = await this.prisma.workspace.findFirst({
			where: { id: workspaceId, status: 'ACTIVE' },
			select: { id: true }
		});
		const deliver =
			this.emailEnabled &&
			Boolean(workspace) &&
			invitation.status === 'PENDING' &&
			invitation.expiresAt > new Date();
		return {
			schemaVersion: 1,
			invitationId,
			workspaceId,
			eventId,
			deliver,
			email: deliver ? invitation.email : null,
			expiresAt: invitation.expiresAt.toISOString()
		};
	}

	async create(dto: CreateWorkspaceInvitationDto) {
		await this.requireInviter(dto.workspaceId, dto.inviterSubject);
		const email = normalizeEmail(dto.email);
		return this.command(
			dto.commandId,
			{ kind: 'create', actor: dto.inviterSubject, ...dto, email },
			async tx => {
				const now = new Date();
				const expiry = new Date(dto.expiresAt);
				if (
					!Number.isFinite(expiry.getTime()) ||
					expiry.toISOString() !== dto.expiresAt ||
					expiry <= now ||
					expiry.getTime() > now.getTime() + MAX_TTL_MS
				)
					throw new BadRequestException(
						'Invitation expiry must be a canonical date within seven days'
					);
				if (
					await tx.workspaceInvitation.findUnique({
						where: { id: dto.invitationId }
					})
				)
					throw new ConflictException(
						'Invitation identity is already used'
					);
				const invitation = await tx.workspaceInvitation.create({
					data: {
						id: dto.invitationId,
						workspaceId: dto.workspaceId,
						inviterSubject: dto.inviterSubject,
						email,
						notificationEventId: this.emailEnabled ? randomUUID() : null,
						expiresAt: expiry,
						createdAt: now
					}
				});
				if (invitation.notificationEventId)
					await tx.outboxEvent.create({
						data: {
							messageId: invitation.notificationEventId,
							deduplicationKey: `wincrm-invitation-email:${invitation.id}`,
							eventType:
								'notification.wincrm.invitation.email.requested.v1',
							routingKey:
								'notification.wincrm.invitation.email.requested.v1',
							payload: {
								schemaVersion: 1,
								eventId: invitation.notificationEventId,
								eventType:
									'notification.wincrm.invitation.email.requested.v1',
								occurredAt: now.toISOString(),
								reference: {
									type: 'wincrm-invitation',
									id: invitation.id,
									workspaceId: invitation.workspaceId
								},
								destination: { email },
								content: {
									invitationId: invitation.id,
									expiresAt: invitation.expiresAt.toISOString()
								}
							}
						}
					});
				return this.result(invitation);
			}
		);
	}

	async revoke(invitationId: string, dto: RevokeWorkspaceInvitationDto) {
		return this.command(
			dto.commandId,
			{ kind: 'revoke', caller: 'crm-access', invitationId, ...dto },
			async tx => {
				const invitation = await tx.workspaceInvitation.findFirst({
					where: {
						id: invitationId,
						workspaceId: dto.workspaceId,
						productCode: 'WINCRM'
					}
				});
				if (!invitation)
					throw new NotFoundException('Invitation not found');
				if (invitation.status === 'REVOKED')
					return this.result(invitation);
				const changed = await tx.workspaceInvitation.updateMany({
					where: { id: invitation.id, version: invitation.version },
					data: {
						status: 'REVOKED',
						revokedAt: new Date(),
						version: { increment: 1 }
					}
				});
				if (changed.count !== 1)
					throw new ConflictException('Invitation version conflict');
				return this.result(
					await tx.workspaceInvitation.findUniqueOrThrow({
						where: { id: invitation.id }
					})
				);
			}
		);
	}

	async preview(invitationId: string, subject: string) {
		const invitation = await this.prisma.workspaceInvitation.findUnique({
			where: { id: invitationId }
		});
		if (!invitation) throw new NotFoundException('Invitation not found');
		await this.requireAddress(this.prisma, invitation, subject);
		return this.result(invitation);
	}

	async accept(
		invitationId: string,
		subject: string,
		dto: AcceptWorkspaceInvitationDto
	) {
		const invitation = await this.prisma.workspaceInvitation.findUnique({
			where: { id: invitationId }
		});
		if (!invitation) throw new NotFoundException('Invitation not found');
		// Authentication and verified address are rechecked even for a command replay.
		await this.requireAddress(this.prisma, invitation, subject);
		return this.command(
			dto.commandId,
			{ kind: 'accept', subject, invitationId, ...dto },
			async tx => {
				const current = await tx.workspaceInvitation.findUniqueOrThrow({
					where: { id: invitationId }
				});
				const email = await this.requireAddress(tx, current, subject);
				if (
					current.status === 'ACCEPTED' &&
					current.acceptedSubject === subject
				)
					return this.acceptance(current);
				if (
					current.status !== 'PENDING' ||
					current.expiresAt <= new Date()
				)
					throw new ConflictException('Invitation is not open');
				if (current.version !== dto.expectedVersion)
					throw new ConflictException('Invitation version conflict');
				const workspace = await tx.workspace.findFirst({
					where: {
						id: current.workspaceId,
						status: WorkspaceStatus.ACTIVE
					}
				});
				if (!workspace)
					throw new ForbiddenException('Workspace is not active');
				let membership = await tx.workspaceMember.findUnique({
					where: {
						workspaceId_userId: {
							workspaceId: current.workspaceId,
							userId: subject
						}
					}
				});
				if (
					membership &&
					(membership.status !== WorkspaceMemberStatus.ACTIVE ||
						membership.role === 'OWNER')
				)
					throw new ConflictException(
						'Existing membership cannot be activated by an invitation'
					);
				if (!membership)
					membership = await tx.workspaceMember.create({
						data: {
							workspaceId: current.workspaceId,
							userId: subject,
							role: 'MEMBER',
							status: 'ACTIVE',
							createdByProduct: 'WINCRM',
							createdByInvitationId: current.id
						}
					});
				const acceptedAt = new Date();
				const acceptanceId = randomUUID();
				const changed = await tx.workspaceInvitation.updateMany({
					where: {
						id: current.id,
						version: current.version,
						status: 'PENDING'
					},
					data: {
						status: 'ACCEPTED',
						acceptedSubject: subject,
						acceptedMembershipId: membership.id,
						acceptanceId,
						acceptedAt,
						emailVerifiedAt: email.verifiedAt,
						version: { increment: 1 }
					}
				});
				if (changed.count !== 1)
					throw new ConflictException('Invitation version conflict');
				const updated = await tx.workspaceInvitation.findUniqueOrThrow({
					where: { id: current.id }
				});
				const eventId = randomUUID();
				await tx.outboxEvent.create({
					data: {
						messageId: eventId,
						deduplicationKey: `${ACCEPTED_EVENT}:${acceptanceId}`,
						eventType: ACCEPTED_EVENT,
						routingKey: ACCEPTED_EVENT,
						aggregateType: 'workspace-invitation',
						aggregateId: current.id,
						aggregateVersion: BigInt(updated.version),
						payload: {
							schemaVersion: 1,
							eventId,
							eventType: ACCEPTED_EVENT,
							invitationId: current.id,
							invitationVersion: updated.version,
							workspaceId: current.workspaceId,
							acceptanceId,
							subject,
							membershipId: membership.id,
							occurredAt: acceptedAt.toISOString()
						}
					}
				});
				return this.acceptance(updated);
			}
		);
	}

	async acceptanceContext(invitationId: string, workspaceId: string) {
		const invitation = await this.prisma.workspaceInvitation.findFirst({
			where: { id: invitationId, workspaceId, productCode: 'WINCRM' }
		});
		if (!invitation) throw new NotFoundException('Invitation not found');
		if (invitation.status !== 'ACCEPTED' || !invitation.acceptedSubject)
			throw new ConflictException('Invitation acceptance is not active');
		await this.requireAddress(
			this.prisma,
			invitation,
			invitation.acceptedSubject
		);
		const membership = await this.prisma.workspaceMember.findFirst({
			where: {
				id: invitation.acceptedMembershipId!,
				workspaceId,
				userId: invitation.acceptedSubject,
				status: 'ACTIVE',
				workspace: { status: 'ACTIVE' }
			}
		});
		if (!membership)
			throw new ForbiddenException('Membership is no longer active');
		return this.acceptance(invitation);
	}

	private async requireInviter(workspaceId: string, subject: string) {
		const member = await this.prisma.workspaceMember.findFirst({
			where: {
				workspaceId,
				userId: subject,
				status: 'ACTIVE',
				workspace: { status: 'ACTIVE' },
				user: { status: UserStatus.ACTIVE, deletedAt: null }
			}
		});
		if (!member)
			throw new ForbiddenException(
				'Inviter is not an active workspace member'
			);
	}

	private async requireAddress(
		tx: Prisma.TransactionClient,
		invitation: WorkspaceInvitation,
		subject: string
	) {
		const identity = await tx.authIdentity.findFirst({
			where: {
				userId: subject,
				type: AuthIdentityType.EMAIL,
				value: invitation.email,
				verifiedAt: { not: null },
				user: { status: UserStatus.ACTIVE, deletedAt: null }
			}
		});
		if (!identity) throw new NotFoundException('Invitation not found');
		return identity;
	}

	private result(invitation: WorkspaceInvitation) {
		return {
			schemaVersion: 1 as const,
			invitation: {
				id: invitation.id,
				workspaceId: invitation.workspaceId,
				productCode: 'WINCRM' as const,
				version: invitation.version,
				status:
					invitation.status === 'PENDING' &&
					invitation.expiresAt <= new Date()
						? 'EXPIRED'
						: invitation.status,
				expiresAt: invitation.expiresAt.toISOString(),
				acceptedAt: invitation.acceptedAt?.toISOString() ?? null
			}
		};
	}

	private acceptance(invitation: WorkspaceInvitation) {
		if (
			!invitation.acceptanceId ||
			!invitation.acceptedSubject ||
			!invitation.acceptedMembershipId ||
			!invitation.acceptedAt ||
			!invitation.emailVerifiedAt
		)
			throw new ConflictException('Acceptance is incomplete');
		return {
			schemaVersion: 1 as const,
			acceptance: {
				id: invitation.acceptanceId,
				invitationId: invitation.id,
				invitationVersion: invitation.version,
				workspaceId: invitation.workspaceId,
				productCode: 'WINCRM' as const,
				subject: invitation.acceptedSubject,
				membershipId: invitation.acceptedMembershipId,
				acceptedAt: invitation.acceptedAt.toISOString(),
				emailVerifiedAt: invitation.emailVerifiedAt.toISOString()
			}
		};
	}

	private async command<T>(
		commandId: string,
		request: unknown,
		operation: (tx: Prisma.TransactionClient) => Promise<T>
	): Promise<T> {
		const requestHash = sha256(JSON.stringify(canonical(request)));
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.prisma.$transaction(
					async tx => {
						await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wincrm-invitation:${commandId}`}, 0))`;
						const key = { ...SCOPE, idempotencyKey: commandId };
						const prior = await tx.internalCommandReceipt.findUnique({
							where: { client_command_idempotencyKey: key }
						});
						if (prior) {
							if (prior.requestHash !== requestHash)
								throw new ConflictException('Invitation command conflict');
							return prior.response as unknown as T;
						}
						const response = await operation(tx);
						await tx.internalCommandReceipt.create({
							data: {
								...key,
								requestHash,
								response: response as Prisma.InputJsonValue
							}
						});
						return response;
					},
					{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
				);
			} catch (error) {
				if (
					attempt < 2 &&
					error instanceof Prisma.PrismaClientKnownRequestError &&
					error.code === 'P2034'
				)
					continue;
				throw error;
			}
		}
	}
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, canonical(item)])
		);
	return value;
}
