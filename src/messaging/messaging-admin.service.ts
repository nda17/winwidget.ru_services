import { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import {
	LeadIntegrationEventPayload,
	LeadIntegrationEventPayloadV2
} from '@/messaging/lead-integration-event';
import { LeadIntegrationDestinationService } from '@/messaging/lead-integration-destination.service';
import {
	getManualRetryRoutingKey,
	LEAD_INTEGRATION_KINDS,
	MESSAGING_KINDS,
	MessagingKind,
	NOTIFICATION_DELIVERY_KINDS,
	NotificationDeliveryKind,
	OUTBOX_EVENT_TYPE,
	OUTBOX_LOCK_TIMEOUT_MS
} from '@/messaging/messaging.constants';
import { assertMessagingEventContract } from '@/messaging/messaging-event-contract';
import { parseMessagingHeartbeatMetadata } from '@/messaging/messaging-heartbeat.service';
import { createMessagingHeaders } from '@/messaging/messaging-context';
import {
	NotificationDeliveryClientService,
	NotificationDeliveryFailureView,
	NotificationDeliveryInternalApiError
} from '@/messaging/notification-delivery-client.service';
import { RabbitMqManagementService } from '@/messaging/rabbitmq-management.service';
import { PrismaService } from '@/prisma.service';
import {
	isDatabaseBackupJobType,
	SCHEDULED_JOB_TYPES
} from '@/scheduled-jobs/scheduled-jobs.types';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	IntegrationDeliveryFailure,
	IntegrationDeliveryReceiptStatus,
	IntegrationErrorCategory,
	IntegrationFailureResolution,
	OutboxEventStatus,
	Prisma
} from '@prisma/client';
import { Request } from 'express';
import { randomUUID } from 'node:crypto';

interface FailureFilters {
	integration?: string;
	category?: string;
	status?: string;
}

@Injectable()
export class MessagingAdminService {
	private readonly logger = new Logger(MessagingAdminService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly rabbitManagement: RabbitMqManagementService,
		private readonly leadDestination: LeadIntegrationDestinationService,
		private readonly adminEventLog: AdminEventLogService,
		private readonly notificationDelivery: NotificationDeliveryClientService
	) {}

