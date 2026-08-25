import {
	NOTIFICATION_DELIVERY_CONTROL_KINDS,
	NotificationDeliveryControlKind,
	NotificationDeliveryFailuresQueryDto
} from './notification-delivery-control.dto';
import { NotificationDeliveryPrismaService } from '../prisma/notification-delivery-prisma.service';
import { getManualRetryRoutingKey } from '../../messaging/messaging.constants';
import { assertMessagingEventContract } from '../../messaging/messaging-event-contract';
import { createMessagingHeaders } from '../../messaging/messaging-context';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import {
	NotificationDeliveryControlActionKind,
	NotificationDeliveryExchange,
	NotificationDeliveryErrorCategory,
	NotificationDeliveryFailure,
	NotificationDeliveryFailureResolution,
	NotificationDeliveryOutboxStatus,
	NotificationDeliveryReceiptStatus,
	Prisma
} from '@prisma/notification-delivery-client';
import { randomUUID } from 'node:crypto';

const MANUAL_RETRY_STALE_MS = 5 * 60 * 1000;
const HEARTBEAT_FRESHNESS_MS = 30_000;
const OUTBOX_STALE_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOTIFICATION_DELIVERY_SERVICE_NAME = 'notification-delivery-worker';

@Injectable()
export class NotificationDeliveryControlService {
	constructor(
		private readonly prisma: NotificationDeliveryPrismaService
	) {}

