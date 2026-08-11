import {
	DeliveryFailureStatus,
	DeliveryReceiptStatus,
	IntegrationErrorCategory,
	IntegrationFailureResolution,
	OutboxStatus,
	Prisma
} from '@prisma/billing-client';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
	BillingFailureCloseCommandDto,
	BillingFailureCommandDto
} from '../http/billing.dto';
import {
	BILLING_CONSUMER_KINDS,
	BILLING_RETRY_EXCHANGE,
	BillingConsumerKind,
	billingRetryRoutingKey
} from '../messaging/billing-messaging.constants';
import { BillingPrismaService } from '../prisma/billing-prisma.service';
import { enqueueBillingAdminAudit } from './billing-admin-audit';

@Injectable()
export class BillingMessagingAdminService {
	constructor(private readonly prisma: BillingPrismaService) {}

	async overview() {
		const since = new Date(Date.now() - 24 * 60 * 60_000);
		const [
			outboxGroups,
			oldestPending,
			unresolvedFailures,
			retryingFailures,
			deliveredLast24Hours
		] = await Promise.all([
			this.prisma.outboxEvent.groupBy({
				by: ['status'],
				_count: { _all: true }
			}),
			this.prisma.outboxEvent.findFirst({
				where: {
					status: { in: [OutboxStatus.PENDING, OutboxStatus.PROCESSING] }
				},
				orderBy: { createdAt: 'asc' },
				select: { createdAt: true }
			}),
			this.prisma.integrationDeliveryFailure.count({
				where: { resolvedAt: null, retryingAt: null }
			}),
			this.prisma.integrationDeliveryFailure.count({
				where: { resolvedAt: null, retryingAt: { not: null } }
			}),
			this.prisma.integrationDeliveryReceipt.count({
				where: {
					status: DeliveryReceiptStatus.DELIVERED,
					deliveredAt: { gte: since }
				}
			})
		]);
		const outbox = { PENDING: 0, PROCESSING: 0, PUBLISHED: 0 };
		for (const group of outboxGroups)
			outbox[group.status] = group._count._all;
		return {
			schemaVersion: 1 as const,
			generatedAt: new Date().toISOString(),
			outbox,
			oldestPendingAt: oldestPending?.createdAt.toISOString() || null,
			unresolvedFailures,
			retryingFailures,
			deliveredLast24Hours
		};
	}

	async list(input: {
		page: number;
		limit: number;
		consumer?: string;
		category?: string;
		status?: string;
	}) {
		const page =
			Number.isInteger(input.page) && input.page > 0 ? input.page : 1;
		const limit =
			Number.isInteger(input.limit) && input.limit > 0
				? Math.min(input.limit, 100)
				: 20;
		const where = this.failureWhere(input);
		const [items, total] = await this.prisma.$transaction([
			this.prisma.integrationDeliveryFailure.findMany({
				where,
				orderBy: [{ failedAt: 'desc' }, { id: 'desc' }],
				skip: (page - 1) * limit,
				take: limit
			}),
			this.prisma.integrationDeliveryFailure.count({ where })
		]);
		return {
			schemaVersion: 1 as const,
			items: items.map(item => this.serialize(item)),
			total,
			page,
			limit,
			totalPages: Math.max(1, Math.ceil(total / limit))
		};
	}

