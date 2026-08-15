import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import { ReportingMessagingOverviewService } from './reporting-messaging-overview.service';
import {
	ReportingConsumerFailureStatus,
	ReportingConsumerReceiptStatus,
	ReportingOutboxStatus
} from '@prisma/reporting-client';

describe('ReportingMessagingOverviewService', () => {
	const now = new Date('2026-08-15T12:00:00.000Z');

	beforeEach(() => {
		jest.useFakeTimers().setSystemTime(now);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('maps Reporting quarantine, failures, receipts and role heartbeats', async () => {
		const prisma = {
			reportingOutboxEvent: {
				groupBy: jest.fn().mockResolvedValue([
					{
						status: ReportingOutboxStatus.PENDING,
						_count: { _all: 1 }
					},
					{
						status: ReportingOutboxStatus.PUBLISHING,
						_count: { _all: 2 }
					},
					{
						status: ReportingOutboxStatus.PUBLISHED,
						_count: { _all: 3 }
					},
					{
						status: ReportingOutboxStatus.QUARANTINED,
						_count: { _all: 4 }
					}
				]),
				findFirst: jest
					.fn()
					.mockResolvedValueOnce({
						availableAt: new Date('2026-08-15T11:58:00.000Z')
					})
					.mockResolvedValueOnce({
						leaseExpiresAt: new Date('2026-08-15T11:57:00.000Z')
					})
			},
			reportingConsumerFailure: {
				count: jest.fn().mockResolvedValueOnce(5).mockResolvedValueOnce(6)
			},
			consumerReceipt: {
				count: jest.fn().mockResolvedValue(7)
			},
			reportingHeartbeat: {
				findMany: jest.fn().mockResolvedValue([
					{
						role: 'api',
						metadata: { status: 'running', schedulerEnabled: false },
						lastSeenAt: new Date('2026-08-15T11:59:59.000Z')
					},
					{
						role: 'worker',
						metadata: { status: 'running', schedulerEnabled: false },
						lastSeenAt: new Date('2026-08-15T11:59:29.000Z')
					},
					{
						role: 'publisher',
						metadata: { status: 'running', schedulerEnabled: false },
						lastSeenAt: new Date('2026-08-15T11:59:59.000Z')
					},
					{
						role: 'scheduler',
						metadata: { status: 'running', schedulerEnabled: false },
						lastSeenAt: new Date('2026-08-15T11:59:59.000Z')
					}
				])
			}
		} as unknown as ReportingPrismaService;
		const service = new ReportingMessagingOverviewService(prisma);

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
					service: 'reporting-api',
					status: 'ok',
					activeInstances: 1,
					lastSeenAt: '2026-08-15T11:59:59.000Z'
				},
				{
					service: 'reporting-worker',
					status: 'down',
					activeInstances: 0,
					lastSeenAt: '2026-08-15T11:59:29.000Z'
				},
				{
					service: 'reporting-outbox-publisher',
					status: 'ok',
					activeInstances: 1,
					lastSeenAt: '2026-08-15T11:59:59.000Z'
				},
				{
					service: 'reporting-scheduler',
					status: 'down',
					activeInstances: 0,
					lastSeenAt: null
				}
			]
		});
		expect(prisma.reportingConsumerFailure.count).toHaveBeenNthCalledWith(
			1,
			{
				where: { status: { not: ReportingConsumerFailureStatus.RESOLVED } }
			}
		);
		expect(prisma.reportingConsumerFailure.count).toHaveBeenNthCalledWith(
			2,
			{
				where: { status: ReportingConsumerFailureStatus.RETRY_REQUESTED }
			}
		);
		expect(prisma.consumerReceipt.count).toHaveBeenCalledWith({
			where: {
				status: ReportingConsumerReceiptStatus.DELIVERED,
				deliveredAt: { gte: new Date('2026-08-14T12:00:00.000Z') }
			}
		});
	});
});
