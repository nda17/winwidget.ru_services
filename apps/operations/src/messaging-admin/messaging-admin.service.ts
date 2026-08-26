import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import {
	IntegrationDeliveryReceiptStatus,
	IntegrationErrorCategory,
	IntegrationFailureResolution,
	OutboxStatus,
	Prisma
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { AdminEventLogService } from '../admin-event-log/admin-event-log.service';
import {
	MessagingFailureSource,
	OperationsFederationClient,
	OperationsFederationHttpError
} from '../federation/operations-federation.client';
import { RabbitMqManagementClient } from '../federation/rabbitmq-management.client';
import { OperationsOutboxService } from '../messaging/operations-outbox.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { DATABASE_BACKUP_JOB_TYPES } from '../scheduled-jobs/scheduled-jobs.types';

interface FailureFilters {
	integration?: string;
	category?: string;
	status?: string;
}

interface ClientContext {
	ip: string | null;
	userAgent: string | null;
}

type FailureCoverage = 'complete' | 'unavailable' | 'not_queried';
type OutboxView = Record<
	'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED',
	number
>;

const FAILURE_SOURCES: MessagingFailureSource[] = [
	'notificationDelivery',
	'widgets',
	'billing',
	'identity'
];
const FAILURE_SOURCE_ERROR = 'Источник ошибок временно недоступен';
const STALE_RETRY_MS = 5 * 60_000;
const SOURCE_INTEGRATIONS: Record<
	MessagingFailureSource,
	readonly string[]
> = {
	notificationDelivery: [
		'email',
		'telegram',
		'payment-email',
		'payment-telegram',
		'limit-email',
		'limit-telegram',
		'campaign-email',
		'campaign-telegram',
		'subscription-expiry-email',
		'subscription-expiry-telegram',
		'daily-summary-delivery-telegram'
	],
	widgets: ['webhook', 'bitrix24', 'amo-crm'],
	billing: [
		'billing-identity-source',
		'billing-offer-source',
		'billing-notification-routing-source',
		'billing-trial-source',
		'billing-referral-source',
		'billing-lifecycle-repair-source',
		'auto-renewal',
		'notification-delivery-outcome'
	],
	identity: ['telegram-destination-unavailable']
};

@Injectable()
export class MessagingAdminService {
	private readonly logger = new Logger(MessagingAdminService.name);

	constructor(
		private readonly prisma: OperationsPrismaService,
		private readonly federation: OperationsFederationClient,
		private readonly rabbitManagement: RabbitMqManagementClient,
		private readonly outbox: OperationsOutboxService,
		private readonly adminEventLog: AdminEventLogService
	) {}

	async getOverview() {
		const now = new Date();
		const dayAgo = new Date(now.getTime() - 86_400_000);
		const staleBefore = new Date(now.getTime() - 30_000);
		const [
			outboxGroups,
			oldestPending,
			oldestExpiredClaim,
			unresolvedFailures,
			retryingFailures,
			processedLast24Hours,
			completedBackupsLast24Hours,
			heartbeats,
			remote,
			queues
		] = await Promise.all([
			this.prisma.outboxEvent.groupBy({
				by: ['status'],
				_count: { _all: true }
			}),
			this.prisma.outboxEvent.findFirst({
				where: { status: OutboxStatus.PENDING, availableAt: { lte: now } },
				orderBy: { availableAt: 'asc' },
				select: { availableAt: true }
			}),
			this.prisma.outboxEvent.findFirst({
				where: {
					status: OutboxStatus.PROCESSING,
					leaseExpiresAt: { lt: now }
				},
				orderBy: { leaseExpiresAt: 'asc' },
				select: { leaseExpiresAt: true }
			}),
			this.prisma.integrationDeliveryFailure.count({
				where: { resolvedAt: null }
			}),
			this.prisma.integrationDeliveryFailure.count({
				where: { resolvedAt: null, retryingAt: { not: null } }
			}),
			this.prisma.integrationDeliveryReceipt.count({
				where: {
					status: IntegrationDeliveryReceiptStatus.DELIVERED,
					deliveredAt: { gte: dayAgo }
				}
			}),
			this.prisma.scheduledJobRun.count({
				where: {
					jobType: { in: DATABASE_BACKUP_JOB_TYPES },
					status: 'SUCCEEDED',
					finishedAt: { gte: dayAgo }
				}
			}),
			this.prisma.messagingHeartbeat.findMany({
				orderBy: [{ service: 'asc' }, { lastSeenAt: 'desc' }]
			}),
			this.federation.getMessagingOverviews(),
			this.rabbitManagement
				.getMessagingQueues()
				.then(value => ({ value, error: null }))
				.catch(error => ({
					value: [],
					error: this.safeError(error, 'RabbitMQ недоступен')
				}))
		]);

		const outbox: OutboxView = {
			PENDING: 0,
			PUBLISHING: 0,
			PUBLISHED: 0,
			FAILED: 0
		};
		for (const group of outboxGroups) {
			if (group.status === OutboxStatus.PENDING)
				outbox.PENDING += group._count._all;
			if (group.status === OutboxStatus.PROCESSING)
				outbox.PUBLISHING += group._count._all;
			if (group.status === OutboxStatus.PUBLISHED)
				outbox.PUBLISHED += group._count._all;
		}

		const remoteErrors = new Map<string, string | null>();
		const remoteOldest: string[] = [];
		const remoteHeartbeats: unknown[] = [];
		let remoteUnresolved = 0;
		let remoteRetrying = 0;
		let remoteProcessed = 0;
		for (const entry of remote) {
			remoteErrors.set(entry.source, entry.error);
			if (!entry.value) continue;
			const overview = this.record(entry.value);
			this.mergeOutbox(outbox, overview.outbox);
			const oldest = this.isoOrNull(overview.oldestPendingAt);
			if (oldest) remoteOldest.push(oldest);
			remoteUnresolved += this.count(overview.unresolvedFailures);
			remoteRetrying += this.count(overview.retryingFailures);
			remoteProcessed += this.count(
				overview.deliveredLast24Hours ?? overview.processedLast24Hours
			);
			if (Array.isArray(overview.heartbeats)) {
				remoteHeartbeats.push(...overview.heartbeats);
			} else if (overview.heartbeat) {
				remoteHeartbeats.push(overview.heartbeat);
			}
		}

		const localHeartbeats = [
			...new Set(heartbeats.map(item => item.service))
		].map(service => {
			const rows = heartbeats.filter(item => item.service === service);
			const latest = rows[0]?.lastSeenAt || null;
			return {
				service,
				status: latest && latest >= staleBefore ? 'ok' : 'down',
				activeInstances: new Set(
					rows
						.filter(item => item.lastSeenAt >= staleBefore)
						.map(item => item.instanceId)
				).size,
				lastSeenAt: latest?.toISOString() || null
			};
		});
		for (const service of [
			'operations-api',
			'operations-worker',
			'operations-outbox-publisher'
		]) {
			if (!localHeartbeats.some(item => item.service === service)) {
				localHeartbeats.push({
					service,
					status: 'down',
					activeInstances: 0,
					lastSeenAt: null
				});
			}
		}

		const oldestPendingAt =
			[
				oldestPending?.availableAt.toISOString() || null,
				oldestExpiredClaim?.leaseExpiresAt?.toISOString() || null,
				...remoteOldest
			]
				.filter((value): value is string => Boolean(value))
				.sort()[0] || null;

		return {
			generatedAt: now.toISOString(),
			outbox,
			oldestPendingAt,
			unresolvedFailures: unresolvedFailures + remoteUnresolved,
			retryingFailures: retryingFailures + remoteRetrying,
			processedLast24Hours: processedLast24Hours + remoteProcessed,
			completedBackupsLast24Hours,
			rabbitMqError: queues.error,
			notificationDeliveryError:
				remoteErrors.get('notificationDelivery') || null,
			widgetsError: remoteErrors.get('widgets') || null,
			billingError: remoteErrors.get('billing') || null,
			identityError: remoteErrors.get('identity') || null,
			campaignsError: remoteErrors.get('campaigns') || null,
			reportingError: remoteErrors.get('reporting') || null,
			supportError: remoteErrors.get('support') || null,
			platformError: remoteErrors.get('platform') || null,
			heartbeats: [...localHeartbeats, ...remoteHeartbeats],
			queues: queues.value
		};
	}

	async getFailures(page = 1, limit = 20, filters: FailureFilters = {}) {
		const normalizedPage = this.positiveInteger(page, 1);
		const normalizedLimit = Math.min(this.positiveInteger(limit, 20), 100);
		const offset = (normalizedPage - 1) * normalizedLimit;
		const windowSize = offset + normalizedLimit;
		if (!Number.isSafeInteger(windowSize) || windowSize > 10_000) {
			throw new BadRequestException(
				'Слишком глубокая страница истории ошибок'
			);
		}
		const where = this.failureWhere(filters);
		const [localRows, localTotal, ...remote] = await Promise.all([
			this.prisma.integrationDeliveryFailure.findMany({
				where,
				orderBy: [{ failedAt: 'desc' }, { id: 'desc' }],
				take: windowSize
			}),
			this.prisma.integrationDeliveryFailure.count({ where }),
			...FAILURE_SOURCES.map(source => {
				if (
					filters.integration?.trim() &&
					!SOURCE_INTEGRATIONS[source].includes(filters.integration.trim())
				) {
					return Promise.resolve({
						source,
						value: { items: [], total: 0 },
						coverage: 'not_queried' as FailureCoverage,
						error: null as string | null
					});
				}
				return this.federation
					.getFailures(source, 1, windowSize, filters)
					.then(value => ({
						source,
						value,
						coverage: 'complete' as FailureCoverage,
						error: null as string | null
					}))
					.catch(() => ({
						source,
						value: { items: [], total: 0 },
						coverage: 'unavailable' as FailureCoverage,
						error: FAILURE_SOURCE_ERROR
					}));
			})
		]);
		const items = [
			...localRows.map(item => this.serializeLocalFailure(item)),
			...remote.flatMap(entry => entry.value.items)
		]
			.sort((left, right) => {
				const leftAt = this.failureTimestamp(left);
				const rightAt = this.failureTimestamp(right);
				return (
					rightAt - leftAt ||
					this.failureId(right).localeCompare(this.failureId(left))
				);
			})
			.slice(offset, offset + normalizedLimit);
		const total =
			localTotal +
			remote.reduce((sum, entry) => sum + entry.value.total, 0);
		const sourceErrors: Partial<
			Record<'operations' | MessagingFailureSource, string>
		> = {};
		const coverage: Record<
			'operations' | MessagingFailureSource,
			FailureCoverage
		> = {
			operations: 'complete',
			notificationDelivery: 'complete',
			widgets: 'complete',
			billing: 'complete',
			identity: 'complete'
		};
		for (const entry of remote) {
			coverage[entry.source] = entry.coverage;
			if (entry.error) sourceErrors[entry.source] = entry.error;
		}
		return {
			items,
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit)),
			sourceErrors,
			coverage
		};
	}

	async retryFailure(id: string, adminId: string, context: ClientContext) {
		const local = await this.prisma.integrationDeliveryFailure.findUnique({
			where: { id }
		});
		if (!local) return this.federatedAction('retry', id, adminId);
		const retryingAt = new Date();
		const retryToken = randomUUID();
		const publicationEventId = randomUUID();
		return this.prisma.$transaction(async transaction => {
			const current =
				await transaction.integrationDeliveryFailure.findUnique({
					where: { id }
				});
			if (!current)
				throw new NotFoundException('Ошибка доставки не найдена');
			if (current.resolvedAt)
				throw new ConflictException('Ошибка уже обработана');
			const staleBefore = new Date(Date.now() - STALE_RETRY_MS);
			const claimed =
				await transaction.integrationDeliveryFailure.updateMany({
					where: {
						id,
						resolvedAt: null,
						OR: [{ retryingAt: null }, { retryingAt: { lt: staleBefore } }]
					},
					data: { retryingAt, activeRetryToken: retryToken }
				});
			if (claimed.count !== 1) {
				throw new ConflictException('Повторная отправка уже выполняется');
			}
			await transaction.integrationDeliveryReceipt.upsert({
				where: {
					eventId_integration: {
						eventId: current.eventId,
						integration: current.integration
					}
				},
				create: {
					eventId: current.eventId,
					integration: current.integration,
					status: IntegrationDeliveryReceiptStatus.RETRY_SCHEDULED,
					retryAttempt: current.attempts + 1,
					retryAvailableAt: retryingAt,
					retryToken,
					lockedAt: retryingAt
				},
				update: {
					status: IntegrationDeliveryReceiptStatus.RETRY_SCHEDULED,
					retryAttempt: current.attempts + 1,
					retryAvailableAt: retryingAt,
					retryToken,
					lockedAt: retryingAt,
					deliveredAt: null
				}
			});
			await this.outbox.enqueue(transaction, {
				eventId: publicationEventId,
				messageId: current.eventId,
				deduplicationKey: `messaging-retry:${id}:${retryToken}`,
				eventType: current.eventType,
				aggregateType: 'integration-delivery-failure',
				aggregateId: id,
				routingKey: current.routingKey,
				payload: this.jsonObject(current.payload),
				headers: {
					'x-delivery-token': retryToken,
					'x-retry-attempt': current.attempts + 1,
					'x-causation-id': current.eventId
				}
			});
			await this.adminEventLog.recordInTransaction(transaction, {
				adminId,
				section: 'MESSAGING',
				action: 'MESSAGING_FAILURE_RETRY',
				description: `Повторно отправлено событие интеграции ${current.integration}`,
				entityType: 'integration_delivery_failure',
				entityId: current.id,
				entityLabel: current.integration,
				metadata: {
					eventId: current.eventId,
					integration: current.integration
				},
				...context
			});
			return {
				id: current.id,
				eventId: current.eventId,
				integration: current.integration,
				retryingAt: retryingAt.toISOString()
			};
		});
	}

	async closeFailure(
		id: string,
		adminId: string,
		comment: string,
		context: ClientContext
	) {
		const normalizedComment = comment.trim();
		if (normalizedComment.length < 3 || normalizedComment.length > 1_000) {
			throw new BadRequestException(
				'Комментарий должен содержать от 3 до 1000 символов'
			);
		}
		const local = await this.prisma.integrationDeliveryFailure.findUnique({
			where: { id }
		});
		if (!local) {
			return this.federatedAction('close', id, adminId, normalizedComment);
		}
		const resolvedAt = new Date();
		return this.prisma.$transaction(async transaction => {
			const current =
				await transaction.integrationDeliveryFailure.findUnique({
					where: { id }
				});
			if (!current)
				throw new NotFoundException('Ошибка доставки не найдена');
			if (current.resolvedAt)
				throw new ConflictException('Ошибка уже обработана');
			if (current.retryingAt) {
				throw new ConflictException(
					'Нельзя закрыть ошибку во время повторной отправки'
				);
			}
			const updated =
				await transaction.integrationDeliveryFailure.updateMany({
					where: { id, resolvedAt: null, retryingAt: null },
					data: {
						resolvedAt,
						resolution: IntegrationFailureResolution.CLOSED_NO_RETRY,
						resolutionComment: normalizedComment,
						resolvedById: adminId,
						activeRetryToken: null
					}
				});
			if (updated.count !== 1)
				throw new ConflictException('Ошибка уже обрабатывается');
			await transaction.integrationDeliveryReceipt.upsert({
				where: {
					eventId_integration: {
						eventId: current.eventId,
						integration: current.integration
					}
				},
				create: {
					eventId: current.eventId,
					integration: current.integration,
					status: IntegrationDeliveryReceiptStatus.CLOSED_NO_RETRY,
					lockedAt: resolvedAt
				},
				update: {
					status: IntegrationDeliveryReceiptStatus.CLOSED_NO_RETRY,
					retryAvailableAt: null,
					retryToken: null,
					deliveredAt: null,
					lockedAt: resolvedAt
				}
			});
			await this.adminEventLog.recordInTransaction(transaction, {
				adminId,
				section: 'MESSAGING',
				action: 'MESSAGING_FAILURE_CLOSE_WITHOUT_RETRY',
				description: `Закрыта без повтора ошибка интеграции ${current.integration}`,
				entityType: 'integration_delivery_failure',
				entityId: current.id,
				entityLabel: current.integration,
				metadata: {
					eventId: current.eventId,
					integration: current.integration,
					comment: normalizedComment
				},
				...context
			});
			return {
				id: current.id,
				eventId: current.eventId,
				integration: current.integration,
				resolvedAt: resolvedAt.toISOString(),
				resolution: IntegrationFailureResolution.CLOSED_NO_RETRY
			};
		});
	}

	private async federatedAction(
		action: 'retry' | 'close',
		id: string,
		adminId: string,
		comment?: string
	): Promise<unknown> {
		let unavailable: ServiceUnavailableException | null = null;
		for (const source of FAILURE_SOURCES) {
			try {
				return action === 'retry'
					? await this.federation.retryFailure(source, id, adminId)
					: await this.federation.closeFailure(
							source,
							id,
							adminId,
							comment || ''
						);
			} catch (error) {
				if (
					error instanceof OperationsFederationHttpError &&
					error.status === 404
				) {
					continue;
				}
				if (error instanceof ServiceUnavailableException) {
					unavailable ??= error;
					continue;
				}
				throw error;
			}
		}
		if (unavailable) throw unavailable;
		throw new NotFoundException('Ошибка доставки не найдена');
	}

	private failureWhere(
		filters: FailureFilters
	): Prisma.IntegrationDeliveryFailureWhereInput {
		const where: Prisma.IntegrationDeliveryFailureWhereInput = {};
		const integration = filters.integration?.trim();
		if (integration) where.integration = integration;
		const category = filters.category?.trim().toUpperCase();
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
		const status = filters.status?.trim().toUpperCase();
		if (!status || status === 'ALL') return where;
		if (status === 'OPEN' || status === 'UNRESOLVED')
			where.resolvedAt = null;
		else if (status === 'RETRYING') {
			where.resolvedAt = null;
			where.retryingAt = { not: null };
		} else if (status === 'RESOLVED' || status === 'CLOSED') {
			where.resolvedAt = { not: null };
		} else
			throw new BadRequestException('Некорректный статус ошибки доставки');
		return where;
	}

	private serializeLocalFailure(item: {
		id: string;
		eventId: string;
		integration: string;
		attempts: number;
		lastError: string;
		category: IntegrationErrorCategory | null;
		normalizedCode: string | null;
		safeReason: string | null;
		httpStatus: number | null;
		providerCode: string | null;
		retryable: boolean | null;
		failedAt: Date;
		retryingAt: Date | null;
		resolvedAt: Date | null;
		resolution: IntegrationFailureResolution | null;
		resolutionComment: string | null;
		resolvedById: string | null;
	}) {
		return {
			...item,
			failedAt: item.failedAt.toISOString(),
			retryingAt: item.retryingAt?.toISOString() || null,
			resolvedAt: item.resolvedAt?.toISOString() || null,
			status: item.resolvedAt
				? 'RESOLVED'
				: item.retryingAt
					? 'RETRYING'
					: 'OPEN',
			source: 'operations'
		};
	}

	private mergeOutbox(target: OutboxView, value: unknown): void {
		const source = this.record(value);
		target.PENDING += this.count(source.PENDING);
		target.PUBLISHING += this.count(
			source.PUBLISHING ?? source.PROCESSING
		);
		target.PUBLISHED += this.count(source.PUBLISHED);
		target.FAILED += this.count(source.FAILED);
	}

	private jsonObject(value: Prisma.JsonValue): Prisma.InputJsonObject {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new ConflictException(
				'Повтор события с некорректным контрактом недоступен'
			);
		}
		return value as Prisma.InputJsonObject;
	}

	private record(value: unknown): Record<string, unknown> {
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	}

	private count(value: unknown): number {
		return Number.isSafeInteger(value) && Number(value) >= 0
			? Number(value)
			: 0;
	}

	private positiveInteger(value: number, fallback: number): number {
		return Number.isSafeInteger(value) && value > 0 ? value : fallback;
	}

	private isoOrNull(value: unknown): string | null {
		if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
			return null;
		return new Date(value).toISOString();
	}

	private failureTimestamp(value: unknown): number {
		const record = this.record(value);
		const raw = record.failedAt ?? record.lastFailedAt;
		return typeof raw === 'string' && Number.isFinite(Date.parse(raw))
			? Date.parse(raw)
			: 0;
	}

	private failureId(value: unknown): string {
		const id = this.record(value).id;
		return typeof id === 'string' ? id : '';
	}

	private safeError(error: unknown, fallback: string): string {
		const value = error instanceof Error ? error.message : fallback;
		this.logger.warn(fallback);
		return value.replace(/[\r\n]+/g, ' ').slice(0, 500);
	}
}