	async getOverview() {
		const now = new Date();
		const staleBefore = new Date(now.getTime() - 30_000);
		const expiredPublishingBefore = new Date(
			now.getTime() - OUTBOX_LOCK_TIMEOUT_MS
		);
		const [
			outboxGroups,
			oldestDuePending,
			oldestExpiredPublishing,
			unresolvedFailures,
			retryingFailures,
			deliveredLast24Hours,
			completedBackupsLast24Hours,
			heartbeats,
			queues,
			notificationDeliveryOverview
		] = await Promise.all([
			this.prisma.outboxEvent.groupBy({
				by: ['status'],
				_count: { _all: true }
			}),
			this.prisma.outboxEvent.findFirst({
				where: {
					status: OutboxEventStatus.PENDING,
					availableAt: { lte: now }
				},
				orderBy: { availableAt: 'asc' },
				select: { availableAt: true }
			}),
			this.prisma.outboxEvent.findFirst({
				where: {
					status: OutboxEventStatus.PUBLISHING,
					lockedAt: { lte: expiredPublishingBefore }
				},
				orderBy: { lockedAt: 'asc' },
				select: { lockedAt: true }
			}),
			this.prisma.integrationDeliveryFailure.count({
				where: {
					resolvedAt: null,
					integration: {
						notIn: [...NOTIFICATION_DELIVERY_KINDS]
					}
				}
			}),
			this.prisma.integrationDeliveryFailure.count({
				where: {
					resolvedAt: null,
					retryingAt: { not: null },
					integration: {
						notIn: [...NOTIFICATION_DELIVERY_KINDS]
					}
				}
			}),
			this.prisma.integrationDeliveryReceipt.count({
				where: {
					status: IntegrationDeliveryReceiptStatus.DELIVERED,
					integration: {
						notIn: [...NOTIFICATION_DELIVERY_KINDS]
					},
					deliveredAt: {
						gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
					}
				}
			}),
			this.prisma.scheduledJobRun.count({
				where: {
					jobType: 'DATABASE_BACKUP',
					status: 'SUCCEEDED',
					finishedAt: {
						gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
					}
				}
			}),
			this.prisma.messagingHeartbeat.findMany({
				orderBy: { lastSeenAt: 'desc' }
			}),
			this.rabbitManagement
				.getMessagingQueues()
				.then(queues => ({ queues, error: null }))
				.catch(error => ({
					queues: [],
					error:
						error instanceof Error ? error.message : 'RabbitMQ недоступен'
				})),
			this.notificationDelivery
				.getOverview()
				.then(overview => ({ overview, error: null }))
				.catch(error => ({
					overview: null,
					error:
						error instanceof Error
							? error.message
							: 'Notification Delivery недоступен'
				}))
		]);

		const outbox = Object.fromEntries(
			Object.values(OutboxEventStatus).map(status => [status, 0])
		) as Record<OutboxEventStatus, number>;
		for (const group of outboxGroups) {
			outbox[group.status] = group._count._all;
		}
		if (notificationDeliveryOverview.overview) {
			for (const status of Object.values(OutboxEventStatus)) {
				outbox[status] +=
					notificationDeliveryOverview.overview.outbox[status] || 0;
			}
		}

		const oldestPendingAt =
			[
				oldestDuePending?.availableAt.toISOString() || null,
				oldestExpiredPublishing?.lockedAt
					? new Date(
							oldestExpiredPublishing.lockedAt.getTime() +
								OUTBOX_LOCK_TIMEOUT_MS
						).toISOString()
					: null,
				notificationDeliveryOverview.overview?.oldestPendingAt || null
			]
				.filter((value): value is string => Boolean(value))
				.sort()[0] || null;

		const serviceHeartbeats = [
			'outbox-publisher',
			'integration-worker',
			'maintenance-worker'
		].map(service => {
			const instances = heartbeats.filter(
				item => item.service === service
			);
			const latest = instances[0]?.lastSeenAt || null;
			const activity = instances.reduce(
				(result, instance) => {
					const metadata = parseMessagingHeartbeatMetadata(
						instance.metadata
					);
					for (const key of [
						'lastSuccessfulPollAt',
						'lastSuccessfulPublishAt',
						'lastSuccessfulConsumeAt'
					] as const) {
						const value = metadata[key];
						if (
							value &&
							(!result[key] ||
								Date.parse(value) > Date.parse(result[key] as string))
						) {
							result[key] = value;
						}
					}
					return result;
				},
				{} as {
					lastSuccessfulPollAt?: string;
					lastSuccessfulPublishAt?: string;
					lastSuccessfulConsumeAt?: string;
				}
			);
			return {
				service,
				status: latest && latest >= staleBefore ? 'ok' : 'down',
				activeInstances: instances.filter(
					item => item.lastSeenAt >= staleBefore
				).length,
				lastSeenAt: latest?.toISOString() || null,
				lastSuccessfulPollAt: activity.lastSuccessfulPollAt || null,
				lastSuccessfulPublishAt: activity.lastSuccessfulPublishAt || null,
				lastSuccessfulConsumeAt: activity.lastSuccessfulConsumeAt || null
			};
		});
		serviceHeartbeats.push(
			notificationDeliveryOverview.overview?.heartbeat || {
				service: 'notification-delivery-worker',
				status: 'down',
				activeInstances: 0,
				lastSeenAt: null,
				lastSuccessfulPollAt: null,
				lastSuccessfulPublishAt: null,
				lastSuccessfulConsumeAt: null
			}
		);

		return {
			generatedAt: new Date().toISOString(),
			outbox,
			oldestPendingAt,
			unresolvedFailures:
				unresolvedFailures +
				(notificationDeliveryOverview.overview?.unresolvedFailures || 0),
			retryingFailures:
				retryingFailures +
				(notificationDeliveryOverview.overview?.retryingFailures || 0),
			deliveredLast24Hours:
				deliveredLast24Hours +
				completedBackupsLast24Hours +
				(notificationDeliveryOverview.overview?.deliveredLast24Hours || 0),
			rabbitMqError: queues.error,
			notificationDeliveryError: notificationDeliveryOverview.error,
			heartbeats: serviceHeartbeats,
			queues: queues.queues.map(queue => ({
				name: queue.name,
				messages: queue.messages,
				ready: queue.messages_ready,
				unacknowledged: queue.messages_unacknowledged,
				consumers: queue.consumers,
				state: queue.state || null
			}))
		};
	}