	async retry(id: string, dto: BillingFailureCommandDto) {
		return this.prisma.$transaction(
			async transaction => {
				const prior = await transaction.billingCommandReceipt.findUnique({
					where: { commandId: dto.commandId }
				});
				if (prior)
					return this.priorResult(prior, 'BILLING_FAILURE_RETRY', id);
				await transaction.$queryRaw(Prisma.sql`
				SELECT "id" FROM "billing"."integration_delivery_failures"
				WHERE "id" = ${id}::uuid FOR UPDATE
			`);
				const failure =
					await transaction.integrationDeliveryFailure.findUnique({
						where: { id }
					});
				if (!failure || !this.consumer(failure.consumer)) {
					throw new NotFoundException('Ошибка доставки не найдена');
				}
				if (failure.resolvedAt)
					throw new ConflictException('Ошибка уже обработана');
				if (failure.retryingAt || failure.activeRetryToken) {
					throw new ConflictException('Ошибка уже отправляется повторно');
				}
				const payload = this.payload(failure.payload, failure.eventId);
				const existingReceipt =
					await transaction.integrationDeliveryReceipt.findUnique({
						where: {
							eventId_consumer: {
								eventId: failure.eventId,
								consumer: failure.consumer
							}
						}
					});
				if (
					existingReceipt &&
					(
						[
							DeliveryReceiptStatus.PROCESSING,
							DeliveryReceiptStatus.RETRY_SCHEDULED,
							DeliveryReceiptStatus.DELIVERED,
							DeliveryReceiptStatus.CLOSED_NO_RETRY
						] as DeliveryReceiptStatus[]
					).includes(existingReceipt.status)
				) {
					throw new ConflictException(
						'Событие уже доставляется или было обработано'
					);
				}
				const retryingAt = new Date(dto.occurredAt);
				const retryToken = randomUUID();
				const outboxId = randomUUID();
				await transaction.outboxEvent.create({
					data: {
						eventId: outboxId,
						messageId: failure.eventId,
						deduplicationKey: `manual-retry:${dto.commandId}`,
						eventType: payload.eventType,
						aggregateType: 'billing.delivery',
						aggregateId: failure.eventId,
						exchange: BILLING_RETRY_EXCHANGE,
						routingKey: billingRetryRoutingKey(failure.consumer, 1),
						payload: failure.payload as Prisma.InputJsonValue,
						deliveryAttempt: 0
					}
				});
				await transaction.integrationDeliveryReceipt.upsert({
					where: {
						eventId_consumer: {
							eventId: failure.eventId,
							consumer: failure.consumer
						}
					},
					create: {
						eventId: failure.eventId,
						consumer: failure.consumer,
						status: DeliveryReceiptStatus.RETRY_SCHEDULED,
						lockedAt: retryingAt,
						attempt: 0,
						retryAvailableAt: retryingAt,
						retryToken
					},
					update: {
						status: DeliveryReceiptStatus.RETRY_SCHEDULED,
						lockedAt: retryingAt,
						deliveredAt: null,
						attempt: 0,
						retryAvailableAt: retryingAt,
						retryToken,
						claimToken: null,
						leaseUntil: null,
						lastError: null
					}
				});
				await transaction.integrationDeliveryFailure.update({
					where: { id },
					data: {
						status: DeliveryFailureStatus.RETRY_PENDING,
						retryingAt,
						activeRetryToken: retryToken,
						retryOutboxId: outboxId
					}
				});
				await enqueueBillingAdminAudit(transaction, {
					actor: { id: dto.actorId, role: dto.actorRole },
					section: 'MESSAGING',
					action: 'BILLING_DELIVERY_RETRY',
					description: `Запущена повторная доставка Billing ${failure.consumer}`,
					entity: {
						type: 'integration_delivery_failure',
						id: failure.id,
						label: failure.consumer,
						targetUserId: null
					},
					metadata: {
						eventId: failure.eventId,
						consumer: failure.consumer
					}
				});
				const result = {
					schemaVersion: 1 as const,
					id: failure.id,
					eventId: failure.eventId,
					consumer: failure.consumer,
					status: 'RETRY_PENDING' as const,
					retryOutboxId: outboxId,
					retryingAt: retryingAt.toISOString(),
					duplicate: false
				};
				await transaction.billingCommandReceipt.create({
					data: {
						commandId: dto.commandId,
						commandType: 'BILLING_FAILURE_RETRY',
						result: result as Prisma.InputJsonValue
					}
				});
				return result;
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	async close(id: string, dto: BillingFailureCloseCommandDto) {
		return this.prisma.$transaction(
			async transaction => {
				const prior = await transaction.billingCommandReceipt.findUnique({
					where: { commandId: dto.commandId }
				});
				if (prior)
					return this.priorResult(prior, 'BILLING_FAILURE_CLOSE', id);
				await transaction.$queryRaw(Prisma.sql`
				SELECT "id" FROM "billing"."integration_delivery_failures"
				WHERE "id" = ${id}::uuid FOR UPDATE
			`);
				const failure =
					await transaction.integrationDeliveryFailure.findUnique({
						where: { id }
					});
				if (!failure || !this.consumer(failure.consumer))
					throw new NotFoundException('Ошибка доставки не найдена');
				if (failure.resolvedAt)
					throw new ConflictException('Ошибка уже обработана');
				if (failure.retryingAt || failure.activeRetryToken) {
					throw new ConflictException(
						'Нельзя закрыть ошибку во время повторной отправки'
					);
				}
				const resolvedAt = new Date(dto.occurredAt);
				const comment = dto.comment.trim();
				const receipt =
					await transaction.integrationDeliveryReceipt.findUnique({
						where: {
							eventId_consumer: {
								eventId: failure.eventId,
								consumer: failure.consumer
							}
						}
					});
				if (
					receipt &&
					receipt.status !== DeliveryReceiptStatus.DEAD_LETTERED &&
					receipt.status !== DeliveryReceiptStatus.FAILED
				) {
					throw new ConflictException(
						'Событие уже запланировано или было обработано'
					);
				}
				await transaction.integrationDeliveryReceipt.upsert({
					where: {
						eventId_consumer: {
							eventId: failure.eventId,
							consumer: failure.consumer
						}
					},
					create: {
						eventId: failure.eventId,
						consumer: failure.consumer,
						status: DeliveryReceiptStatus.CLOSED_NO_RETRY,
						lockedAt: resolvedAt,
						attempt: null
					},
					update: {
						status: DeliveryReceiptStatus.CLOSED_NO_RETRY,
						lockedAt: resolvedAt,
						deliveredAt: null,
						attempt: null,
						retryAvailableAt: null,
						retryToken: null,
						claimToken: null,
						leaseUntil: null
					}
				});
				await transaction.integrationDeliveryFailure.update({
					where: { id },
					data: {
						status: DeliveryFailureStatus.RESOLVED,
						resolvedAt,
						resolution: IntegrationFailureResolution.CLOSED_NO_RETRY,
						resolutionComment: comment,
						resolvedById: dto.actorId,
						activeRetryToken: null
					}
				});
				const result = {
					schemaVersion: 1 as const,
					id: failure.id,
					eventId: failure.eventId,
					consumer: failure.consumer,
					status: 'RESOLVED' as const,
					resolvedAt: resolvedAt.toISOString(),
					resolution: 'CLOSED_NO_RETRY' as const,
					resolutionComment: comment,
					duplicate: false
				};
				await transaction.billingCommandReceipt.create({
					data: {
						commandId: dto.commandId,
						commandType: 'BILLING_FAILURE_CLOSE',
						result: result as Prisma.InputJsonValue
					}
				});
				return result;
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	private failureWhere(input: {
		consumer?: string;
		category?: string;
		status?: string;
	}): Prisma.IntegrationDeliveryFailureWhereInput {
		const where: Prisma.IntegrationDeliveryFailureWhereInput = {
			consumer: { in: [...BILLING_CONSUMER_KINDS] }
		};
		if (input.consumer?.trim()) {
			const consumer = input.consumer.trim();
			if (!this.consumer(consumer))
				throw new BadRequestException('Некорректный Billing consumer');
			where.consumer = consumer;
		}
		if (input.category?.trim()) {
			const category = input.category.trim().toUpperCase();
			if (
				!Object.values(IntegrationErrorCategory).includes(
					category as IntegrationErrorCategory
				)
			) {
				throw new BadRequestException(
					'Некорректная категория ошибки доставки'
				);
			}
			where.category = category as IntegrationErrorCategory;
		}
		const status = input.status?.trim().toUpperCase();
		if (!status || status === 'ALL') return where;
		if (status === 'FAILED' || status === 'OPEN') {
			where.resolvedAt = null;
			where.retryingAt = null;
		} else if (status === 'RETRYING' || status === 'RETRY_PENDING') {
			where.resolvedAt = null;
			where.retryingAt = { not: null };
		} else if (status === 'RESOLVED') {
			where.resolution = IntegrationFailureResolution.DELIVERED;
		} else if (status === 'CLOSED') {
			where.resolution = IntegrationFailureResolution.CLOSED_NO_RETRY;
		} else {
			throw new BadRequestException('Некорректный статус ошибки доставки');
		}
		return where;
	}

	private serialize(item: any) {
		return {
			id: item.id,
			eventId: item.eventId,
			consumer: item.consumer,
			routingKey: item.routingKey,
			errorCode: item.errorCode || item.normalizedCode,
			errorSafe: item.errorSafe || item.safeReason || item.lastError,
			attempt: item.attempt || 0,
			status: item.status,
			category: item.category,
			normalizedCode: item.normalizedCode,
			safeReason: item.safeReason,
			httpStatus: item.httpStatus,
			providerCode: item.providerCode,
			retryable: item.retryable,
			classificationVersion: item.classificationVersion,
			firstFailedAt: item.firstFailedAt?.toISOString() || null,
			failedAt: item.failedAt.toISOString(),
			retryingAt: item.retryingAt?.toISOString() || null,
			resolvedAt: item.resolvedAt?.toISOString() || null,
			resolution: item.resolution,
			resolutionComment: item.resolutionComment,
			createdAt: item.createdAt.toISOString(),
			updatedAt: item.updatedAt.toISOString()
		};
	}

	private payload(
		value: Prisma.JsonValue,
		eventId: string
	): Record<string, any> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new ConflictException(
				'Повтор события с некорректным контрактом недоступен'
			);
		}
		const payload = value as Record<string, any>;
		if (
			typeof payload.eventType !== 'string' ||
			!payload.eventType ||
			(payload.eventId !== undefined && payload.eventId !== eventId)
		) {
			throw new ConflictException(
				'Повтор события с некорректным контрактом недоступен'
			);
		}
		return payload;
	}

	private consumer(value: string): value is BillingConsumerKind {
		return BILLING_CONSUMER_KINDS.includes(value as BillingConsumerKind);
	}

	private priorResult(
		receipt: { commandType: string; result: Prisma.JsonValue },
		commandType: string,
		failureId: string
	): Record<string, unknown> {
		if (receipt.commandType !== commandType)
			throw new ConflictException(
				'Command ID was used for another command type'
			);
		const result = receipt.result;
		if (
			!result ||
			typeof result !== 'object' ||
			Array.isArray(result) ||
			result.id !== failureId
		) {
			throw new ConflictException(
				'Command ID was used for another failure'
			);
		}
		return { ...(result as Prisma.JsonObject), duplicate: true };
	}
}
