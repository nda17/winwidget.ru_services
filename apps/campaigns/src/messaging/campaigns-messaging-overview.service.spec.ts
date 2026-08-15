import { CampaignsPrismaService } from '../prisma/campaigns-prisma.service';
import { CampaignsMessagingOverviewService } from './campaigns-messaging-overview.service';
import {
	CampaignConsumerReceiptStatus,
	CampaignOutboxStatus
} from '@prisma/campaigns-client';

describe('CampaignsMessagingOverviewService', () => {
	const now = new Date('2026-08-15T12:00:00.000Z');

	beforeEach(() => {
		jest.useFakeTimers().setSystemTime(now);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('aggregates only owned rows and maps exact invalid-contract cancellations to FAILED', async () => {
		const prisma = {
			campaignOutboxEvent: {
				groupBy: jest.fn().mockResolvedValue([
					{
						status: CampaignOutboxStatus.PENDING,
						_count: { _all: 1 }
					},
					{
						status: CampaignOutboxStatus.PUBLISHING,
						_count: { _all: 2 }
					},
					{
						status: CampaignOutboxStatus.PUBLISHED,
						_count: { _all: 3 }
					}
				]),
				count: jest.fn().mockResolvedValue(4),
				findFirst: jest
					.fn()
					.mockResolvedValueOnce({
						availableAt: new Date('2026-08-15T11:58:00.000Z')
					})
					.mockResolvedValueOnce({
						leaseExpiresAt: new Date('2026-08-15T11:57:00.000Z')
					})
			},
			campaignConsumerReceipt: {
				count: jest
					.fn()
					.mockResolvedValueOnce(5)
					.mockResolvedValueOnce(6)
					.mockResolvedValueOnce(7)
			},
			campaignHeartbeat: {
				findMany: jest.fn().mockResolvedValue([
					{
						role: 'api',
						metadata: { status: 'running' },
						lastSeenAt: new Date('2026-08-15T11:59:59.000Z')
					},
					{
						role: 'worker',
						metadata: { status: 'running' },
						lastSeenAt: new Date('2026-08-15T11:59:29.000Z')
					},
					{
						role: 'publisher',
						metadata: { status: 'stopped' },
						lastSeenAt: new Date('2026-08-15T11:59:59.000Z')
					}
				])
			}
		} as unknown as CampaignsPrismaService;
		const service = new CampaignsMessagingOverviewService(prisma);

		await expect(service.getOverview()).resolves.toEqual({
			schemaVersion: 1,
			generatedAt: now.toISOString(),
			outbox: { PENDING: 1, PUBLISHING: 2, PUBLISHED: 3, FAILED: 4 },
			oldestPendingAt: '2026-08-15T11:57:00.000Z',
			unresolvedFailures: 5,
			retryingFailures: 6,
			processedLast24Hours: 7,
			heartbeats: [
				{
					service: 'campaigns-api',
					status: 'ok',
					activeInstances: 1,
					lastSeenAt: '2026-08-15T11:59:59.000Z'
				},
				{
					service: 'campaigns-worker',
					status: 'down',
					activeInstances: 0,
					lastSeenAt: '2026-08-15T11:59:29.000Z'
				},
				{
					service: 'campaigns-outbox-publisher',
					status: 'down',
					activeInstances: 0,
					lastSeenAt: null
				}
			]
		});
		expect(prisma.campaignOutboxEvent.groupBy).toHaveBeenCalledWith({
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
		});
		expect(prisma.campaignOutboxEvent.count).toHaveBeenCalledWith({
			where: {
				status: CampaignOutboxStatus.CANCELLED,
				lastError: { startsWith: 'INVALID_OUTBOX_CONTRACT:' }
			}
		});
		expect(prisma.campaignConsumerReceipt.count).toHaveBeenNthCalledWith(
			1,
			{
				where: { status: CampaignConsumerReceiptStatus.DEAD_LETTERED }
			}
		);
		expect(prisma.campaignConsumerReceipt.count).toHaveBeenNthCalledWith(
			2,
			{
				where: { status: CampaignConsumerReceiptStatus.RETRY_SCHEDULED }
			}
		);
		expect(prisma.campaignConsumerReceipt.count).toHaveBeenNthCalledWith(
			3,
			{
				where: {
					status: CampaignConsumerReceiptStatus.DELIVERED,
					deliveredAt: { gte: new Date('2026-08-14T12:00:00.000Z') }
				}
			}
		);
	});
});