	async getFailures(page = 1, limit = 20, filters: FailureFilters = {}) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const normalizedIntegration = filters.integration?.trim()
			? this.normalizeIntegration(filters.integration.trim())
			: null;
		const queryNotificationDelivery =
			!normalizedIntegration ||
			this.isNotificationDeliveryKind(normalizedIntegration);
		const queryLegacy =
			!normalizedIntegration ||
			!this.isNotificationDeliveryKind(normalizedIntegration);
		const offset = (normalizedPage - 1) * normalizedLimit;
		const windowSize = offset + normalizedLimit;
		if (!Number.isSafeInteger(windowSize) || windowSize > 10_000) {
			throw new BadRequestException(
				'Слишком глубокая страница истории ошибок'
			);
		}
		const where = queryLegacy
			? this.getFailureWhere(filters, !normalizedIntegration)
			: null;
		const [legacyResult, notificationResult] = await Promise.all([
			where
				? this.prisma.$transaction([
						this.prisma.integrationDeliveryFailure.findMany({
							where,
							orderBy: [{ failedAt: 'desc' }, { id: 'desc' }],
							take: windowSize
						}),
						this.prisma.integrationDeliveryFailure.count({ where })
					])
				: Promise.resolve([[], 0] as const),
			queryNotificationDelivery
				? this.notificationDelivery.getFailures(1, windowSize, filters)
				: Promise.resolve({
						items: [],
						total: 0,
						page: 1,
						limit: windowSize,
						totalPages: 1
					})
		]);
		const legacyItems = legacyResult[0].map(item =>
			this.serializeFailure(item)
		);
		const items = [...legacyItems, ...notificationResult.items]
			.sort((left, right) => {
				const byDate =
					Date.parse(right.failedAt) - Date.parse(left.failedAt);
				return byDate || right.id.localeCompare(left.id);
			})
			.slice(offset, offset + normalizedLimit);
		const total = legacyResult[1] + notificationResult.total;

