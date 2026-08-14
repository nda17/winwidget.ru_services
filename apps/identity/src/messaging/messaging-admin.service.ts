import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import {
	ConsumerFailureStatus,
	ConsumerReceiptStatus,
	OutboxExchange,
	OutboxStatus,
	Prisma
} from '@prisma/identity-client';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { clientIp } from '../common/identity.util';
import { IdentityEventsService } from '../events/identity-events.service';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import {
	parseDestinationEvent,
	semanticJsonHash
} from './destination-worker.service';
import {
	DESTINATION_EVENT,
	DESTINATION_KIND
} from './messaging.constants';

const CONSUMER = 'telegram-destination-unavailable';
const MANUAL_RETRY_LEASE_MS = 5 * 60_000;
const CATEGORIES = [
	'TRANSIENT',
	'RATE_LIMIT',
	'PERMANENT',
	'AUTH_CONFIGURATION'
] as const;
type FailureCategory = (typeof CATEGORIES)[number];

@Injectable()
export class IdentityMessagingAdminService {
	constructor(
		private readonly prisma: IdentityPrismaService,
		private readonly events: IdentityEventsService
	) {}

	async overview() {
		const now = new Date();
		const lastDay = new Date(now.getTime() - 86_400_000);
		const activeSince = new Date(now.getTime() - 30_000);
		const [outbox, oldest, unresolved, retrying, delivered, heartbeats] =
			await Promise.all([
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
				this.prisma.consumerFailure.count({
					where: {
						consumer: CONSUMER,
						status: {
							in: [
								ConsumerFailureStatus.OPEN,
								ConsumerFailureStatus.RETRYING
							]
						}
					}
				}),
				this.prisma.consumerFailure.count({
					where: {
						consumer: CONSUMER,
						status: ConsumerFailureStatus.RETRYING
					}
				}),
				this.prisma.consumerReceipt.count({
					where: {
						consumer: CONSUMER,
						status: ConsumerReceiptStatus.DELIVERED,
						deliveredAt: { gte: lastDay }
					}
				}),
				this.prisma.identityHeartbeat.findMany({
					where: { lastSeenAt: { gte: activeSince } },
					orderBy: { lastSeenAt: 'desc' },
					select: { role: true, instanceId: true, lastSeenAt: true }
				})
			]);
		const count = (status: OutboxStatus) =>
			outbox.find(row => row.status === status)?._count._all || 0;
		const roles = [...new Set(heartbeats.map(item => item.role))];
		return {
			generatedAt: now.toISOString(),
			outbox: {
				PENDING: count(OutboxStatus.PENDING),
				PUBLISHING: count(OutboxStatus.PROCESSING),
				PUBLISHED: count(OutboxStatus.PUBLISHED),
				FAILED: 0
			},
			oldestPendingAt: oldest?.availableAt.toISOString() || null,
			unresolvedFailures: unresolved,
			retryingFailures: retrying,
			deliveredLast24Hours: delivered,
			rabbitMqError: null,
			notificationDeliveryError: null,
			widgetsError: null,
			billingError: null,
			heartbeats: roles.map(role => {
				const rows = heartbeats.filter(item => item.role === role);
				return {
					service: `identity-${role}`,
					status: 'ok' as const,
					activeInstances: new Set(rows.map(item => item.instanceId)).size,
					lastSeenAt: rows[0]?.lastSeenAt.toISOString() || null
				};
			}),
			queues: []
		};
	}

