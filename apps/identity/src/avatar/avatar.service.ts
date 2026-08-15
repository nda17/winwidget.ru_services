import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	AvatarCleanupKind,
	AvatarCleanupStatus,
	Prisma,
	Role
} from '@prisma/identity-client';
import type { Request } from 'express';
import { clientIp, sha256 } from '../common/identity.util';
import { IdentityEventsService } from '../events/identity-events.service';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { AvatarMediaOwnershipService } from './avatar-media-ownership.service';
import {
	AVATAR_STAGING_GRACE_MS,
	AvatarStorageService
} from './avatar-storage.service';

const USER_INCLUDE = {
	authIdentities: true,
	telegramNotificationChannel: true
} satisfies Prisma.UserInclude;
const AVATAR_SERIALIZABLE_ATTEMPTS = 3;

@Injectable()
export class AvatarService {
	constructor(
		private readonly prisma: IdentityPrismaService,
		private readonly events: IdentityEventsService,
		private readonly storage: AvatarStorageService,
		private readonly ownership: AvatarMediaOwnershipService
	) {}

	async uploadSelf(
		userId: string,
		file: Express.Multer.File | undefined,
		request: Request
	) {
		return this.upload({ userId, file, request });
	}

	async uploadAdmin(
		actorId: string,
		actorRights: Role[],
		userId: string,
		file: Express.Multer.File | undefined,
		request: Request
	) {
		return this.upload({ actorId, actorRights, userId, file, request });
	}

	async deleteSelf(userId: string, request: Request) {
		return this.delete({ userId, request });
	}

	async deleteAdmin(
		actorId: string,
		actorRights: Role[],
		userId: string,
		request: Request
	) {
		return this.delete({ actorId, actorRights, userId, request });
	}

	private async upload(input: {
		actorId?: string;
		actorRights?: Role[];
		userId: string;
		file: Express.Multer.File | undefined;
		request: Request;
	}) {
		await this.ownership.assertActive();
		const initialTarget = await this.prisma.user.findUnique({
			where: { id: input.userId },
			include: USER_INCLUDE
		});
		this.assertTarget(initialTarget, input.actorRights);
		const prepared = await this.storage.prepare(input.userId, input.file);
		const staging = await this.prisma.avatarCleanupJob.create({
			data: {
				objectKey: prepared.objectKey,
				ownerFingerprint: prepared.ownerFingerprint,
				kind: AvatarCleanupKind.STAGING,
				status: AvatarCleanupStatus.PENDING,
				availableAt: new Date(Date.now() + AVATAR_STAGING_GRACE_MS)
			}
		});
		try {
			await this.storage.upload(prepared);
		} catch {
			throw new ServiceUnavailableException(
				'Avatar storage is temporarily unavailable'
			);
		}

		return this.runSerializableTransaction(async transaction => {
			await this.lockUser(transaction, input.userId);
			const target = await transaction.user.findUnique({
				where: { id: input.userId },
				include: USER_INCLUDE
			});
			this.assertTarget(target, input.actorRights);
			const consumed = await transaction.avatarCleanupJob.deleteMany({
				where: {
					id: staging.id,
					objectKey: prepared.objectKey,
					kind: AvatarCleanupKind.STAGING,
					status: AvatarCleanupStatus.PENDING,
					leaseToken: null,
					leaseExpiresAt: null
				}
			});
			if (consumed.count !== 1) {
				throw new ConflictException('Avatar staging lease was lost');
			}
			await this.enqueueRetired(
				transaction,
				target!.avatarObjectKey,
				prepared.ownerFingerprint
			);
			await transaction.user.update({
				where: { id: input.userId },
				data: {
					avatarPath: prepared.publicUrl,
					avatarObjectKey: prepared.objectKey
				}
			});
			await this.events.emitUserChanged(
				transaction,
				input.userId,
				input.request.header('x-correlation-id')
			);
			if (input.actorId) {
				await this.audit(
					transaction,
					input.actorId,
					input.userId,
					target!.name,
					input.request
				);
			}
			return { avatarPath: prepared.publicUrl };
		});
	}