	async getOverview() {
		const now = Date.now();
		const nowDate = new Date(now);
		const staleOutboxBefore = new Date(now - OUTBOX_STALE_MS);
		const [
			outboxGroups,
			oldestDuePending,
			oldestExpiredPublishing,
			staleOutbox,
			dueOutbox,
			unresolvedFailures,
			unresolvedFailureGroups,
			retryingFailures,
			deliveredLast24Hours,
			heartbeats
		] = await Promise.all([
			this.prisma.notificationDeliveryOutboxEvent.groupBy({
				by: ['status'],
				_count: { _all: true }
			}),
			this.prisma.notificationDeliveryOutboxEvent.findFirst({
				where: {
					status: NotificationDeliveryOutboxStatus.PENDING,
					availableAt: { lte: nowDate }
				},
				orderBy: { availableAt: 'asc' },
				select: { availableAt: true }
			}),
			this.prisma.notificationDeliveryOutboxEvent.findFirst({
				where: {
					status: NotificationDeliveryOutboxStatus.PUBLISHING,
					leaseExpiresAt: { lte: nowDate }
				},
				orderBy: { leaseExpiresAt: 'asc' },
				select: { leaseExpiresAt: true }
			}),
			this.prisma.notificationDeliveryOutboxEvent.count({
				where: {
					OR: [
						{
							status: NotificationDeliveryOutboxStatus.PENDING,
							availableAt: { lt: staleOutboxBefore }
						},
						{
							status: NotificationDeliveryOutboxStatus.PUBLISHING,
							leaseExpiresAt: { lt: staleOutboxBefore }
						}
					]
				}
			}),
			this.prisma.notificationDeliveryOutboxEvent.count({
				where: {
					OR: [
						{
							status: NotificationDeliveryOutboxStatus.PENDING,
							availableAt: { lte: nowDate }
						},
						{
							status: NotificationDeliveryOutboxStatus.PUBLISHING,
							leaseExpiresAt: { lte: nowDate }
						}
					]
				}
			}),
			this.prisma.notificationDeliveryFailure.count({
				where: {
					consumer: {
						in: [...NOTIFICATION_DELIVERY_CONTROL_KINDS]
					},
					resolvedAt: null
				}
			}),
			this.prisma.notificationDeliveryFailure.groupBy({
				by: ['category', 'normalizedCode'],
				where: {
					consumer: {
						in: [...NOTIFICATION_DELIVERY_CONTROL_KINDS]
					},
					resolvedAt: null
				},
				_count: { _all: true }
			}),
			this.prisma.notificationDeliveryFailure.count({
				where: {
					consumer: {
						in: [...NOTIFICATION_DELIVERY_CONTROL_KINDS]
					},
					resolvedAt: null,
					retryingAt: { not: null }
				}
			}),
			this.prisma.notificationDeliveryReceipt.count({
				where: {
					consumer: {
						in: [...NOTIFICATION_DELIVERY_CONTROL_KINDS]
					},
					status: NotificationDeliveryReceiptStatus.DELIVERED,
					deliveredAt: { gte: new Date(now - DAY_MS) }
				}
			}),
			this.prisma.notificationDeliveryHeartbeat.findMany({
				where: { service: NOTIFICATION_DELIVERY_SERVICE_NAME },
				orderBy: { lastSeenAt: 'desc' }
			})
		]);

		const outbox = Object.fromEntries(
			Object.values(NotificationDeliveryOutboxStatus).map(status => [
				status,
				0
			])
		) as Record<NotificationDeliveryOutboxStatus, number>;
		for (const group of outboxGroups) {
			outbox[group.status] = group._count._all;
		}
		const unresolvedFailuresByCategory = {
			TRANSIENT: 0,
			RATE_LIMIT: 0,
			PERMANENT: 0,
			AUTH_CONFIGURATION: 0,
			UNCLASSIFIED: 0
		} satisfies Record<
			NotificationDeliveryErrorCategory | 'UNCLASSIFIED',
			number
		>;
		for (const group of unresolvedFailureGroups) {
			const category =
				group.normalizedCode === 'UNCLASSIFIED'
					? 'UNCLASSIFIED'
					: group.category;
			unresolvedFailuresByCategory[category] += group._count._all;
		}
		const oldestPendingAt = [
			oldestDuePending?.availableAt,
			oldestExpiredPublishing?.leaseExpiresAt
		]
			.filter((value): value is Date => Boolean(value))
			.sort((left, right) => left.getTime() - right.getTime())[0];
		const staleBefore = new Date(now - HEARTBEAT_FRESHNESS_MS);
		const runningHeartbeats = heartbeats.filter(heartbeat =>
			this.isRunningHeartbeat(heartbeat.metadata)
		);
		const latestHeartbeat = runningHeartbeats[0] || null;
		const activeInstances = runningHeartbeats.filter(
			item => item.lastSeenAt >= staleBefore
		).length;

		return {
			generatedAt: new Date(now).toISOString(),
			outbox,
			oldestPendingAt: oldestPendingAt?.toISOString() || null,
			operational: {
				staleOutbox,
				dueOutbox,
				unresolvedFailuresByCategory
			},
			unresolvedFailures,
			retryingFailures,
			deliveredLast24Hours,
			heartbeat: {
				service: NOTIFICATION_DELIVERY_SERVICE_NAME,
				status: activeInstances > 0 ? ('ok' as const) : ('down' as const),
				activeInstances,
				lastSeenAt: latestHeartbeat?.lastSeenAt.toISOString() || null,
				lastSuccessfulPublishAt: this.getLatestHeartbeatActivity(
					runningHeartbeats,
					'lastSuccessfulPublishAt'
				),
				lastSuccessfulConsumeAt: this.getLatestHeartbeatActivity(
					runningHeartbeats,
					'lastSuccessfulConsumeAt'
				)
			}
		};
	}

	async getFailures(query: NotificationDeliveryFailuresQueryDto) {
		const page = query.page ?? 1;
		const limit = query.limit ?? 20;
		const where = this.getFailureWhere(query);
		const [items, total] = await this.prisma.$transaction([
			this.prisma.notificationDeliveryFailure.findMany({
				where,
				orderBy: [{ failedAt: 'desc' }, { id: 'desc' }],
				skip: (page - 1) * limit,
				take: limit
			}),
			this.prisma.notificationDeliveryFailure.count({ where })
		]);

		return {
			items: items.map(item => this.serializeFailure(item)),
			total,
			page,
			limit,
			totalPages: Math.max(1, Math.ceil(total / limit))
		};
	}