	async failures(
		page = 1,
		limit = 20,
		filters: {
			consumer?: string;
			category?: string;
			status?: string;
		} = {}
	) {
		const normalizedPage =
			Number.isSafeInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const offset = (normalizedPage - 1) * normalizedLimit;
		if (
			!Number.isSafeInteger(offset) ||
			offset + normalizedLimit > 10_000
		) {
			throw new BadRequestException(
				'Слишком глубокая страница истории ошибок'
			);
		}
		const consumer = filters.consumer?.trim() || CONSUMER;
		if (consumer !== CONSUMER) {
			throw new BadRequestException(
				'Тип интеграции не принадлежит Identity'
			);
		}
		const category = filters.category?.trim().toUpperCase();
		if (category && !CATEGORIES.includes(category as FailureCategory)) {
			throw new BadRequestException(
				'Некорректная категория ошибки доставки'
			);
		}
		const where: Prisma.ConsumerFailureWhereInput = {
			consumer,
			...this.statusWhere(filters.status)
		};
		const rows = await this.prisma.consumerFailure.findMany({
			where,
			orderBy: [{ lastFailedAt: 'desc' }, { id: 'desc' }],
			take: 10_001
		});
		if (rows.length > 10_000) {
			throw new BadRequestException('Слишком глубокая история ошибок');
		}
		const items = rows
			.map(item => this.serialize(item))
			.filter(item => !category || item.category === category);
		return {
			items: items.slice(offset, offset + normalizedLimit),
			total: items.length,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(items.length / normalizedLimit))
		};
	}

	async retry(id: string, actorId: string, request?: Request) {
		const now = new Date();
		const leaseExpiresAt = new Date(now.getTime() + MANUAL_RETRY_LEASE_MS);
		return this.prisma.$transaction(
			async transaction => {
				const failure = await transaction.consumerFailure.findUnique({
					where: { id }
				});
				if (!failure || failure.consumer !== CONSUMER) {
					throw new NotFoundException('Ошибка доставки не найдена');
				}
				if (
					failure.status === ConsumerFailureStatus.RESOLVED ||
					failure.status === ConsumerFailureStatus.CLOSED_NO_RETRY
				) {
					throw new ConflictException('Ошибка уже обработана');
				}
				let event;
				try {
					event = parseDestinationEvent(failure.payload);
				} catch {
					throw new ConflictException(
						'Повтор события с некорректным контрактом недоступен'
					);
				}
				const payloadHash = semanticJsonHash(event);
				if (failure.payloadHash !== payloadHash) {
					throw new ConflictException(
						'Повтор события с некорректным контрактом недоступен'
					);
				}
				const receipt = await transaction.consumerReceipt.findUnique({
					where: {
						eventId_consumer: {
							eventId: failure.eventId,
							consumer: CONSUMER
						}
					}
				});
				if (
					!receipt ||
					receipt.status !== ConsumerReceiptStatus.DEAD_LETTERED ||
					receipt.payloadHash !== payloadHash ||
					receipt.manualRetryCycle !== failure.manualRetryCount
				) {
					throw new ConflictException(
						'Событие уже доставляется или было обработано'
					);
				}
				const cycle = failure.manualRetryCount + 1;
				const deliveryToken = randomUUID();
				const failureClaimed =
					await transaction.consumerFailure.updateMany({
						where: {
							id,
							manualRetryCount: failure.manualRetryCount,
							OR: [
								{ status: ConsumerFailureStatus.OPEN },
								{
									status: ConsumerFailureStatus.RETRYING,
									retryLeaseExpiresAt: { lte: now }
								}
							]
						},
						data: {
							status: ConsumerFailureStatus.RETRYING,
							manualRetryCount: cycle,
							retryRequestedAt: now,
							retryRequestedById: actorId,
							retryToken: deliveryToken,
							retryLeaseExpiresAt: leaseExpiresAt,
							resolvedAt: null,
							resolutionComment: null
						}
					});
				if (failureClaimed.count !== 1) {
					throw new ConflictException(
						'Повторная отправка уже выполняется'
					);
				}
				const receiptClaimed =
					await transaction.consumerReceipt.updateMany({
						where: {
							id: receipt.id,
							status: ConsumerReceiptStatus.DEAD_LETTERED,
							payloadHash,
							manualRetryCycle: failure.manualRetryCount
						},
						data: {
							status: ConsumerReceiptStatus.RETRY_SCHEDULED,
							retryAttempt: 0,
							manualRetryCycle: cycle,
							lockToken: deliveryToken,
							lockedAt: null,
							lockedBy: null,
							leaseExpiresAt: null,
							deliveredAt: null,
							lastError: null
						}
					});
				if (receiptClaimed.count !== 1) {
					throw new ConflictException(
						'Состояние доставки изменилось параллельно'
					);
				}
				await transaction.outboxEvent.create({
					data: {
						messageId: randomUUID(),
						deduplicationKey: `${CONSUMER}:${failure.eventId}:manual:${cycle}`,
						exchange: OutboxExchange.MANUAL_RETRY,
						eventType: DESTINATION_EVENT,
						routingKey: DESTINATION_KIND,
						payload: event as unknown as Prisma.InputJsonValue,
						headers: {
							'x-original-event-id': failure.eventId,
							'x-delivery-token': deliveryToken,
							'x-retry-attempt': 0,
							'x-manual-retry-cycle': cycle,
							'x-manual-retry': true
						}
					}
				});
				await this.events.emitAudit(transaction, {
					actorId,
					section: 'MESSAGING',
					action: 'MESSAGING_FAILURE_RETRY',
					entityType: 'integration_delivery_failure',
					entityId: failure.id,
					entityLabel: CONSUMER,
					description: `Повторно отправлено событие интеграции ${CONSUMER}`,
					metadata: { integration: CONSUMER },
					...this.requestAudit(request)
				});
				return {
					id: failure.id,
					eventId: failure.eventId,
					integration: CONSUMER,
					retryingAt: now.toISOString()
				};
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	async close(
		id: string,
		actorId: string,
		comment: string,
		request?: Request
	) {
		const normalizedComment = comment.trim();
		if (normalizedComment.length < 3 || normalizedComment.length > 1_000) {
			throw new BadRequestException(
				'Комментарий должен содержать от 3 до 1000 символов'
			);
		}
		const resolvedAt = new Date();
		return this.prisma.$transaction(
			async transaction => {
				const failure = await transaction.consumerFailure.findUnique({
					where: { id }
				});
				if (!failure || failure.consumer !== CONSUMER) {
					throw new NotFoundException('Ошибка доставки не найдена');
				}
				if (
					failure.status === ConsumerFailureStatus.RESOLVED ||
					failure.status === ConsumerFailureStatus.CLOSED_NO_RETRY
				) {
					throw new ConflictException('Ошибка уже обработана');
				}
				if (failure.status === ConsumerFailureStatus.RETRYING) {
					throw new ConflictException(
						'Нельзя закрыть ошибку во время повторной отправки'
					);
				}
				const receipt = await transaction.consumerReceipt.updateMany({
					where: {
						eventId: failure.eventId,
						consumer: CONSUMER,
						status: ConsumerReceiptStatus.DEAD_LETTERED,
						payloadHash: failure.payloadHash
					},
					data: {
						status: ConsumerReceiptStatus.CLOSED_NO_RETRY,
						lockedAt: null,
						lockedBy: null,
						lockToken: null,
						leaseExpiresAt: null,
						lastError: null
					}
				});
				if (receipt.count !== 1) {
					throw new ConflictException(
						'Событие уже запланировано или было обработано'
					);
				}
				const closed = await transaction.consumerFailure.updateMany({
					where: { id, status: ConsumerFailureStatus.OPEN },
					data: {
						status: ConsumerFailureStatus.CLOSED_NO_RETRY,
						resolvedAt,
						resolutionComment: normalizedComment,
						retryRequestedById: actorId,
						retryToken: null,
						retryLeaseExpiresAt: null
					}
				});
				if (closed.count !== 1) {
					throw new ConflictException(
						'Ошибка уже обрабатывается или была закрыта'
					);
				}
				await this.events.emitAudit(transaction, {
					actorId,
					section: 'MESSAGING',
					action: 'MESSAGING_FAILURE_CLOSE_WITHOUT_RETRY',
					entityType: 'integration_delivery_failure',
					entityId: failure.id,
					entityLabel: CONSUMER,
					description: `Закрыта без повтора ошибка интеграции ${CONSUMER}`,
					metadata: {
						integration: CONSUMER,
						comment: normalizedComment
					},
					...this.requestAudit(request)
				});
				return {
					id: failure.id,
					eventId: failure.eventId,
					integration: CONSUMER,
					resolvedAt: resolvedAt.toISOString(),
					resolution: 'CLOSED_NO_RETRY' as const,
					resolutionComment: normalizedComment
				};
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	private statusWhere(status?: string): Prisma.ConsumerFailureWhereInput {
		const normalized = status?.trim().toUpperCase();
		if (!normalized || normalized === 'ALL') return {};
		if (normalized === 'FAILED')
			return { status: ConsumerFailureStatus.OPEN };
		if (normalized === 'RETRYING') {
			return { status: ConsumerFailureStatus.RETRYING };
		}
		if (normalized === 'RESOLVED') {
			return { status: ConsumerFailureStatus.RESOLVED };
		}
		if (normalized === 'CLOSED') {
			return { status: ConsumerFailureStatus.CLOSED_NO_RETRY };
		}
		throw new BadRequestException('Некорректный статус ошибки доставки');
	}

	private serialize(item: {
		id: string;
		eventId: string;
		consumer: string;
		eventType: string;
		payload: Prisma.JsonValue;
		attempts: number;
		lastError: string;
		lastFailedAt: Date;
		retryRequestedAt: Date | null;
		resolvedAt: Date | null;
		status: ConsumerFailureStatus;
		resolutionComment: string | null;
	}) {
		let normalizedCode = 'INVALID_EVENT_CONTRACT';
		let source = 'identity';
		if (item.eventType === DESTINATION_EVENT) {
			try {
				const payload = parseDestinationEvent(item.payload);
				normalizedCode = payload.normalizedCode;
				source = payload.sourceKind;
			} catch {
				// Poison rows remain visible and closable, but never manually retryable.
			}
		}
		const category = this.category(normalizedCode);
		return {
			id: item.id,
			eventId: item.eventId,
			integration: item.consumer,
			attempts: item.attempts,
			lastError: item.lastError,
			category,
			normalizedCode,
			safeReason: item.lastError,
			failedAt: item.lastFailedAt.toISOString(),
			retryingAt:
				item.status === ConsumerFailureStatus.RETRYING
					? item.retryRequestedAt?.toISOString() || null
					: null,
			resolvedAt: item.resolvedAt?.toISOString() || null,
			resolution:
				item.status === ConsumerFailureStatus.RESOLVED
					? 'DELIVERED'
					: item.status === ConsumerFailureStatus.CLOSED_NO_RETRY
						? 'CLOSED_NO_RETRY'
						: null,
			resolutionComment: item.resolutionComment,
			source,
			entity: null,
			lead: null
		};
	}

	private category(normalizedCode: string): FailureCategory {
		const value = normalizedCode.toUpperCase();
		if (value.includes('RATE') || value.includes('429'))
			return 'RATE_LIMIT';
		if (
			value.includes('AUTH') ||
			value.includes('TOKEN') ||
			value.includes('CREDENTIAL')
		) {
			return 'AUTH_CONFIGURATION';
		}
		if (
			value.includes('TIMEOUT') ||
			value.includes('NETWORK') ||
			value.includes('UNAVAILABLE') ||
			value.includes('5XX')
		) {
			return 'TRANSIENT';
		}
		return 'PERMANENT';
	}

	private requestAudit(request?: Request) {
		return request
			? {
					requestId: request.header('x-request-id'),
					requestIp: clientIp(request),
					requestUserAgent: request.get('user-agent')?.slice(0, 500),
					correlationId: request.header('x-correlation-id')
				}
			: {};
	}
}