	private delete(input: {
		actorId?: string;
		actorRights?: Role[];
		userId: string;
		request: Request;
	}) {
		return this.deleteActive(input);
	}

	private async deleteActive(input: {
		actorId?: string;
		actorRights?: Role[];
		userId: string;
		request: Request;
	}) {
		await this.ownership.assertActive();
		return this.runSerializableTransaction(async transaction => {
			await this.lockUser(transaction, input.userId);
			const target = await transaction.user.findUnique({
				where: { id: input.userId },
				include: USER_INCLUDE
			});
			this.assertTarget(target, input.actorRights);
			if (!target!.avatarPath && !target!.avatarObjectKey) {
				return { avatarPath: null };
			}
			await this.enqueueRetired(
				transaction,
				target!.avatarObjectKey,
				sha256(input.userId)
			);
			await transaction.user.update({
				where: { id: input.userId },
				data: { avatarPath: null, avatarObjectKey: null }
			});
			await this.events.emitUserChanged(
				transaction,
				input.userId,
				input.request.header('x-correlation-id')
			);
			if (input.actorId) {
				await this.audit(
					transaction,
					input.actorId,
					input.userId,
					target!.name,
					input.request
				);
			}
			return { avatarPath: null };
		});
	}

	private async runSerializableTransaction<T>(
		operation: (transaction: Prisma.TransactionClient) => Promise<T>
	): Promise<T> {
		for (
			let attempt = 1;
			attempt <= AVATAR_SERIALIZABLE_ATTEMPTS;
			attempt += 1
		) {
			try {
				return await this.prisma.$transaction(operation, {
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable
				});
			} catch (error) {
				if (!isSerializableConflict(error)) throw error;
				if (attempt === AVATAR_SERIALIZABLE_ATTEMPTS) {
					throw new ServiceUnavailableException(
						'Avatar update is temporarily unavailable'
					);
				}
			}
		}
		throw new ServiceUnavailableException(
			'Avatar update is temporarily unavailable'
		);
	}

	private assertTarget(
		target:
			| (Prisma.UserGetPayload<{ include: typeof USER_INCLUDE }> & {
					avatarObjectKey: string | null;
			  })
			| null,
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

	private async enqueueRetired(
		transaction: Prisma.TransactionClient,
		objectKey: string | null,
		ownerFingerprint: string
	): Promise<void> {
		if (!objectKey) return;
		await transaction.avatarCleanupJob.createMany({
			data: [
				{
					objectKey,
					ownerFingerprint,
					kind: AvatarCleanupKind.RETIRED,
					status: AvatarCleanupStatus.PENDING,
					availableAt: new Date()
				}
			],
			skipDuplicates: true
		});
	}

	private lockUser(
		transaction: Prisma.TransactionClient,
		userId: string
	): Promise<unknown> {
		return transaction.$queryRaw(
			Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity.user:${userId}`}, 0))`
		);
	}

	private audit(
		transaction: Prisma.TransactionClient,
		actorId: string,
		userId: string,
		name: string | null,
		request: Request
	) {
		return this.events.emitAudit(transaction, {
			actorId,
			action: 'USER_UPDATE',
			entityType: 'user',
			entityId: userId,
			entityLabel: name || userId,
			targetUserId: userId,
			description: 'Обновлён аватар пользователя',
			metadata: {
				changedFields: ['avatarPath'],
				passwordChanged: false
			},
			requestId: request.header('x-request-id'),
			requestIp: clientIp(request),
			requestUserAgent: request.get('user-agent')?.slice(0, 500),
			correlationId: request.header('x-correlation-id')
		});
	}
}

function isSerializableConflict(error: unknown): boolean {
	return (
		error instanceof Prisma.PrismaClientKnownRequestError &&
		error.code === 'P2034'
	);
}