	async getFailure(id: string) {
		const failure =
			await this.prisma.notificationDeliveryFailure.findUnique({
				where: { id }
			});
		if (!failure || !this.isSupportedKind(failure.consumer)) {
			throw new NotFoundException('Ошибка доставки не найдена');
		}
		return this.serializeFailure(failure);
	}

	async retryFailure(id: string, actorId: string) {
		const normalizedActorId = this.normalizeActorId(actorId);
		const retryingAt = new Date();
		const staleRetryBefore = new Date(
			retryingAt.getTime() - MANUAL_RETRY_STALE_MS
		);
		const retryToken = randomUUID();

		const result = await this.prisma.$transaction(async transaction => {
			const failure =
				await transaction.notificationDeliveryFailure.findUnique({
					where: { id }
				});
			if (!failure || !this.isSupportedKind(failure.consumer)) {
				throw new NotFoundException('Ошибка доставки не найдена');
			}
			if (failure.resolvedAt) {
				throw new ConflictException('Ошибка уже обработана');
			}

			const kind = failure.consumer;
			if (kind === 'campaign-email' || kind === 'campaign-telegram') {
				throw new ConflictException(
					'Повтор доставки кампании доступен только через Campaigns API'
				);
			}
			const eventType = this.getFailureEventType(failure.payload);
			const routingKey = getManualRetryRoutingKey(kind);
			try {
				assertMessagingEventContract(failure.payload, {
					eventType,
					routingKey,
					messageId: failure.eventId,
					kind
				});
			} catch {
				throw new ConflictException(
					'Повтор события с некорректным контрактом недоступен'
				);
			}

			const claimedReceipt =
				await transaction.notificationDeliveryReceipt.updateMany({
					where: {
						eventId: failure.eventId,
						consumer: kind,
						OR: [
							{
								status: NotificationDeliveryReceiptStatus.DEAD_LETTERED
							},
							{
								status: NotificationDeliveryReceiptStatus.RETRY_SCHEDULED,
								retryAvailableAt: { lt: staleRetryBefore }
							}
						]
					},
					data: {
						status: NotificationDeliveryReceiptStatus.RETRY_SCHEDULED,
						lockedAt: null,
						lockedBy: null,
						lockToken: null,
						leaseExpiresAt: null,
						deliveredAt: null,
						retryAttempt: 0,
						retryAvailableAt: retryingAt,
						retryToken
					}
				});
			if (claimedReceipt.count !== 1) {
				throw new ConflictException(
					'Событие уже доставляется или было обработано'
				);
			}

			const claimedFailure =
				await transaction.notificationDeliveryFailure.updateMany({
					where: {
						id,
						consumer: kind,
						resolvedAt: null,
						OR: [
							{
								retryingAt: null,
								activeRetryToken: null
							},
							{
								retryingAt: { lt: staleRetryBefore },
								activeRetryToken: { not: null }
							}
						]
					},
					data: {
						retryingAt,
						activeRetryToken: retryToken
					}
				});
			if (claimedFailure.count !== 1) {
				throw new ConflictException('Повторная отправка уже выполняется');
			}

			await transaction.notificationDeliveryOutboxEvent.create({
				data: {
					messageId: failure.eventId,
					deduplicationKey: `manual-retry:${failure.id}:${retryToken}`,
					exchange: NotificationDeliveryExchange.EVENTS,
					eventType,
					routingKey,
					payload: failure.payload as Prisma.InputJsonValue,
					headers: createMessagingHeaders({
						messageId: failure.eventId,
						causationId: failure.eventId,
						headers: {
							'x-retry-attempt': 0,
							'x-delivery-token': retryToken,
							'x-control-actor-id': normalizedActorId
						}
					})
				}
			});
			await transaction.notificationDeliveryControlAction.create({
				data: {
					action: NotificationDeliveryControlActionKind.RETRY,
					failureId: failure.id,
					eventId: failure.eventId,
					kind,
					actorId: normalizedActorId,
					comment: null,
					createdAt: retryingAt
				}
			});

			return { failure, kind };
		});

		return {
			id: result.failure.id,
			eventId: result.failure.eventId,
			integration: result.kind,
			retryingAt: retryingAt.toISOString()
		};
	}

