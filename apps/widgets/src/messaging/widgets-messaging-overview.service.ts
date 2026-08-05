import { Injectable } from '@nestjs/common';
import {
	IntegrationDeliveryReceiptStatus,
	IntegrationErrorCategory,
	Prisma,
	WidgetsConsumerFailureStatus,
	WidgetsConsumerReceiptStatus,
	WidgetsOutboxStatus
} from '@prisma/widgets-client';
import { WidgetsPrismaService } from '../prisma/widgets-prisma.service';

const HEARTBEAT_FRESHNESS_MS = 30_000;
const OUTBOX_STALE_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const HEARTBEATS = [
	{ service: 'widgets-api', roles: ['all', 'api'] },
	{ service: 'widgets-worker', roles: ['all', 'worker'] },
	{ service: 'widgets-publisher', roles: ['all', 'publisher'] }
] as const;

@Injectable()
export class WidgetsMessagingOverviewService {
	constructor(private readonly prisma: WidgetsPrismaService) {}

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
			providerFailures,
			providerFailureGroups,
			projectionFailures,
			providerRetrying,
			projectionRetrying,
			providerDelivered,
			projectionDelivered,
			heartbeats,
			latestPublished,
			latestProviderDelivery,
			latestProjectionDelivery
		] = await Promise.all([
			this.prisma.widgetsOutboxEvent.groupBy({
				by: ['status'],
				_count: { _all: true }
			}),
			this.prisma.widgetsOutboxEvent.findFirst({
				where: {
					status: WidgetsOutboxStatus.PENDING,
					availableAt: { lte: nowDate }
				},
				orderBy: { availableAt: 'asc' },
				select: { availableAt: true }
			}),
			this.prisma.widgetsOutboxEvent.findFirst({
				where: {
					status: WidgetsOutboxStatus.PUBLISHING,
					leaseExpiresAt: { lte: nowDate }
				},
				orderBy: { leaseExpiresAt: 'asc' },
				select: { leaseExpiresAt: true }
			}),
			this.prisma.widgetsOutboxEvent.count({
				where: {
					OR: [
						{
							status: WidgetsOutboxStatus.PENDING,
							availableAt: { lt: staleOutboxBefore }
						},
						{
							status: WidgetsOutboxStatus.PUBLISHING,
							leaseExpiresAt: { lt: staleOutboxBefore }
						}
					]
				}
			}),
			this.prisma.widgetsOutboxEvent.count({
				where: {
					OR: [
						{
							status: WidgetsOutboxStatus.PENDING,
							availableAt: { lte: nowDate }
						},
						{
							status: WidgetsOutboxStatus.PUBLISHING,
							leaseExpiresAt: { lte: nowDate }
						}
					]
				}
			}),
			this.prisma.integrationDeliveryFailure.count({
				where: { resolvedAt: null }
			}),
			this.prisma.integrationDeliveryFailure.groupBy({
				by: ['category', 'normalizedCode'],
				where: { resolvedAt: null },
				_count: { _all: true }
			}),
			this.prisma.widgetsConsumerFailure.count({
				where: {
					status: {
						in: [
							WidgetsConsumerFailureStatus.OPEN,
							WidgetsConsumerFailureStatus.RETRY_REQUESTED
						]
					}
				}
			}),
			this.prisma.integrationDeliveryFailure.count({
				where: { resolvedAt: null, retryingAt: { not: null } }
			}),
			this.prisma.widgetsConsumerFailure.count({
				where: { status: WidgetsConsumerFailureStatus.RETRY_REQUESTED }
			}),
			this.prisma.integrationDeliveryReceipt.count({
				where: {
					status: IntegrationDeliveryReceiptStatus.DELIVERED,
					deliveredAt: { gte: new Date(now - DAY_MS) }
				}
			}),
			this.prisma.widgetsConsumerReceipt.count({
				where: {
					status: WidgetsConsumerReceiptStatus.DELIVERED,
					deliveredAt: { gte: new Date(now - DAY_MS) }
				}
			}),
			this.prisma.widgetsHeartbeat.findMany({
				orderBy: { lastSeenAt: 'desc' }
			}),
			this.prisma.widgetsOutboxEvent.findFirst({
				where: {
					status: WidgetsOutboxStatus.PUBLISHED,
					publishedAt: { not: null }
				},
				orderBy: { publishedAt: 'desc' },
				select: { publishedAt: true }
			}),
			this.prisma.integrationDeliveryReceipt.findFirst({
				where: {
					status: IntegrationDeliveryReceiptStatus.DELIVERED,
					deliveredAt: { not: null }
				},
				orderBy: { deliveredAt: 'desc' },
				select: { deliveredAt: true }
			}),
			this.prisma.widgetsConsumerReceipt.findFirst({
				where: {
					status: WidgetsConsumerReceiptStatus.DELIVERED,
					deliveredAt: { not: null }
				},
				orderBy: { deliveredAt: 'desc' },
				select: { deliveredAt: true }
			})
		]);

		const outbox = {
			PENDING: 0,
			PUBLISHING: 0,
			PUBLISHED: 0,
			FAILED: 0
		};
		for (const group of outboxGroups) {
			if (group.status === WidgetsOutboxStatus.QUARANTINED) {
				outbox.FAILED += group._count._all;
			} else {
				outbox[group.status] += group._count._all;
			}
		}

		const unresolvedFailuresByCategory = {
			TRANSIENT: 0,
			RATE_LIMIT: 0,
			PERMANENT: 0,
			AUTH_CONFIGURATION: 0,
			UNCLASSIFIED: projectionFailures
		} satisfies Record<IntegrationErrorCategory | 'UNCLASSIFIED', number>;
		for (const group of providerFailureGroups) {
			const category =
				group.normalizedCode === 'UNCLASSIFIED' || group.category === null
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
		const latestConsumeAt = this.latestDate([
			latestProviderDelivery?.deliveredAt,
			latestProjectionDelivery?.deliveredAt
		]);

		return {
			generatedAt: new Date(now).toISOString(),
			outbox,
			oldestPendingAt: oldestPendingAt?.toISOString() || null,
			operational: {
				staleOutbox,
				dueOutbox,
				unresolvedFailuresByCategory
			},
			unresolvedFailures: providerFailures + projectionFailures,
			retryingFailures: providerRetrying + projectionRetrying,
			deliveredLast24Hours: providerDelivered + projectionDelivered,
			heartbeats: HEARTBEATS.map(definition => {
				const instances = heartbeats.filter(
					heartbeat =>
						definition.roles.some(role => role === heartbeat.role) &&
						this.isRunningHeartbeat(heartbeat.metadata)
				);
				const activeInstances = instances.filter(
					heartbeat =>
						now - heartbeat.lastSeenAt.getTime() <= HEARTBEAT_FRESHNESS_MS
				).length;
				return {
					service: definition.service,
					status:
						activeInstances > 0 ? ('ok' as const) : ('down' as const),
					activeInstances,
					lastSeenAt: instances[0]?.lastSeenAt.toISOString() || null,
					...(definition.service === 'widgets-publisher'
						? {
								lastSuccessfulPublishAt:
									latestPublished?.publishedAt?.toISOString() || null
							}
						: {}),
					...(definition.service === 'widgets-worker'
						? {
								lastSuccessfulConsumeAt:
									latestConsumeAt?.toISOString() || null
							}
						: {})
				};
			})
		};
	}

	private latestDate(values: Array<Date | null | undefined>): Date | null {
		return (
			values
				.filter((value): value is Date => Boolean(value))
				.sort((left, right) => right.getTime() - left.getTime())[0] || null
		);
	}

	private isRunningHeartbeat(metadata: Prisma.JsonValue): boolean {
		return Boolean(
			metadata &&
			typeof metadata === 'object' &&
			!Array.isArray(metadata) &&
			metadata.status === 'running'
		);
	}
}