		return {
			items,
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async retryFailure(id: string, adminId: string, request?: Request) {
		const notificationDeliveryResult =
			await this.retryNotificationDeliveryFailure(id, adminId, request);
		if (notificationDeliveryResult) {
			return notificationDeliveryResult;
		}

		const staleRetryBefore = new Date(Date.now() - 5 * 60 * 1000);
		const retryingAt = new Date();
		const result = await this.prisma.$transaction(async transaction => {
			const failure =
				await transaction.integrationDeliveryFailure.findUnique({
					where: { id }
				});
			if (!failure) {
				throw new NotFoundException('Ошибка доставки не найдена');
			}
			if (failure.resolvedAt) {
				throw new ConflictException('Ошибка уже обработана');
			}

			const kind = this.normalizeIntegration(failure.integration);
			if (
				LEAD_INTEGRATION_KINDS.includes(
					kind as (typeof LEAD_INTEGRATION_KINDS)[number]
				) &&
				!this.isLeadEventV2(failure.payload)
			) {
				throw new ConflictException(
					'Повтор устаревшего события интеграции недоступен'
				);
			}
			const retryPayload: Prisma.JsonValue = failure.payload;
			const retryEventType = this.getFailureEventType(retryPayload);
			try {
				assertMessagingEventContract(retryPayload, {
					eventType: retryEventType,
					routingKey: getManualRetryRoutingKey(kind),
					messageId: failure.eventId,
					kind
				});
			} catch {
				throw new ConflictException(
					'Повтор события с некорректным контрактом недоступен'
				);
			}
			const retryToken = kind === 'database-backup' ? null : randomUUID();
			const scheduledJob = this.getScheduledJobReference(
				kind,
				failure.eventId,
				retryPayload
			);
			const claimed =
				await transaction.integrationDeliveryFailure.updateMany({
					where: {
						id,
						resolvedAt: null,
						OR: [
							{ retryingAt: null },
							{ retryingAt: { lt: staleRetryBefore } }
						]
					},
					data: {
						retryingAt,
						activeRetryToken: retryToken
					}
				});

			if (claimed.count !== 1) {
				throw new ConflictException('Повторная отправка уже выполняется');
			}

			if (
				failure.category === IntegrationErrorCategory.AUTH_CONFIGURATION &&
				this.isLeadEventV2(retryPayload)
			) {
				try {
					await this.leadDestination.refreshSnapshotFromCurrentConfig(
						failure.eventId,
						retryPayload as unknown as LeadIntegrationEventPayloadV2,
						transaction
					);
				} catch (error) {
					throw new ConflictException(
						error instanceof Error &&
							error.message.includes('target has changed')
							? 'Адрес назначения изменился. Закройте старую ошибку без повтора'
							: 'Не удалось обновить настройки интеграции для повтора'
					);
				}
			}

			if (scheduledJob) {
				await this.reopenScheduledJob(
					transaction,
					scheduledJob.id,
					scheduledJob.jobType
				);
			}

			if (retryToken) {
				await this.scheduleManualRetryReceipt(
					transaction,
					failure.eventId,
					kind,
					retryingAt,
					staleRetryBefore,
					retryToken
				);
			}
			await transaction.outboxEvent.create({
				data: {
					messageId: failure.eventId,
					eventType: retryEventType,
					routingKey: getManualRetryRoutingKey(kind),
					payload: retryPayload as Prisma.InputJsonValue,
					headers: createMessagingHeaders({
						messageId: failure.eventId,
						causationId: failure.eventId,
						...(retryToken
							? {
									headers: {
										'x-retry-attempt': 0,
										'x-delivery-token': retryToken
									}
								}
							: {})
					})
				}
			});
			await this.adminEventLog.recordInTransaction(transaction, {
				adminId,
				section: 'MESSAGING',
				action: 'MESSAGING_FAILURE_RETRY',
				description: `Повторно отправлено событие интеграции ${kind}`,
				entityType: 'integration_delivery_failure',
				entityId: failure.id,
				entityLabel: kind,
				metadata: {
					eventId: failure.eventId,
					integration: kind
				},
				request
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

	async closeFailure(
		id: string,
		adminId: string,
		comment: string,
		request?: Request
	) {
		const normalizedComment = comment.trim();
		if (normalizedComment.length < 3 || normalizedComment.length > 1000) {
			throw new BadRequestException(
				'Комментарий должен содержать от 3 до 1000 символов'
			);
		}

		const notificationDeliveryResult =
			await this.closeNotificationDeliveryFailure(
				id,
				adminId,
				normalizedComment,
				request
			);
		if (notificationDeliveryResult) {
			return notificationDeliveryResult;
		}

		const resolvedAt = new Date();
		return this.prisma.$transaction(async transaction => {
			await transaction.$queryRaw(
				Prisma.sql`
					SELECT "id"
					FROM "integration_delivery_failures"
					WHERE "id" = ${id}::uuid
					FOR UPDATE
				`
			);
			const failure =
				await transaction.integrationDeliveryFailure.findUnique({
					where: { id }
				});
			if (!failure) {
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

			const kind = this.normalizeIntegration(failure.integration);
			if (kind !== 'database-backup') {
				await this.createClosedReceipt(
					transaction,
					failure.eventId,
					kind,
					resolvedAt
				);
			}
			const closed =
				await transaction.integrationDeliveryFailure.updateMany({
					where: {
						id,
						resolvedAt: null,
						retryingAt: null
					},
					data: {
						resolvedAt,
						resolution: IntegrationFailureResolution.CLOSED_NO_RETRY,
						resolutionComment: normalizedComment,
						resolvedById: adminId,
						activeRetryToken: null
					}
				});
			if (closed.count !== 1) {
				throw new ConflictException(
					'Ошибка уже обрабатывается или была закрыта'
				);
			}

			await transaction.integrationCredentialSnapshot.deleteMany({
				where: {
					eventId: failure.eventId,
					integration: failure.integration
				}
			});
			await this.adminEventLog.recordInTransaction(transaction, {
				adminId,
				section: 'MESSAGING',
				action: 'MESSAGING_FAILURE_CLOSE_WITHOUT_RETRY',
				description: `Закрыта без повтора ошибка интеграции ${failure.integration}`,
				entityType: 'integration_delivery_failure',
				entityId: failure.id,
				entityLabel: failure.integration,
				metadata: {
					eventId: failure.eventId,
					integration: failure.integration,
					comment: normalizedComment
				},
				request
			});
			return {
				id: failure.id,
				eventId: failure.eventId,
				integration: failure.integration,
				resolvedAt: resolvedAt.toISOString(),
				resolution: IntegrationFailureResolution.CLOSED_NO_RETRY,
				resolutionComment: normalizedComment
			};
		});
	}

	private async scheduleManualRetryReceipt(
		transaction: Prisma.TransactionClient,
		eventId: string,
		integration: MessagingKind,
		availableAt: Date,
		staleRetryBefore: Date,
		retryToken: string
	): Promise<void> {
		const rows = await transaction.$queryRaw<Array<{ id: string }>>(
			Prisma.sql`
				INSERT INTO "integration_delivery_receipts" (
					"id",
					"event_id",
					"integration",
					"status",
					"locked_at",
					"delivered_at",
					"retry_attempt",
					"retry_available_at",
					"retry_token",
					"created_at"
				)
				VALUES (
					${randomUUID()}::uuid,
					${eventId}::uuid,
					${integration},
					'RETRY_SCHEDULED'::"IntegrationDeliveryReceiptStatus",
					${availableAt},
					NULL,
					0,
					${availableAt},
					${retryToken}::uuid,
					NOW()
				)
				ON CONFLICT ("event_id", "integration") DO UPDATE
				SET
					"status" = 'RETRY_SCHEDULED'::"IntegrationDeliveryReceiptStatus",
					"locked_at" = ${availableAt},
					"delivered_at" = NULL,
					"retry_attempt" = 0,
					"retry_available_at" = ${availableAt},
					"retry_token" = ${retryToken}::uuid
				WHERE
					"integration_delivery_receipts"."status" =
						'DEAD_LETTERED'::"IntegrationDeliveryReceiptStatus"
					OR (
						"integration_delivery_receipts"."status" =
							'RETRY_SCHEDULED'::"IntegrationDeliveryReceiptStatus"
						AND "integration_delivery_receipts"."retry_available_at" <
							${staleRetryBefore}
					)
				RETURNING "id"
			`
		);
		if (rows.length !== 1) {
			throw new ConflictException(
				'Событие уже доставляется или было обработано'
			);
		}
	}

	private async createClosedReceipt(
		transaction: Prisma.TransactionClient,
		eventId: string,
		integration: MessagingKind,
		resolvedAt: Date
	): Promise<void> {
		const rows = await transaction.$queryRaw<Array<{ id: string }>>(
			Prisma.sql`
				INSERT INTO "integration_delivery_receipts" (
					"id",
					"event_id",
					"integration",
					"status",
					"locked_at",
					"delivered_at",
					"retry_attempt",
					"retry_available_at",
					"retry_token",
					"created_at"
				)
				VALUES (
					${randomUUID()}::uuid,
					${eventId}::uuid,
					${integration},
					'CLOSED_NO_RETRY'::"IntegrationDeliveryReceiptStatus",
					${resolvedAt},
					NULL,
					NULL,
					NULL,
					NULL,
					NOW()
				)
				ON CONFLICT ("event_id", "integration") DO UPDATE
				SET
					"status" = 'CLOSED_NO_RETRY'::"IntegrationDeliveryReceiptStatus",
					"locked_at" = ${resolvedAt},
					"delivered_at" = NULL,
					"retry_attempt" = NULL,
					"retry_available_at" = NULL,
					"retry_token" = NULL
				WHERE "integration_delivery_receipts"."status" =
					'DEAD_LETTERED'::"IntegrationDeliveryReceiptStatus"
				RETURNING "id"
			`
		);
		if (rows.length !== 1) {
			const receipt =
				await transaction.integrationDeliveryReceipt.findUnique({
					where: {
						eventId_integration: { eventId, integration }
					},
					select: { status: true }
				});
			throw new ConflictException(
				receipt?.status === IntegrationDeliveryReceiptStatus.PROCESSING
					? 'Событие уже доставляется'
					: 'Событие уже запланировано или было обработано'
			);
		}
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
		return OUTBOX_EVENT_TYPE;
	}

	private getFailureWhere(
		filters: FailureFilters,
		excludeNotificationDelivery = false
	): Prisma.IntegrationDeliveryFailureWhereInput {
		const integration = filters.integration?.trim();
		const category = filters.category?.trim().toUpperCase();
		const status = filters.status?.trim().toUpperCase();
		const where: Prisma.IntegrationDeliveryFailureWhereInput = {};

		if (integration) {
			where.integration = this.normalizeIntegration(integration);
		} else if (excludeNotificationDelivery) {
			where.integration = {
				notIn: [...NOTIFICATION_DELIVERY_KINDS]
			};
		}
		if (category) {
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
		if (status === 'FAILED') {
			where.resolvedAt = null;
			where.retryingAt = null;
		} else if (status === 'RETRYING') {
			where.resolvedAt = null;
			where.retryingAt = { not: null };
		} else if (status === 'RESOLVED') {
			where.resolution = IntegrationFailureResolution.DELIVERED;
		} else if (status === 'CLOSED') {
			where.resolution = IntegrationFailureResolution.CLOSED_NO_RETRY;
		} else if (status && status !== 'ALL') {
			throw new BadRequestException('Некорректный статус ошибки доставки');
		}
		return where;
	}

	private getScheduledJobReference(
		kind: MessagingKind,
		eventId: string,
		payload: Prisma.JsonValue
	): { id: string; jobType: string } | null {
		if (kind !== 'daily-summary-telegram' && kind !== 'database-backup') {
			return null;
		}
		if (
			!payload ||
			typeof payload !== 'object' ||
			Array.isArray(payload) ||
			typeof payload.jobId !== 'string' ||
			payload.jobId !== eventId
		) {
			throw new BadRequestException(
				'Некорректное событие фонового задания'
			);
		}
		const jobType = payload.jobType;
		if (
			typeof jobType !== 'string' ||
			(kind === 'daily-summary-telegram' &&
				jobType !== SCHEDULED_JOB_TYPES.DAILY_TELEGRAM_SUMMARY) ||
			(kind === 'database-backup' && !isDatabaseBackupJobType(jobType))
		) {
			throw new BadRequestException('Некорректный тип фонового задания');
		}
		return { id: payload.jobId, jobType };
	}

	private async reopenScheduledJob(
		transaction: Prisma.TransactionClient,
		jobId: string,
		jobType: string
	): Promise<void> {
		const reopened = await transaction.scheduledJobRun.updateMany({
			where: {
				id: jobId,
				jobType,
				status: 'FAILED'
			},
			data: {
				status: 'QUEUED',
				maxAttempts: { increment: 4 },
				availableAt: new Date(),
				finishedAt: null,
				result: Prisma.DbNull,
				lastError: null,
				leaseOwner: null,
				leaseToken: null,
				leaseExpiresAt: null
			}
		});
		if (reopened.count !== 1) {
			throw new ConflictException(
				'Фоновое задание уже перезапущено или обработано'
			);
		}
	}

	private isLeadEventV2(payload: Prisma.JsonValue): boolean {
		return (
			Boolean(payload) &&
			typeof payload === 'object' &&
			!Array.isArray(payload) &&
			payload.schemaVersion === 2 &&
			payload.eventType === OUTBOX_EVENT_TYPE &&
			typeof payload.integration === 'string' &&
			Boolean(payload.destination)
		);
	}

	private normalizeIntegration(value: string): MessagingKind {
		if (!MESSAGING_KINDS.includes(value as MessagingKind)) {
			throw new BadRequestException('Некорректный тип интеграции');
		}
		return value as MessagingKind;
	}

	private isNotificationDeliveryKind(
		value: MessagingKind
	): value is NotificationDeliveryKind {
		return NOTIFICATION_DELIVERY_KINDS.includes(
			value as NotificationDeliveryKind
		);
	}

	private async retryNotificationDeliveryFailure(
		id: string,
		adminId: string,
		request?: Request
	) {
		if (await this.isLegacyFailure(id)) return null;
		let result: Awaited<
			ReturnType<NotificationDeliveryClientService['retryFailure']>
		>;
		try {
			result = await this.notificationDelivery.retryFailure(id, adminId);
		} catch (error) {
			this.rethrowNotificationDeliveryError(error);
		}
		await this.recordNotificationDeliveryAuditBestEffort(
			{
				adminId,
				section: 'MESSAGING',
				action: 'MESSAGING_FAILURE_RETRY',
				description: `Повторно отправлено событие Notification Delivery ${result.integration}`,
				entityType: 'notification_delivery_failure',
				entityId: result.id,
				entityLabel: result.integration,
				metadata: {
					eventId: result.eventId,
					integration: result.integration
				},
				request
			},
			{
				action: 'RETRY',
				adminId,
				failureId: result.id,
				eventId: result.eventId,
				integration: result.integration
			}
		);
		return result;
	}

	private async closeNotificationDeliveryFailure(
		id: string,
		adminId: string,
		comment: string,
		request?: Request
	) {
		if (await this.isLegacyFailure(id)) return null;
		let result: Awaited<
			ReturnType<NotificationDeliveryClientService['closeFailure']>
		>;
		try {
			result = await this.notificationDelivery.closeFailure(
				id,
				adminId,
				comment
			);
		} catch (error) {
			this.rethrowNotificationDeliveryError(error);
		}
		await this.recordNotificationDeliveryAuditBestEffort(
			{
				adminId,
				section: 'MESSAGING',
				action: 'MESSAGING_FAILURE_CLOSE_WITHOUT_RETRY',
				description: `Закрыта без повтора ошибка Notification Delivery ${result.integration}`,
				entityType: 'notification_delivery_failure',
				entityId: result.id,
				entityLabel: result.integration,
				metadata: {
					eventId: result.eventId,
					integration: result.integration,
					comment
				},
				request
			},
			{
				action: 'CLOSE',
				adminId,
				failureId: result.id,
				eventId: result.eventId,
				integration: result.integration
			}
		);
		return result;
	}

	private async recordNotificationDeliveryAuditBestEffort(
		entry: Parameters<AdminEventLogService['record']>[0],
		context: {
			action: 'RETRY' | 'CLOSE';
			adminId: string;
			failureId: string;
			eventId: string;
			integration: string;
		}
	): Promise<void> {
		try {
			await this.adminEventLog.record(entry);
		} catch (error) {
			this.logger.error(
				JSON.stringify({
					event: 'notification_delivery.global_audit_failed',
					...context,
					error:
						error instanceof Error
							? error.message.slice(0, 1000)
							: String(error).slice(0, 1000)
				})
			);
		}
	}

	private async isLegacyFailure(id: string): Promise<boolean> {
		const failure = await this.prisma.integrationDeliveryFailure.findFirst(
			{
				where: {
					id,
					integration: {
						notIn: [...NOTIFICATION_DELIVERY_KINDS]
					}
				},
				select: { id: true }
			}
		);
		return Boolean(failure);
	}

	private rethrowNotificationDeliveryError(error: unknown): never {
		if (!(error instanceof NotificationDeliveryInternalApiError)) {
			throw error;
		}
		if (error.statusCode === 400) {
			throw new BadRequestException(error.message);
		}
		if (error.statusCode === 404) {
			throw new NotFoundException(error.message);
		}
		if (error.statusCode === 409) {
			throw new ConflictException(error.message);
		}
		throw new ServiceUnavailableException(
			'Notification Delivery не выполнил операцию'
		);
	}

	private serializeFailure(
		item: IntegrationDeliveryFailure
	): NotificationDeliveryFailureView {
		const payload = item.payload as unknown as LeadIntegrationEventPayload;
		const jobPayload = item.payload as {
			jobId?: string;
			jobType?: string;
		};
		const scheduledJobName =
			jobPayload.jobType === SCHEDULED_JOB_TYPES.DAILY_TELEGRAM_SUMMARY
				? 'Ежедневная Telegram-сводка'
				: jobPayload.jobType === SCHEDULED_JOB_TYPES.DATABASE_BACKUP
					? 'Backup PostgreSQL'
					: jobPayload.jobType ===
						  SCHEDULED_JOB_TYPES.NOTIFICATION_DELIVERY_DATABASE_BACKUP
						? 'Backup PostgreSQL Notification Delivery'
						: null;
		const scheduledJobEntity = scheduledJobName
			? {
					id: jobPayload.jobId || item.eventId,
					name: scheduledJobName
				}
			: null;
		return {
			id: item.id,
			eventId: item.eventId,
			integration: item.integration,
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
			source: payload.source,
			entity: scheduledJobEntity || payload.entity,
			lead: {
				id: payload.lead?.id || null,
				contact: payload.lead?.contact || null,
				phone: payload.lead?.phone || null,
				email: payload.lead?.email || null,
				url: payload.lead?.url || null,
				createdAt: payload.lead?.createdAt || null
			}
		};
	}
}
