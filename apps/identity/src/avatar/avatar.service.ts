import {
	BadRequestException,
	ForbiddenException,
	Injectable,
	Logger,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	AvatarMediaObjectStatus,
	Prisma,
	Role
} from '@prisma/identity-client';
import type { Request } from 'express';
import { clientIp } from '../common/identity.util';
import { IdentityEventsService } from '../events/identity-events.service';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { AvatarCleanupService } from './avatar-cleanup.service';
import { AvatarStorageService } from './avatar-storage.service';

const USER_INCLUDE = {
	authIdentities: true,
	telegramNotificationChannel: true
} satisfies Prisma.UserInclude;

@Injectable()
export class AvatarService {
	private readonly logger = new Logger(AvatarService.name);

	constructor(
		private readonly prisma: IdentityPrismaService,
		private readonly events: IdentityEventsService,
		private readonly storage: AvatarStorageService,
		private readonly cleanup: AvatarCleanupService
	) {}

	uploadSelf(
		userId: string,
		file: Express.Multer.File | undefined,
		request: Request
	) {
		return this.upload({ userId, file, request });
	}

	uploadAdmin(
		actorId: string,
		actorRights: Role[],
		userId: string,
		file: Express.Multer.File | undefined,
		request: Request
	) {
		return this.upload({ actorId, actorRights, userId, file, request });
	}

	deleteSelf(userId: string, request: Request) {
		return this.remove({ userId, request });
	}

	deleteAdmin(
		actorId: string,
		actorRights: Role[],
		userId: string,
		request: Request
	) {
		return this.remove({ actorId, actorRights, userId, request });
	}

	private async upload(input: {
		actorId?: string;
		actorRights?: Role[];
		userId: string;
		file: Express.Multer.File | undefined;
		request: Request;
	}) {
		await this.assertCurrentTarget(input.userId, input.actorRights);
		const prepared = this.storage.prepare(input.userId, input.file);
		await this.prisma.avatarMediaObject.create({
			data: {
				id: prepared.id,
				userId: input.userId,
				objectKey: prepared.objectKey,
				publicUrl: prepared.avatarPath,
				status: AvatarMediaObjectStatus.PREPARED,
				availableAt: new Date(Date.now() + 60_000)
			}
		});
		try {
			await this.storage.upload(prepared);
		} catch (error) {
			await this.queuePreparedCleanup(prepared.id, true);
			if (error instanceof BadRequestException) throw error;
			throw new ServiceUnavailableException(
				'Avatar storage is temporarily unavailable'
			);
		}
		try {
			const result = await this.prisma.$transaction(
				async transaction => {
					await this.lockUser(transaction, input.userId);
					const target = await transaction.user.findUnique({
						where: { id: input.userId },
						include: USER_INCLUDE
					});
					this.assertTarget(target, input.actorRights);
					const cleanupId = await this.markOwnedForCleanup(
						transaction,
						input.userId,
						target!.avatarPath
					);
					const activated = await transaction.avatarMediaObject.updateMany(
						{
							where: {
								id: prepared.id,
								userId: input.userId,
								publicUrl: prepared.avatarPath,
								status: AvatarMediaObjectStatus.PREPARED
							},
							data: {
								status: AvatarMediaObjectStatus.ACTIVE,
								availableAt: new Date(),
								lastError: null
							}
						}
					);
					if (activated.count !== 1) {
						throw new ServiceUnavailableException(
							'Avatar metadata is temporarily unavailable'
						);
					}
					await transaction.user.update({
						where: { id: input.userId },
						data: { avatarPath: prepared.avatarPath }
					});
					await this.afterChange(transaction, input, target!.name);
					return { avatarPath: prepared.avatarPath, cleanupId };
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable
				}
			);
			await this.cleanupAfterCommit(result.cleanupId);
			return { avatarPath: result.avatarPath };
		} catch (error) {
			await this.queuePreparedCleanup(prepared.id);
			throw error;
		}
	}

