import { WidgetsMessagingOverviewService } from './widgets-messaging-overview.service';

describe('WidgetsMessagingOverviewService', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	it('reports service-owned outbox, failures and process heartbeats', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
		const prisma = {
			widgetsOutboxEvent: {
				groupBy: jest.fn().mockResolvedValue([
					{ status: 'PENDING', _count: { _all: 2 } },
					{ status: 'PUBLISHED', _count: { _all: 8 } },
					{ status: 'QUARANTINED', _count: { _all: 1 } }
				]),
				findFirst: jest
					.fn()
					.mockResolvedValueOnce({
						availableAt: new Date('2026-08-05T11:58:00.000Z')
					})
					.mockResolvedValueOnce({
						leaseExpiresAt: new Date('2026-08-05T11:59:00.000Z')
					})
					.mockResolvedValueOnce({
						publishedAt: new Date('2026-08-05T11:59:50.000Z')
					}),
				count: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1)
			},
			integrationDeliveryFailure: {
				count: jest.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(1),
				groupBy: jest.fn().mockResolvedValue([
					{
						category: 'TRANSIENT',
						normalizedCode: 'TIMEOUT',
						_count: { _all: 2 }
					},
					{
						category: null,
						normalizedCode: 'UNCLASSIFIED',
						_count: { _all: 1 }
					}
				])
			},
			widgetsConsumerFailure: {
				count: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1)
			},
			integrationDeliveryReceipt: {
				count: jest.fn().mockResolvedValue(4),
				findFirst: jest.fn().mockResolvedValue({
					deliveredAt: new Date('2026-08-05T11:59:45.000Z')
				})
			},
			widgetsConsumerReceipt: {
				count: jest.fn().mockResolvedValue(7),
				findFirst: jest.fn().mockResolvedValue({
					deliveredAt: new Date('2026-08-05T11:59:40.000Z')
				})
			},
			widgetsHeartbeat: {
				findMany: jest.fn().mockResolvedValue([
					{
						role: 'all',
						lastSeenAt: new Date('2026-08-05T11:59:55.000Z'),
						metadata: { status: 'running' }
					}
				])
			}
		};
		const service = new WidgetsMessagingOverviewService(prisma as never);

		await expect(service.getOverview()).resolves.toEqual(
			expect.objectContaining({
				outbox: {
					PENDING: 2,
					PUBLISHING: 0,
					PUBLISHED: 8,
					FAILED: 1
				},
				oldestPendingAt: '2026-08-05T11:58:00.000Z',
				operational: {
					staleOutbox: 2,
					dueOutbox: 1,
					unresolvedFailuresByCategory: {
						TRANSIENT: 2,
						RATE_LIMIT: 0,
						PERMANENT: 0,
						AUTH_CONFIGURATION: 0,
						UNCLASSIFIED: 3
					}
				},
				unresolvedFailures: 5,
				retryingFailures: 2,
				deliveredLast24Hours: 11,
				heartbeats: [
					expect.objectContaining({
						service: 'widgets-api',
						status: 'ok',
						activeInstances: 1
					}),
					expect.objectContaining({
						service: 'widgets-worker',
						lastSuccessfulConsumeAt: '2026-08-05T11:59:45.000Z'
					}),
					expect.objectContaining({
						service: 'widgets-publisher',
						lastSuccessfulPublishAt: '2026-08-05T11:59:50.000Z'
					})
				]
			})
		);
	});
});