	async closeFailure(id: string, actorId: string, comment: string) {
		const normalizedActorId = this.normalizeActorId(actorId);
		const normalizedComment = comment.trim();
		if (normalizedComment.length < 3 || normalizedComment.length > 1000) {
			throw new BadRequestException(
				'Комментарий должен содержать от 3 до 1000 символов'
			);
		}
		const resolvedAt = new Date();

		return this.prisma.$transaction(async transaction => {
			const failure =
				await transaction.notificationDeliveryFailure.findUnique({
					where: { id }
				});
			if (!failure || !this.isSupportedKind(failure.consumer)) {
				throw new NotFoundException('Ошибка доставки не найдена');
			}
			if (failure.resolvedAt) {
				throw new ConflictException('Ошибка уже обработана');
			}
			if (failure.retryingAt) {
				throw new ConflictException(
					'Нельзя закрыть ошибку во время повторной отправки'
				);
			}

			const closedReceipt =
				await transaction.notificationDeliveryReceipt.updateMany({
					where: {
						eventId: failure.eventId,
						consumer: failure.consumer,
						status: NotificationDeliveryReceiptStatus.DEAD_LETTERED
					},
					data: {
						status: NotificationDeliveryReceiptStatus.CLOSED_NO_RETRY,
						lockedAt: null,
						lockedBy: null,
						lockToken: null,
						leaseExpiresAt: null,
						deliveredAt: null,
						retryAttempt: null,
						retryAvailableAt: null,
						retryToken: null
					}
				});
			if (closedReceipt.count !== 1) {
				throw new ConflictException(
					'Событие уже доставляется или было обработано'
				);
			}

			const closedFailure =
				await transaction.notificationDeliveryFailure.updateMany({
					where: {
						id,
						consumer: failure.consumer,
						resolvedAt: null,
						retryingAt: null,
						activeRetryToken: null
					},
					data: {
						resolvedAt,
						resolution:
							NotificationDeliveryFailureResolution.CLOSED_NO_RETRY,
						resolutionComment: normalizedComment,
						resolvedById: normalizedActorId,
						activeRetryToken: null
					}
				});
			if (closedFailure.count !== 1) {
				throw new ConflictException(
					'Ошибка уже обрабатывается или была закрыта'
				);
			}
			await transaction.notificationDeliveryControlAction.create({
				data: {
					action: NotificationDeliveryControlActionKind.CLOSE,
					failureId: failure.id,
					eventId: failure.eventId,
					kind: failure.consumer,
					actorId: normalizedActorId,
					comment: normalizedComment,
					createdAt: resolvedAt
				}
			});

			return {
				id: failure.id,
				eventId: failure.eventId,
				integration: failure.consumer,
				resolvedAt: resolvedAt.toISOString(),
				resolution: NotificationDeliveryFailureResolution.CLOSED_NO_RETRY,
				resolutionComment: normalizedComment
			};
		});
	}

	private getFailureWhere(
		query: NotificationDeliveryFailuresQueryDto
	): Prisma.NotificationDeliveryFailureWhereInput {
		const where: Prisma.NotificationDeliveryFailureWhereInput = {
			consumer: query.integration
				? query.integration
				: { in: [...NOTIFICATION_DELIVERY_CONTROL_KINDS] }
		};

		if (query.category) {
			where.category = query.category;
		}
		if (query.status === 'FAILED') {
			where.resolvedAt = null;
			where.retryingAt = null;
		} else if (query.status === 'RETRYING') {
			where.resolvedAt = null;
			where.retryingAt = { not: null };
		} else if (query.status === 'RESOLVED') {
			where.resolution = NotificationDeliveryFailureResolution.DELIVERED;
		} else if (query.status === 'CLOSED') {
			where.resolution =
				NotificationDeliveryFailureResolution.CLOSED_NO_RETRY;
		}
		return where;
	}

