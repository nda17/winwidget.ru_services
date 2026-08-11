import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { PrismaService } from '@/prisma.service';
import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	UnauthorizedException
} from '@nestjs/common';
import {
	IntegrationDeliveryReceiptStatus,
	Prisma,
	Role,
	UserStatus
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CompletionInput {
	commandId: string;
	userId: string;
	operation: 'DEACTIVATE' | 'DELETE';
	actorId: string;
	actorRole: Role;
	requestedAt: Date;
}

@Injectable()
export class BillingLifecycleCompletionService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly adminEventLog: AdminEventLogService
	) {}

	async complete(body: unknown) {
		const input = this.parse(body);
		const outcome = await this.prisma.$transaction(
			transaction => this.completeInTransaction(transaction, input),
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
		return {
			schemaVersion: 1 as const,
			commandId: input.commandId,
			completed: true as const,
			...outcome
		};
	}

	private async completeInTransaction(
		transaction: Prisma.TransactionClient,
		input: CompletionInput
	): Promise<{ duplicate: boolean; changed: boolean }> {
		const claim = await transaction.integrationDeliveryReceipt.createMany({
			data: [
				{
					id: randomUUID(),
					eventId: input.commandId,
					integration: 'billing-lifecycle-complete',
					status: IntegrationDeliveryReceiptStatus.PROCESSING,
					lockedAt: new Date(),
					deliveredAt: null
				}
			],
			skipDuplicates: true
		});
		if (claim.count === 0) {
			return { duplicate: true, changed: false };
		}

		const [actor, target] = await Promise.all([
			transaction.user.findUnique({
				where: { id: input.actorId },
				select: { status: true, deletedAt: true, rights: true }
			}),
			transaction.user.findUnique({
				where: { id: input.userId },
				select: {
					id: true,
					name: true,
					status: true,
					deletedAt: true,
					personalDataConsentRevokedAt: true,
					rights: true
				}
			})
		]);
		if (
			!actor ||
			actor.status !== UserStatus.ACTIVE ||
			actor.deletedAt ||
			!actor.rights.includes(input.actorRole)
		) {
			throw new UnauthorizedException(
				'Lifecycle repair actor is no longer authorized'
			);
		}
		if (input.actorId === input.userId) {
			throw new ForbiddenException(
				'Нельзя деактивировать собственную учётную запись'
			);
		}
		if (!target) {
			await this.markDelivered(transaction, input.commandId);
			return { duplicate: false, changed: false };
		}
		if (target.rights.includes(Role.DEV) && input.actorRole !== Role.DEV) {
			throw new ForbiddenException(
				'Изменять пользователя с ролью DEV может только DEV'
			);
		}

		const alreadyApplied =
			input.operation === 'DELETE'
				? Boolean(target.deletedAt)
				: target.status === UserStatus.DEACTIVATED;
		if (alreadyApplied) {
			await this.markDelivered(transaction, input.commandId);
			return { duplicate: false, changed: false };
		}

		if (
			target.rights.includes(Role.DEV) &&
			target.status === UserStatus.ACTIVE
		) {
			const activeDevCount = await transaction.user.count({
				where: {
					status: UserStatus.ACTIVE,
					deletedAt: null,
					rights: { has: Role.DEV }
				}
			});
			if (activeDevCount <= 1) {
				throw new ConflictException(
					'Нельзя деактивировать последнюю активную DEV-учётную запись'
				);
			}
		}

		const updated = await transaction.user.updateMany({
			where: {
				id: input.userId,
				status: target.status,
				deletedAt: target.deletedAt
			},
			data: {
				status: UserStatus.DEACTIVATED,
				personalDataConsentRevokedAt:
					target.personalDataConsentRevokedAt ?? input.requestedAt,
				...(input.operation === 'DELETE'
					? { deletedAt: input.requestedAt }
					: {})
			}
		});
		if (updated.count !== 1) {
			throw new ConflictException(
				'Статус пользователя изменился во время lifecycle repair'
			);
		}
		await transaction.userSession.updateMany({
			where: { userId: input.userId, revokedAt: null },
			data: { revokedAt: input.requestedAt }
		});
		await this.adminEventLog.recordInTransaction(transaction, {
			adminId: input.actorId,
			section: 'USERS',
			action:
				input.operation === 'DELETE'
					? 'USER_SOFT_DELETE'
					: 'USER_TOGGLE_ACTIVATION',
			description:
				input.operation === 'DELETE'
					? 'Soft delete пользователя (Billing lifecycle repair)'
					: 'Пользователь деактивирован (Billing lifecycle repair)',
			entityType: 'user',
			entityId: input.userId,
			entityLabel: target.name || input.userId,
			targetUserId: input.userId,
			metadata: {
				billingLifecycleRepair: true,
				commandId: input.commandId,
				operation: input.operation
			}
		});
		await this.markDelivered(transaction, input.commandId);
		return { duplicate: false, changed: true };
	}

	private async markDelivered(
		transaction: Prisma.TransactionClient,
		commandId: string
	): Promise<void> {
		await transaction.integrationDeliveryReceipt.update({
			where: {
				eventId_integration: {
					eventId: commandId,
					integration: 'billing-lifecycle-complete'
				}
			},
			data: {
				status: IntegrationDeliveryReceiptStatus.DELIVERED,
				deliveredAt: new Date()
			}
		});
	}

	private parse(body: unknown): CompletionInput {
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			throw new BadRequestException(
				'Invalid Billing lifecycle completion'
			);
		}
		const input = body as Record<string, unknown>;
		const allowed = [
			'schemaVersion',
			'commandId',
			'userId',
			'operation',
			'actorId',
			'actorRole',
			'requestedAt'
		];
		if (
			Object.keys(input).some(key => !allowed.includes(key)) ||
			input.schemaVersion !== 1 ||
			typeof input.commandId !== 'string' ||
			!UUID_PATTERN.test(input.commandId) ||
			typeof input.userId !== 'string' ||
			!input.userId.trim() ||
			input.userId.length > 255 ||
			typeof input.actorId !== 'string' ||
			!input.actorId.trim() ||
			input.actorId.length > 255 ||
			(input.operation !== 'DEACTIVATE' && input.operation !== 'DELETE') ||
			(input.actorRole !== Role.ADMIN && input.actorRole !== Role.DEV) ||
			typeof input.requestedAt !== 'string' ||
			!Number.isFinite(Date.parse(input.requestedAt))
		) {
			throw new BadRequestException(
				'Invalid Billing lifecycle completion'
			);
		}
		return {
			commandId: input.commandId,
			userId: input.userId.trim(),
			operation: input.operation,
			actorId: input.actorId.trim(),
			actorRole: input.actorRole,
			requestedAt: new Date(input.requestedAt)
		};
	}
}
