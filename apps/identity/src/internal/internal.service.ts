import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException,
	UnauthorizedException
} from '@nestjs/common';
import {
	AuthIdentityType,
	Prisma,
	Role,
	UserStatus,
	WorkspaceMemberStatus,
	WorkspaceStatus,
	WorkspaceType
} from '@prisma/identity-client';
import type { Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { AccessJwtService } from '../auth/access-jwt.service';
import {
	DirectoryResolveDto,
	DirectorySearchDto,
	LifecycleCompleteDto
} from '../auth/auth.dto';
import { clientIp, sha256 } from '../common/identity.util';
import { IdentityEventsService } from '../events/identity-events.service';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';

const DIRECTORY_SELECT = {
	id: true,
	name: true,
	status: true,
	deletedAt: true,
	rights: true,
	authIdentities: {
		where: {
			type: { in: [AuthIdentityType.EMAIL, AuthIdentityType.PHONE] }
		},
		select: { type: true, value: true }
	}
} satisfies Prisma.UserSelect;

type DirectoryUser = Prisma.UserGetPayload<{
	select: typeof DIRECTORY_SELECT;
}>;
type CampaignChannel = 'EMAIL' | 'TELEGRAM';
type CampaignContactCursor = {
	destination: string;
	userId: string;
};

@Injectable()
export class IdentityInternalService {
	constructor(
		private readonly prisma: IdentityPrismaService,
		private readonly jwt: AccessJwtService,
		private readonly events: IdentityEventsService
	) {}

	async introspect(authorization?: string) {
		const token = this.bearer(authorization);
		const payload = this.jwt.verify(token);
		const session = await this.prisma.userSession.findFirst({
			where: {
				id: payload.sid,
				userId: payload.sub,
				revokedAt: null,
				expiresAt: { gt: new Date() }
			},
			select: {
				id: true,
				user: {
					select: {
						id: true,
						rights: true,
						status: true,
						deletedAt: true
					}
				}
			}
		});
		if (!session) throw new UnauthorizedException('Invalid session');
		if (
			session.user.status !== UserStatus.ACTIVE ||
			session.user.deletedAt
		) {
			throw new UnauthorizedException('User is deactivated');
		}
		return {
			active: true as const,
			subject: session.user.id,
			sessionId: session.id,
			roles: [...new Set(session.user.rights)].sort()
		};
	}

	async crmAccessAuthContext(authorization?: string) {
		const identity = await this.introspect(authorization);
		const memberships = await this.prisma.workspaceMember.findMany({
			where: {
				userId: identity.subject,
				status: WorkspaceMemberStatus.ACTIVE,
				workspace: { status: WorkspaceStatus.ACTIVE }
			},
			orderBy: [{ workspaceId: 'asc' }, { id: 'asc' }],
			select: {
				id: true,
				workspaceId: true,
				role: true
			}
		});
		return {
			schemaVersion: 1 as const,
			subject: identity.subject,
			sessionId: identity.sessionId,
			memberships: memberships.map(membership => ({
				membershipId: membership.id,
				workspaceId: membership.workspaceId,
				role: membership.role
			}))
		};
	}

	/** Canonical widget owner and delegated actor come from one Identity snapshot. */
	async crmWidgetSourceContext(workspaceId: string, subject: string) {
		const denied = {
			schemaVersion: 1 as const,
			workspaceId,
			subject,
			membership: null,
			ownerSubject: null
		};
		try {
			return await this.prisma.$transaction(
				async tx => {
					await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
					await tx.$executeRawUnsafe(
						"SET LOCAL statement_timeout = '1500ms'"
					);
					const workspace = await tx.workspace.findFirst({
						where: { id: workspaceId, status: WorkspaceStatus.ACTIVE },
						select: { type: true, personalOwnerUserId: true }
					});
					if (!workspace) return denied;
					const membership = await tx.workspaceMember.findFirst({
						where: {
							workspaceId,
							userId: subject,
							status: WorkspaceMemberStatus.ACTIVE,
							user: { status: UserStatus.ACTIVE, deletedAt: null }
						},
						select: { id: true, workspaceId: true, role: true }
					});
					if (!membership) return denied;
					const owners = await tx.workspaceMember.findMany({
						where: {
							workspaceId,
							role: 'OWNER',
							status: WorkspaceMemberStatus.ACTIVE,
							user: { status: UserStatus.ACTIVE, deletedAt: null }
						},
						select: { userId: true },
						orderBy: { id: 'asc' },
						take: 2
					});
					if (owners.length !== 1) return denied;
					const ownerSubject = owners[0].userId;
					if (
						(workspace.type === WorkspaceType.PERSONAL &&
							workspace.personalOwnerUserId !== ownerSubject) ||
						(workspace.type === WorkspaceType.ORGANIZATION &&
							workspace.personalOwnerUserId !== null) ||
						(membership.role === 'OWNER' && subject !== ownerSubject) ||
						(membership.role !== 'OWNER' && subject === ownerSubject)
					)
						return denied;
					return {
						...denied,
						membership: {
							membershipId: membership.id,
							workspaceId: membership.workspaceId,
							role: membership.role
						},
						ownerSubject
					};
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
					maxWait: 500,
					timeout: 2000
				}
			);
		} catch {
			throw new ServiceUnavailableException(
				'Widget source identity is unavailable'
			);
		}
	}

	async resolveOwners(dto: DirectoryResolveDto) {
		if (
			dto.userIds.length > 100 ||
			new Set(dto.userIds).size !== dto.userIds.length ||
			dto.userIds.some(id => !id || id.length > 255)
		) {
			throw new BadRequestException('Invalid owner IDs');
		}
		const users = await this.prisma.user.findMany({
			where: { id: { in: dto.userIds } },
			select: DIRECTORY_SELECT
		});
		const order = new Map(dto.userIds.map((id, index) => [id, index]));
		return {
			items: users
				.sort((left, right) => order.get(left.id)! - order.get(right.id)!)
				.map(user => this.owner(user))
		};
	}

	async crmSourceContext(workspaceId: string, subject: string) {
		const membership = await this.prisma.workspaceMember.findFirst({
			where: {
				workspaceId,
				userId: subject,
				status: WorkspaceMemberStatus.ACTIVE,
				workspace: { status: WorkspaceStatus.ACTIVE },
				user: { status: UserStatus.ACTIVE, deletedAt: null }
			},
			select: { id: true, workspaceId: true, role: true }
		});
		return {
			schemaVersion: 1 as const,
			workspaceId,
			subject,
			membership: membership
				? {
						membershipId: membership.id,
						workspaceId: membership.workspaceId,
						role: membership.role
					}
				: null
		};
	}

	async searchOwners(dto: DirectorySearchDto) {
		if (dto.plan) {
			throw new BadRequestException(
				'Owner plan filter belongs to Billing'
			);
		}
		const limit = dto.limit || 100;
		const search = dto.search?.trim();
		const afterId = dto.afterId?.trim();
		const users = await this.prisma.user.findMany({
			where: {
				deletedAt: null,
				...(afterId ? { id: { gt: afterId } } : {}),
				...(search
					? {
							OR: [
								{ id: { contains: search } },
								{ name: { contains: search, mode: 'insensitive' } },
								{
									authIdentities: {
										some: {
											type: {
												in: [
													AuthIdentityType.EMAIL,
													AuthIdentityType.PHONE
												]
											},
											value: { contains: search, mode: 'insensitive' }
										}
									}
								}
							]
						}
					: {})
			},
			orderBy: { id: 'asc' },
			take: limit,
			select: DIRECTORY_SELECT
		});
		return {
			items: users.map(user => this.owner(user)),
			nextAfterId:
				users.length === limit ? users[users.length - 1]?.id || null : null
		};
	}

	async auditSnapshots(userIds: string[]) {
		if (
			userIds.length === 0 ||
			new Set(userIds).size !== userIds.length ||
			userIds.some(id => !id.trim() || id !== id.trim())
		) {
			throw new BadRequestException('Invalid audit snapshot IDs');
		}
		const users = await this.prisma.user.findMany({
			where: { id: { in: userIds } },
			select: {
				id: true,
				name: true,
				authIdentities: {
					where: { type: AuthIdentityType.EMAIL },
					select: { value: true }
				}
			}
		});
		const byId = new Map(users.map(user => [user.id, user]));
		return {
			items: userIds.flatMap(id => {
				const user = byId.get(id);
				return user
					? [
							{
								id: user.id,
								name: user.name,
								email: user.authIdentities[0]?.value || null
							}
						]
					: [];
			})
		};
	}

	async streamCampaignContacts(
		channel: CampaignChannel,
		request: Request,
		response: Response
	): Promise<void> {
		const snapshotId = randomUUID();
		let closed = false;
		const onClose = () => {
			closed = true;
		};
		response.once('close', onClose);
		try {
			await this.prisma.$transaction(
				async transaction => {
					await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
					const [clock] = await transaction.$queryRaw<
						Array<{ asOf: Date }>
					>(Prisma.sql`SELECT transaction_timestamp() AS "asOf"`);
					if (
						!clock ||
						!(clock.asOf instanceof Date) ||
						Number.isNaN(clock.asOf.getTime())
					) {
						throw new Error(
							'Campaign contact export database clock is invalid'
						);
					}
					await this.write(
						response,
						{
							type: 'snapshot',
							schemaVersion: 2,
							snapshotId,
							asOf: clock.asOf.toISOString(),
							criteria: { channel }
						},
						() => closed || request.aborted
					);
					const hasher = createHash('sha256');
					let cursor: CampaignContactCursor | null = null;
					let totalCount = 0;
					for (;;) {
						const rows = await this.contactRows(
							transaction,
							channel,
							cursor
						);
						if (!rows.length) break;
						for (const row of rows) {
							hasher.update(
								`${channel}\u0000${row.destination}\u0000${row.userId}\n`,
								'utf8'
							);
							await this.write(
								response,
								{
									type: 'recipient',
									userId: row.userId,
									destination: row.destination
								},
								() => closed || request.aborted
							);
							cursor = {
								destination: row.destination,
								userId: row.userId
							};
							totalCount += 1;
						}
						if (rows.length < 2_000) break;
					}
					await this.write(
						response,
						{
							type: 'complete',
							snapshotId,
							totalCount,
							sha256: hasher.digest('hex')
						},
						() => closed || request.aborted
					);
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
					maxWait: 5_000,
					timeout: 15 * 60_000
				}
			);
		} finally {
			response.off('close', onClose);
		}
	}

	async completeLifecycle(dto: LifecycleCompleteDto, request: Request) {
		const requestHash = sha256(
			JSON.stringify({
				schemaVersion: 1,
				commandId: dto.commandId,
				userId: dto.userId,
				operation: dto.operation,
				actorId: dto.actorId,
				actorRole: dto.actorRole,
				requestedAt: dto.requestedAt
			})
		);
		return this.prisma.$transaction(
			async transaction => {
				const prior = await transaction.internalCommandReceipt.findUnique({
					where: {
						client_command_idempotencyKey: {
							client: 'billing',
							command: 'lifecycle.complete',
							idempotencyKey: dto.commandId
						}
					}
				});
				if (prior) {
					if (prior.requestHash !== requestHash) {
						throw new ConflictException(
							'Lifecycle idempotency key conflict'
						);
					}
					const response = this.record(prior.response);
					return { ...response, duplicate: true };
				}
				const user = await transaction.user.findUnique({
					where: { id: dto.userId }
				});
				if (!user) throw new NotFoundException('User not found');
				if (
					user.rights.includes(Role.DEV) &&
					user.status === UserStatus.ACTIVE
				) {
					const anotherDev = await transaction.user.count({
						where: {
							id: { not: user.id },
							status: UserStatus.ACTIVE,
							deletedAt: null,
							rights: { has: Role.DEV }
						}
					});
					if (!anotherDev) {
						throw new ConflictException(
							'Cannot deactivate the last active DEV'
						);
					}
				}
				const changed =
					user.status !== UserStatus.DEACTIVATED ||
					(dto.operation === 'DELETE' && !user.deletedAt);
				if (changed) {
					const now = new Date();
					await transaction.user.update({
						where: { id: user.id },
						data: {
							status: UserStatus.DEACTIVATED,
							personalDataConsentRevokedAt:
								user.personalDataConsentRevokedAt || now,
							...(dto.operation === 'DELETE'
								? { deletedAt: user.deletedAt || now }
								: {})
						}
					});
					await transaction.userSession.updateMany({
						where: { userId: user.id, revokedAt: null },
						data: { revokedAt: now }
					});
					await this.events.emitUserChanged(
						transaction,
						user.id,
						request.header('x-correlation-id')
					);
					await this.events.emitAudit(transaction, {
						actorId: dto.actorId,
						action:
							dto.operation === 'DELETE'
								? 'USER_SOFT_DELETE'
								: 'USER_TOGGLE_ACTIVATION',
						entityType: 'user',
						entityId: user.id,
						entityLabel: user.name || user.id,
						targetUserId: user.id,
						description: `Identity lifecycle completion ${dto.operation}`,
						metadata: {
							commandId: dto.commandId,
							operation: dto.operation
						},
						requestId: request.header('x-request-id'),
						requestIp: clientIp(request),
						requestUserAgent: request.get('user-agent')?.slice(0, 500),
						correlationId: request.header('x-correlation-id')
					});
				}
				const result = {
					schemaVersion: 1 as const,
					commandId: dto.commandId,
					completed: true as const,
					duplicate: false,
					changed
				};
				await transaction.internalCommandReceipt.create({
					data: {
						client: 'billing',
						command: 'lifecycle.complete',
						idempotencyKey: dto.commandId,
						requestHash,
						response: result
					}
				});
				return result;
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	private contactRows(
		transaction: Prisma.TransactionClient,
		channel: CampaignChannel,
		cursor: CampaignContactCursor | null
	): Promise<Array<{ userId: string; destination: string }>> {
		const cursorFilter = cursor
			? Prisma.sql`WHERE (destination, user_id) > (${cursor.destination}, ${cursor.userId})`
			: Prisma.empty;
		if (channel === 'EMAIL') {
			return transaction.$queryRaw(Prisma.sql`
				SELECT DISTINCT
					user_id AS "userId", destination
				FROM (
					SELECT identity.user_id,
						LOWER(BTRIM(identity.value)) AS destination
					FROM identity.auth_identities identity
					INNER JOIN identity.users users ON users.id = identity.user_id
					WHERE identity.type = 'EMAIL'::identity."AuthIdentityType"
						AND identity.verified_at IS NOT NULL
						AND BTRIM(identity.value) <> ''
						AND users.status = 'ACTIVE'::identity."UserStatus"
						AND users.deleted_at IS NULL
				) recipients
				${cursorFilter}
				ORDER BY destination ASC, user_id ASC
				LIMIT 2000
			`);
		}
		return transaction.$queryRaw(Prisma.sql`
			SELECT DISTINCT
				user_id AS "userId", destination
			FROM (
				SELECT channel.user_id, BTRIM(channel.chat_id) AS destination
				FROM identity.telegram_notification_channels channel
				INNER JOIN identity.users users ON users.id = channel.user_id
				WHERE channel.is_active = TRUE
					AND channel.disabled_at IS NULL
					AND BTRIM(channel.chat_id) <> ''
					AND users.status = 'ACTIVE'::identity."UserStatus"
					AND users.deleted_at IS NULL
			) recipients
			${cursorFilter}
			ORDER BY destination ASC, user_id ASC
			LIMIT 2000
		`);
	}

	private owner(user: DirectoryUser) {
		const identity = (type: AuthIdentityType) =>
			user.authIdentities.find(item => item.type === type)?.value || null;
		return {
			id: user.id,
			name: user.name,
			status: user.deletedAt ? ('DELETED' as const) : user.status,
			deletedAt: user.deletedAt?.toISOString() || null,
			rights: [...new Set(user.rights)].sort(),
			email: identity(AuthIdentityType.EMAIL),
			phone: identity(AuthIdentityType.PHONE)
		};
	}

	private bearer(authorization?: string): string {
		if (!authorization)
			throw new UnauthorizedException('Access token not passed');
		const parts = authorization.split(' ');
		if (
			parts.length !== 2 ||
			parts[0] !== 'Bearer' ||
			!parts[1] ||
			parts[1].length > 16 * 1024
		) {
			throw new UnauthorizedException('Invalid access token');
		}
		return parts[1];
	}

	private async write(
		response: Response,
		value: Record<string, unknown>,
		disconnected: () => boolean
	): Promise<void> {
		if (disconnected() || response.destroyed || response.writableEnded) {
			throw new Error('Campaign contact export client disconnected');
		}
		if (response.write(`${JSON.stringify(value)}\n`)) return;
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				response.off('drain', onDrain);
				response.off('close', onClose);
				response.off('error', onError);
			};
			const onDrain = () => {
				cleanup();
				resolve();
			};
			const onClose = () => {
				cleanup();
				reject(new Error('Campaign contact export client disconnected'));
			};
			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};
			response.once('drain', onDrain);
			response.once('close', onClose);
			response.once('error', onError);
			if (disconnected()) onClose();
		});
	}

	private record(value: Prisma.JsonValue): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new ConflictException('Stored command response is invalid');
		}
		return value as Record<string, unknown>;
	}
}
