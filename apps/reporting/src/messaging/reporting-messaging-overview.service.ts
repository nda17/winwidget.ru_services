import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import { Injectable } from '@nestjs/common';
import {
	Prisma,
	ReportingConsumerFailureStatus,
	ReportingConsumerReceiptStatus,
	ReportingOutboxStatus
} from '@prisma/reporting-client';

const HEARTBEAT_FRESHNESS_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const REPORTING_MESSAGING_HEARTBEAT_SERVICES = [
	'reporting-api',
	'reporting-worker',
	'reporting-outbox-publisher',
	'reporting-scheduler'
] as const;

const HEARTBEAT_DEFINITIONS = [
	{
		service: REPORTING_MESSAGING_HEARTBEAT_SERVICES[0],
		roles: ['all', 'api']
	},
	{
		service: REPORTING_MESSAGING_HEARTBEAT_SERVICES[1],
		roles: ['all', 'worker']
	},
	{
		service: REPORTING_MESSAGING_HEARTBEAT_SERVICES[2],
		roles: ['all', 'publisher']
	},
	{
		service: REPORTING_MESSAGING_HEARTBEAT_SERVICES[3],
		roles: ['all', 'scheduler'],
		requiresScheduler: true
	}
] as const;

@Injectable()
export class ReportingMessagingOverviewService {
	constructor(private readonly prisma: ReportingPrismaService) {}

	async getOverview() {
		const now = new Date();
		const staleBefore = new Date(now.getTime() - HEARTBEAT_FRESHNESS_MS);
		const [
			outboxGroups,
			oldestDuePending,
			oldestExpiredPublishing,
			unresolvedFailures,
			retryingFailures,
			processedLast24Hours,
			heartbeats
		] = await Promise.all([
			this.prisma.reportingOutboxEvent.groupBy({
				by: ['status'],
				_count: { _all: true }
			}),
			this.prisma.reportingOutboxEvent.findFirst({
				where: {
					status: ReportingOutboxStatus.PENDING,
					availableAt: { lte: now }
				},
				orderBy: { availableAt: 'asc' },
				select: { availableAt: true }
			}),
			this.prisma.reportingOutboxEvent.findFirst({
				where: {
					status: ReportingOutboxStatus.PUBLISHING,
					leaseExpiresAt: { lte: now }
				},
				orderBy: { leaseExpiresAt: 'asc' },
				select: { leaseExpiresAt: true }
			}),
			this.prisma.reportingConsumerFailure.count({
				where: { status: { not: ReportingConsumerFailureStatus.RESOLVED } }
			}),
			this.prisma.reportingConsumerFailure.count({
				where: { status: ReportingConsumerFailureStatus.RETRY_REQUESTED }
			}),
			this.prisma.consumerReceipt.count({
				where: {
					status: ReportingConsumerReceiptStatus.DELIVERED,
					deliveredAt: { gte: new Date(now.getTime() - DAY_MS) }
				}
			}),
			this.prisma.reportingHeartbeat.findMany({
				orderBy: { lastSeenAt: 'desc' }
			})
		]);

		const outbox = {
			PENDING: 0,
			PUBLISHING: 0,
			PUBLISHED: 0,
			FAILED: 0
		};
		for (const group of outboxGroups) {
			if (group.status === ReportingOutboxStatus.QUARANTINED) {
				outbox.FAILED = group._count._all;
			} else {
				outbox[group.status] = group._count._all;
			}
		}
		const oldestPendingAt = [
			oldestDuePending?.availableAt,
			oldestExpiredPublishing?.leaseExpiresAt
		]
			.filter((value): value is Date => Boolean(value))
			.sort((left, right) => left.getTime() - right.getTime())[0];

		return {
			schemaVersion: 1 as const,
			generatedAt: now.toISOString(),
			outbox,
			oldestPendingAt: oldestPendingAt?.toISOString() || null,
			unresolvedFailures,
			retryingFailures,
			processedLast24Hours,
			heartbeats: HEARTBEAT_DEFINITIONS.map(definition => {
				const instances = heartbeats.filter(
					heartbeat =>
						definition.roles.some(role => role === heartbeat.role) &&
						this.isRunningHeartbeat(
							heartbeat.metadata,
							'requiresScheduler' in definition &&
								definition.requiresScheduler
						)
				);
				const activeInstances = instances.filter(
					heartbeat => heartbeat.lastSeenAt >= staleBefore
				).length;
				return {
					service: definition.service,
					status:
						activeInstances > 0 ? ('ok' as const) : ('down' as const),
					activeInstances,
					lastSeenAt: instances[0]?.lastSeenAt.toISOString() || null
				};
			})
		};
	}

	private isRunningHeartbeat(
		metadata: Prisma.JsonValue,
		requiresScheduler: boolean
	): boolean {
		return Boolean(
			metadata &&
			typeof metadata === 'object' &&
			!Array.isArray(metadata) &&
			metadata.status === 'running' &&
			(!requiresScheduler || metadata.schedulerEnabled === true)
		);
	}
}