	private async remove(input: {
		actorId?: string;
		actorRights?: Role[];
		userId: string;
		request: Request;
	}) {
		const result = await this.prisma.$transaction(
			async transaction => {
				await this.lockUser(transaction, input.userId);
				const target = await transaction.user.findUnique({
					where: { id: input.userId },
					include: USER_INCLUDE
				});
				this.assertTarget(target, input.actorRights);
				if (!target!.avatarPath) {
					return { avatarPath: null, cleanupId: null };
				}
				const cleanupId = await this.markOwnedForCleanup(
					transaction,
					input.userId,
					target!.avatarPath
				);
				await transaction.user.update({
					where: { id: input.userId },
					data: { avatarPath: null }
				});
				await this.afterChange(transaction, input, target!.name);
				return { avatarPath: null, cleanupId };
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
		await this.cleanupAfterCommit(result.cleanupId);
		return { avatarPath: null };
	}

	private async markOwnedForCleanup(
		transaction: Prisma.TransactionClient,
		userId: string,
		avatarPath: string | null
	): Promise<string | null> {
		const owned = this.storage.ownedObject(userId, avatarPath);
		if (!owned) return null;
		const marked = await transaction.avatarMediaObject.updateMany({
			where: {
				id: owned.id,
				userId,
				objectKey: owned.objectKey,
				publicUrl: avatarPath!,
				status: AvatarMediaObjectStatus.ACTIVE
			},
			data: {
				status: AvatarMediaObjectStatus.DELETE_PENDING,
				deletePasses: 0,
				availableAt: new Date(),
				leaseToken: null,
				leaseExpiresAt: null
			}
		});
		if (marked.count !== 1) {
			throw new ServiceUnavailableException(
				'Avatar metadata is temporarily unavailable'
			);
		}
		return owned.id;
	}

	private async queuePreparedCleanup(
		id: string,
		preserveSettleDelay = false
	): Promise<void> {
		try {
			await this.prisma.avatarMediaObject.updateMany({
				where: { id, status: AvatarMediaObjectStatus.PREPARED },
				data: {
					status: AvatarMediaObjectStatus.DELETE_PENDING,
					deletePasses: 0,
					...(preserveSettleDelay ? {} : { availableAt: new Date() }),
					leaseToken: null,
					leaseExpiresAt: null
				}
			});
		} catch {
			this.logger.warn('Avatar cleanup could not be queued immediately');
		}
		this.cleanup.kick();
	}

	private async cleanupAfterCommit(id: string | null): Promise<void> {
		if (!id) return;
		try {
			await this.cleanup.deleteNow(id);
		} catch {
			this.logger.warn('Avatar cleanup will be retried');
			this.cleanup.kick();
		}
	}

	private async assertCurrentTarget(
		userId: string,
		actorRights?: Role[]
	): Promise<void> {
		const target = await this.prisma.user.findUnique({
			where: { id: userId },
			include: USER_INCLUDE
		});
		this.assertTarget(target, actorRights);
	}

	private assertTarget(
		target: Prisma.UserGetPayload<{ include: typeof USER_INCLUDE }> | null,
		actorRights?: Role[]
	): void {
		if (!target) throw new NotFoundException('User not found');
		if (target.deletedAt) {
			throw new BadRequestException('Пользователь уже удалён');
		}
		if (
			actorRights &&
			target.rights.includes(Role.DEV) &&
			!actorRights.includes(Role.DEV)
		) {
			throw new ForbiddenException(
				'Изменять пользователя с ролью DEV может только DEV'
			);
		}
	}

	private async afterChange(
		transaction: Prisma.TransactionClient,
		input: {
			actorId?: string;
			userId: string;
			request: Request;
		},
		name: string | null
	): Promise<void> {
		await this.events.emitUserChanged(
			transaction,
			input.userId,
			input.request.header('x-correlation-id')
		);
		if (!input.actorId) return;
		await this.events.emitAudit(transaction, {
			actorId: input.actorId,
			action: 'USER_UPDATE',
			entityType: 'user',
			entityId: input.userId,
			entityLabel: name || input.userId,
			targetUserId: input.userId,
			description: 'Обновлён аватар пользователя',
			metadata: {
				changedFields: ['avatarPath'],
				passwordChanged: false
			},
			requestId: input.request.header('x-request-id'),
			requestIp: clientIp(input.request),
			requestUserAgent: input.request.get('user-agent')?.slice(0, 500),
			correlationId: input.request.header('x-correlation-id')
		});
	}

	private lockUser(
		transaction: Prisma.TransactionClient,
		userId: string
	): Promise<number> {
		return transaction.$executeRaw(
			Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity.user:${userId}`}, 0))`
		);
	}
}