	private normalizeActorId(actorId: string): string {
		const normalized = actorId.trim();
		if (!normalized || normalized.length > 255) {
			throw new BadRequestException('Некорректный идентификатор автора');
		}
		return normalized;
	}

	private getLatestHeartbeatActivity(
		heartbeats: Array<{ metadata: Prisma.JsonValue }>,
		key: 'lastSuccessfulPublishAt' | 'lastSuccessfulConsumeAt'
	): string | null {
		let latestTimestamp = Number.NEGATIVE_INFINITY;
		let latest: string | null = null;

		for (const heartbeat of heartbeats) {
			if (
				!heartbeat.metadata ||
				typeof heartbeat.metadata !== 'object' ||
				Array.isArray(heartbeat.metadata)
			) {
				continue;
			}
			const value = heartbeat.metadata[key];
			if (typeof value !== 'string') continue;
			const timestamp = Date.parse(value);
			if (!Number.isFinite(timestamp) || timestamp <= latestTimestamp) {
				continue;
			}
			latestTimestamp = timestamp;
			latest = new Date(timestamp).toISOString();
		}

		return latest;
	}

	private isRunningHeartbeat(metadata: Prisma.JsonValue): boolean {
		return Boolean(
			metadata &&
			typeof metadata === 'object' &&
			!Array.isArray(metadata) &&
			metadata.status === 'running'
		);
	}

	private getFailureEventType(payload: Prisma.JsonValue): string {
		if (
			payload &&
			typeof payload === 'object' &&
			!Array.isArray(payload) &&
			typeof payload.eventType === 'string'
		) {
			return payload.eventType;
		}
		throw new ConflictException(
			'Повтор события с некорректным контрактом недоступен'
		);
	}

	private isSupportedKind(
		value: string
	): value is NotificationDeliveryControlKind {
		return NOTIFICATION_DELIVERY_CONTROL_KINDS.includes(
			value as NotificationDeliveryControlKind
		);
	}

	private serializeFailure(item: NotificationDeliveryFailure) {
		const payload =
			item.payload &&
			typeof item.payload === 'object' &&
			!Array.isArray(item.payload)
				? item.payload
				: {};
		const entity =
			payload.entity &&
			typeof payload.entity === 'object' &&
			!Array.isArray(payload.entity)
				? payload.entity
				: null;
		const lead =
			payload.lead &&
			typeof payload.lead === 'object' &&
			!Array.isArray(payload.lead)
				? payload.lead
				: null;

		return {
			id: item.id,
			eventId: item.eventId,
			integration: item.consumer,
			attempts: item.attempts,
			lastError: item.lastError,
			category: item.category,
			normalizedCode: item.normalizedCode,
			safeReason: item.safeReason,
			httpStatus: item.httpStatus,
			providerCode: item.providerCode,
			retryable: item.retryable,
			failedAt: item.failedAt.toISOString(),
			retryingAt: item.retryingAt?.toISOString() || null,
			resolvedAt: item.resolvedAt?.toISOString() || null,
			resolution: item.resolution,
			resolutionComment: item.resolutionComment,
			source: typeof payload.source === 'string' ? payload.source : null,
			entity: entity
				? {
						id: typeof entity.id === 'string' ? entity.id : undefined,
						name: typeof entity.name === 'string' ? entity.name : undefined
					}
				: undefined,
			lead: {
				id: typeof lead?.id === 'string' ? lead.id : null,
				contact: typeof lead?.contact === 'string' ? lead.contact : null,
				phone: typeof lead?.phone === 'string' ? lead.phone : null,
				email: typeof lead?.email === 'string' ? lead.email : null,
				url: typeof lead?.url === 'string' ? lead.url : null,
				createdAt:
					typeof lead?.createdAt === 'string' ? lead.createdAt : null
			}
		};
	}
}
