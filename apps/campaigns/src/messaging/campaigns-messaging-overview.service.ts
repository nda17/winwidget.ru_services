import { CampaignsPrismaService } from '../prisma/campaigns-prisma.service';
import { Injectable } from '@nestjs/common';
import {
	CampaignConsumerReceiptStatus,
	CampaignOutboxStatus,
	Prisma
} from '@prisma/campaigns-client';

const HEARTBEAT_FRESHNESS_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const INVALID_OUTBOX_CONTRACT_PREFIX = 'INVALID_OUTBOX_CONTRACT:';

export const CAMPAIGNS_MESSAGING_HEARTBEAT_SERVICES = [
	'campaigns-api',
	'campaigns-worker',
	'campaigns-outbox-publisher'
] as const;

const HEARTBEAT_DEFINITIONS = [
	{
		service: CAMPAIGNS_MESSAGING_HEARTBEAT_SERVICES[0],
		roles: ['all', 'api']
	},
	{
		service: CAMPAIGNS_MESSAGING_HEARTBEAT_SERVICES[1],
		roles: ['all', 'worker']
	},
	{
		service: CAMPAIGNS_MESSAGING_HEARTBEAT_SERVICES[2],
		roles: ['all', 'publisher']
	}
] as const;

@Injectable()
export class CampaignsMessagingOverviewService {
	constructor(private readonly prisma: CampaignsPrismaService) {}

	async getOverview() {
		const now = new Date();
		const staleBefore = new Date(now.getTime() - HEARTBEAT_FRESHNESS_MS);
		const [
			outboxGroups,
			invalidOutboxContracts,
			oldestDuePending,
			oldestExpiredPublishing,
			deadLetteredReceipts,
			retryScheduledReceipts,
			processedLast24Hours,
			heartbeats
		] = await Promise.all([
			this.prisma.campaignOutboxEvent.groupBy({
				by: ['status'],
				where: {
					status: {
						in: [
							CampaignOutboxStatus.PENDING,
							CampaignOutboxStatus.PUBLISHING,
							CampaignOutboxStatus.PUBLISHED
						]
					}
				},
				_count: { _all: true }
			}),
			this.prisma.campaignOutboxEvent.count({
				where: {
					status: CampaignOutboxStatus.CANCELLED,
					lastError: { startsWith: INVALID_OUTBOX_CONTRACT_PREFIX }
				}
			}),
			this.prisma.campaignOutboxEvent.findFirst({
				where: {
					status: CampaignOutboxStatus.PENDING,
					availableAt: { lte: now }
				},
				orderBy: { availableAt: 'asc' },
				select: { availableAt: true }
			}),
			this.prisma.campaignOutboxEvent.findFirst({
				where: {
					status: CampaignOutboxStatus.PUBLISHING,
					leaseExpiresAt: { lte: now }
				},
				orderBy: { leaseExpiresAt: 'asc' },
				select: { leaseExpiresAt: true }
			}),
			this.prisma.campaignConsumerReceipt.count({
				where: { status: CampaignConsumerReceiptStatus.DEAD_LETTERED }
			}),
			this.prisma.campaignConsumerReceipt.count({
				where: { status: CampaignConsumerReceiptStatus.RETRY_SCHEDULED }
			}),
			this.prisma.campaignConsumerReceipt.count({
				where: {
					status: CampaignConsumerReceiptStatus.DELIVERED,
					deliveredAt: { gte: new Date(now.getTime() - DAY_MS) }
				}
			}),
			this.prisma.campaignHeartbeat.findMany({
				orderBy: { lastSeenAt: 'desc' }
			})
		]);

		const outbox = {
			PENDING: 0,
			PUBLISHING: 0,
			PUBLISHED: 0,
			FAILED: invalidOutboxContracts
		};
		for (const group of outboxGroups) {
			if (group.status !== CampaignOutboxStatus.CANCELLED) {
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
			unresolvedFailures: deadLetteredReceipts,
			retryingFailures: retryScheduledReceipts,
			processedLast24Hours,
			heartbeats: HEARTBEAT_DEFINITIONS.map(definition => {
				const instances = heartbeats.filter(
					heartbeat =>
						definition.roles.some(role => role === heartbeat.role) &&
						this.isRunningHeartbeat(heartbeat.metadata)
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

	private isRunningHeartbeat(metadata: Prisma.JsonValue): boolean {
		return Boolean(
			metadata &&
			typeof metadata === 'object' &&
			!Array.isArray(metadata) &&
			metadata.status === 'running'
		);
	}
}
