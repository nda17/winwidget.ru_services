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
import {
	BILLING_PROCESS_ROLES,
	BillingProcessRole,
	parseBillingPort
} from '../runtime/billing-runtime.service';
import { enqueueBillingAdminAudit } from './billing-admin-audit';

type BillingRoleReadiness = {
	service:
		| 'billing-api'
		| 'billing-scheduler'
		| 'billing-worker'
		| 'billing-outbox-publisher';
	status: 'ok' | 'down';
	activeInstances: number;
	lastSeenAt: string | null;
	revision: string | null;
	providers?: BillingProviderReadiness;
};

type BillingProviderReadiness = {
	yookassa: boolean;
};

const EMPTY_FAILURE_CATEGORY_COUNTS = {
	TRANSIENT: 0,
	RATE_LIMIT: 0,
	PERMANENT: 0,
	AUTH_CONFIGURATION: 0,
	UNCLASSIFIED: 0
};

const BILLING_ROLE_SERVICE_NAMES: Record<
	BillingProcessRole,
	BillingRoleReadiness['service']
> = {
	api: 'billing-api',
	scheduler: 'billing-scheduler',
	worker: 'billing-worker',
	'outbox-publisher': 'billing-outbox-publisher'
};

@Injectable()
export class BillingMessagingAdminService {
	constructor(private readonly prisma: BillingPrismaService) {}

	async overview() {
		const now = new Date();
		const since = new Date(now.getTime() - 24 * 60 * 60_000);
		const staleBefore = new Date(now.getTime() - 15 * 60_000);
		const [
			outboxGroups,
			oldestDuePending,
			oldestExpiredProcessing,
			oldestUnleasedProcessing,
			dueOutbox,
			staleOutbox,
			unresolvedFailures,
			retryingFailures,
			deliveredLast24Hours,
			failureCategoryGroups,
			roleReadiness
		] = await Promise.all([
			this.prisma.outboxEvent.groupBy({
				by: ['status'],
				_count: { _all: true }
			}),
			this.prisma.outboxEvent.findFirst({
				where: {
					status: OutboxStatus.PENDING,
					availableAt: { lte: now }
				},
				orderBy: { availableAt: 'asc' },
				select: { availableAt: true }
			}),
			this.prisma.outboxEvent.findFirst({
				where: {
					status: OutboxStatus.PROCESSING,
					leaseUntil: { lte: now }
				},
				orderBy: { leaseUntil: 'asc' },
				select: { leaseUntil: true }
			}),
			this.prisma.outboxEvent.findFirst({
				where: {
					status: OutboxStatus.PROCESSING,
					leaseUntil: null
				},
				orderBy: { createdAt: 'asc' },
				select: { createdAt: true }
			}),
			this.prisma.outboxEvent.count({
				where: {
					OR: [
						{
							status: OutboxStatus.PENDING,
							availableAt: { lte: now }
						},
						{
							status: OutboxStatus.PROCESSING,
							OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }]
						}
					]
				}
			}),
			this.prisma.outboxEvent.count({
				where: {
					OR: [
						{
							status: OutboxStatus.PENDING,
							availableAt: { lt: staleBefore }
						},
						{
							status: OutboxStatus.PROCESSING,
							OR: [
								{ leaseUntil: null },
								{ leaseUntil: { lt: staleBefore } }
							]
						}
					]
				}
			}),
			this.prisma.integrationDeliveryFailure.count({
				where: { resolvedAt: null }
			}),
			this.prisma.integrationDeliveryFailure.count({
				where: { resolvedAt: null, retryingAt: { not: null } }
			}),
			this.prisma.integrationDeliveryReceipt.count({
				where: {
					status: DeliveryReceiptStatus.DELIVERED,
					deliveredAt: { gte: since }
				}
			}),
			this.prisma.integrationDeliveryFailure.groupBy({
				by: ['category', 'normalizedCode'],
				where: { resolvedAt: null },
				_count: { _all: true }
			}),
			Promise.all(
				BILLING_PROCESS_ROLES.map(role => this.getRoleReadiness(role))
			)
		]);
		const outbox = { PENDING: 0, PROCESSING: 0, PUBLISHED: 0 };
		for (const group of outboxGroups)
			outbox[group.status] = group._count._all;
		const unresolvedFailuresByCategory = {
			...EMPTY_FAILURE_CATEGORY_COUNTS
		};
		for (const group of failureCategoryGroups) {
			const category =
				!group.category || group.normalizedCode === 'UNCLASSIFIED'
					? 'UNCLASSIFIED'
					: group.category;
			unresolvedFailuresByCategory[category] += group._count._all;
		}
		const oldestPendingAt = [
			oldestDuePending?.availableAt || null,
			oldestExpiredProcessing?.leaseUntil || null,
			oldestUnleasedProcessing?.createdAt || null
		]
			.filter((value): value is Date => Boolean(value))
			.sort((left, right) => left.getTime() - right.getTime())[0];
		const providers = roleReadiness.find(
			item => item.service === 'billing-worker'
		)?.providers;
		const heartbeats = roleReadiness.map(item => ({
			service: item.service,
			status: item.status,
			activeInstances: item.activeInstances,
			lastSeenAt: item.lastSeenAt,
			revision: item.revision
		}));
		return {
			schemaVersion: 1 as const,
			generatedAt: new Date().toISOString(),
			outbox,
			oldestPendingAt: oldestPendingAt?.toISOString() || null,
			unresolvedFailures,
			retryingFailures,
			deliveredLast24Hours,
			operational: {
				dueOutbox,
				staleOutbox,
				unresolvedFailuresByCategory
			},
			...(providers ? { providers } : {}),
			heartbeats
		};
	}

	private async getRoleReadiness(
		role: BillingProcessRole
	): Promise<BillingRoleReadiness> {
		const service = BILLING_ROLE_SERVICE_NAMES[role];
		try {
			const response = await fetch(
				`http://127.0.0.1:${parseBillingPort(role)}/health/ready`,
				{
					headers: { Accept: 'application/json' },
					redirect: 'error',
					signal: AbortSignal.timeout(2_000)
				}
			);
			const body: unknown = await response.json().catch(() => null);
			if (!response.ok || !this.isRoleReadiness(body, role)) {
				return this.downRole(service);
			}
			return {
				service,
				status: 'ok',
				activeInstances: 1,
				lastSeenAt: new Date().toISOString(),
				revision: body.revision,
				...(role === 'worker' && body.providers
					? { providers: body.providers }
					: {})
			};
		} catch {
			return this.downRole(service);
		}
	}

	private isRoleReadiness(
		value: unknown,
		role: BillingProcessRole
	): value is {
		status: 'ready';
		service: 'billing';
		role: BillingProcessRole;
		revision: string;
		providers?: BillingProviderReadiness;
	} {
		const record = value as Record<string, unknown>;
		return (
			Boolean(value) &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			record.status === 'ready' &&
			record.service === 'billing' &&
			record.role === role &&
			typeof record.revision === 'string' &&
			Boolean(record.revision) &&
			(record.providers === undefined ||
				(role === 'worker' && this.isProviderReadiness(record.providers)))
		);
	}

	private isProviderReadiness(
		value: unknown
	): value is BillingProviderReadiness {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return false;
		}
		const record = value as Record<string, unknown>;
		return (
			Object.keys(record).length === 1 &&
			typeof record.yookassa === 'boolean'
		);
	}

	private downRole(
		service: BillingRoleReadiness['service']
	): BillingRoleReadiness {
		return {
			service,
			status: 'down',
			activeInstances: 0,
			lastSeenAt: null,
			revision: null
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
