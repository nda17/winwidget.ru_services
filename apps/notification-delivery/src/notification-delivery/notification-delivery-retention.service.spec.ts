import { NotificationDeliveryRetentionService } from './notification-delivery-retention.service';
import {
	NotificationDeliveryFailureResolution,
	NotificationDeliveryOutboxStatus,
	NotificationDeliveryReceiptStatus,
	Prisma
} from '@prisma/notification-delivery-client';

const DAY_MS = 24 * 60 * 60 * 1000;
const REDACTED_FAILURE_DETAIL = '[redacted after retention]';

describe('NotificationDeliveryRetentionService', () => {
	const createService = () => {
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			notificationDeliveryFailure: {
				findMany: jest.fn().mockResolvedValue([]),
				updateMany: jest.fn().mockResolvedValue({ count: 0 }),
				deleteMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			notificationDeliveryControlAction: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 }),
				deleteMany: jest.fn().mockResolvedValue({ count: 0 })
			}
		};
		const prisma = {
			notificationDeliveryOutboxEvent: {
				findMany: jest.fn().mockResolvedValue([]),
				findFirst: jest.fn().mockResolvedValue(null),
				deleteMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			notificationDeliveryReceipt: {
				findMany: jest.fn().mockResolvedValue([]),
				findFirst: jest.fn().mockResolvedValue(null),
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			notificationDeliveryFailure: {
				findFirst: jest.fn().mockResolvedValue(null)
			},
			notificationDeliveryHeartbeat: {
				deleteMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			$transaction: jest.fn(
				async (callback: (client: typeof transaction) => unknown) =>
					callback(transaction)
			)
		};
		const config = { get: jest.fn().mockReturnValue(undefined) };
		const service = new NotificationDeliveryRetentionService(
			prisma as any,
			config as any
		);

		return { service, prisma, transaction, config };
	};

	it('rejects runtime overrides of the fixed retention policy', () => {
		const { service, config } = createService();
		config.get.mockImplementation((key: string) =>
			key === 'NOTIFICATION_DELIVERY_RECEIPT_RETENTION_DAYS'
				? '91'
				: undefined
		);

		expect(() => service.onModuleInit()).toThrow(
			'NOTIFICATION_DELIVERY_RECEIPT_RETENTION_DAYS is fixed at 90 days'
		);
	});

	it('applies the fixed 7/90/30/365-day retention boundaries', async () => {
		const { service, prisma, transaction } = createService();
		const now = new Date('2026-08-30T12:00:00.000Z');

		await (service as any).cleanupCycle(now);

		expect(
			prisma.notificationDeliveryOutboxEvent.findMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					status: NotificationDeliveryOutboxStatus.PUBLISHED,
					publishedAt: {
						lt: new Date(now.getTime() - 7 * DAY_MS)
					}
				}
			})
		);
		expect(
			prisma.notificationDeliveryReceipt.findMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					status: NotificationDeliveryReceiptStatus.DELIVERED,
					deliveredAt: {
						lt: new Date(now.getTime() - 90 * DAY_MS)
					},
					detailsRedactedAt: null
				}
			})
		);
		expect(
			transaction.notificationDeliveryFailure.findMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					resolution: {
						in: [
							NotificationDeliveryFailureResolution.DELIVERED,
							NotificationDeliveryFailureResolution.CLOSED_NO_RETRY
						]
					},
					resolvedAt: {
						lt: new Date(now.getTime() - 30 * DAY_MS)
					},
					detailsRedactedAt: null
				})
			})
		);
		expect(transaction.$queryRaw).toHaveBeenCalledWith(
			expect.objectContaining({
				values: expect.arrayContaining([
					new Date(now.getTime() - 365 * DAY_MS),
					1000
				])
			})
		);
		expect(
			prisma.notificationDeliveryHeartbeat.deleteMany
		).toHaveBeenCalledWith({
			where: {
				lastSeenAt: { lt: new Date(now.getTime() - 7 * DAY_MS) }
			}
		});
	});

	it('redacts delivered receipt details but preserves the dedup tombstone', async () => {
		const { service, prisma } = createService();
		const deliveredBefore = new Date('2026-06-01T00:00:00.000Z');
		const redactedAt = new Date('2026-08-30T00:00:00.000Z');
		prisma.notificationDeliveryReceipt.findMany.mockResolvedValueOnce([
			{ id: 'receipt-1' }
		]);
		prisma.notificationDeliveryReceipt.updateMany.mockResolvedValueOnce({
			count: 1
		});

		await (service as any).redactDeliveredReceiptDetails(
			deliveredBefore,
			redactedAt
		);

		expect(
			prisma.notificationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith({
			where: {
				id: { in: ['receipt-1'] },
				status: NotificationDeliveryReceiptStatus.DELIVERED,
				deliveredAt: { lt: deliveredBefore },
				detailsRedactedAt: null
			},
			data: {
				checkpoint: Prisma.DbNull,
				detailsRedactedAt: redactedAt
			}
		});
		expect(prisma.notificationDeliveryReceipt).not.toHaveProperty(
			'deleteMany'
		);
	});

	it('redacts resolved failure details and comments without weakening resolution constraints', async () => {
		const { service, transaction } = createService();
		const resolvedBefore = new Date('2026-08-01T00:00:00.000Z');
		const redactedAt = new Date('2026-08-30T00:00:00.000Z');
		transaction.notificationDeliveryFailure.findMany.mockResolvedValueOnce(
			[{ id: 'delivered-failure' }, { id: 'closed-failure' }]
		);
		transaction.notificationDeliveryFailure.updateMany
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 1 });

		await (service as any).redactResolvedFailureDetails(
			resolvedBefore,
			redactedAt
		);

		expect(
			transaction.notificationDeliveryControlAction.updateMany
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					failureId: {
						in: ['delivered-failure', 'closed-failure']
					},
					comment: { not: null }
				}),
				data: { comment: REDACTED_FAILURE_DETAIL }
			})
		);
		const [deliveredUpdate, closedUpdate] =
			transaction.notificationDeliveryFailure.updateMany.mock.calls;
		expect(deliveredUpdate[0]).toEqual(
			expect.objectContaining({
				where: expect.objectContaining({
					resolution: NotificationDeliveryFailureResolution.DELIVERED
				}),
				data: expect.objectContaining({
					resolutionComment: null
				})
			})
		);
		expect(closedUpdate[0]).toEqual(
			expect.objectContaining({
				where: expect.objectContaining({
					resolution: NotificationDeliveryFailureResolution.CLOSED_NO_RETRY
				}),
				data: expect.objectContaining({
					payload: {},
					headers: {},
					lastError: REDACTED_FAILURE_DETAIL,
					safeReason: REDACTED_FAILURE_DETAIL,
					httpStatus: null,
					providerCode: null,
					resolutionComment: REDACTED_FAILURE_DETAIL,
					detailsRedactedAt: redactedAt
				})
			})
		);
	});

	it('deletes only terminal failures child-first under a locked CAS batch', async () => {
		const { service, transaction } = createService();
		const resolvedBefore = new Date('2025-08-30T00:00:00.000Z');
		const callOrder: string[] = [];
		transaction.$queryRaw.mockImplementationOnce(async () => {
			callOrder.push('lock');
			return [{ id: 'failure-1' }];
		});
		transaction.notificationDeliveryControlAction.deleteMany.mockImplementationOnce(
			async () => {
				callOrder.push('children');
				return { count: 2 };
			}
		);
		transaction.notificationDeliveryFailure.deleteMany.mockImplementationOnce(
			async () => {
				callOrder.push('parent');
				return { count: 1 };
			}
		);

		await (service as any).deleteResolvedFailures(resolvedBefore);

		expect(callOrder).toEqual(['lock', 'children', 'parent']);
		expect(
			transaction.notificationDeliveryFailure.deleteMany
		).toHaveBeenCalledWith({
			where: {
				id: { in: ['failure-1'] },
				resolution: {
					in: [
						NotificationDeliveryFailureResolution.DELIVERED,
						NotificationDeliveryFailureResolution.CLOSED_NO_RETRY
					]
				},
				resolvedAt: { lt: resolvedBefore }
			}
		});
	});

	it('aborts the child-first transaction if the parent CAS is lost', async () => {
		const { service, transaction } = createService();
		transaction.$queryRaw.mockResolvedValueOnce([{ id: 'failure-1' }]);
		transaction.notificationDeliveryFailure.deleteMany.mockResolvedValueOnce(
			{
				count: 0
			}
		);

		await expect(
			(service as any).deleteResolvedFailures(new Date())
		).rejects.toThrow('lost its retention claim');
	});

	it('continues a capped batch instead of declaring the initial cleanup ready', async () => {
		const { service, prisma } = createService();
		const fullBatch = Array.from({ length: 1000 }, (_, index) => ({
			id: `outbox-${index}`
		}));
		prisma.notificationDeliveryOutboxEvent.findMany.mockResolvedValue(
			fullBatch
		);
		prisma.notificationDeliveryOutboxEvent.deleteMany.mockResolvedValue({
			count: fullBatch.length
		});

		const result = await (service as any).deletePublishedOutbox(
			new Date()
		);

		expect(result).toEqual({ count: 20_000, hasMore: true });
		expect(
			prisma.notificationDeliveryOutboxEvent.findMany
		).toHaveBeenCalledTimes(20);
	});

	it('does not complete the initial cleanup while a skipped terminal row remains', async () => {
		const { service, prisma } = createService();
		prisma.notificationDeliveryFailure.findFirst.mockResolvedValueOnce({
			id: 'locked-failure'
		});

		const result = await (service as any).cleanupCycle(
			new Date('2026-08-30T00:00:00.000Z')
		);

		expect(result.hasMore).toBe(true);
	});

	it('keeps initial readiness sticky after the first complete cleanup', async () => {
		const { service } = createService();
		const schedule = jest
			.spyOn(service as any, 'schedule')
			.mockImplementation(() => undefined);
		const cleanupCycle = jest
			.spyOn(service as any, 'cleanupCycle')
			.mockResolvedValueOnce({
				hasMore: true,
				deletedOutbox: 20_000,
				redactedReceipts: 0,
				redactedFailures: 0,
				deletedFailures: 0,
				deletedHeartbeats: 0
			})
			.mockResolvedValueOnce({
				hasMore: false,
				deletedOutbox: 0,
				redactedReceipts: 0,
				redactedFailures: 0,
				deletedFailures: 0,
				deletedHeartbeats: 0
			})
			.mockRejectedValueOnce(
				new Error('database temporarily unavailable')
			);
		jest.spyOn((service as any).logger, 'log').mockImplementation();
		jest.spyOn((service as any).logger, 'error').mockImplementation();

		expect(service.isInitialCleanupReady()).toBe(false);
		await (service as any).runCleanup();
		expect(service.isInitialCleanupReady()).toBe(false);
		expect(schedule).toHaveBeenLastCalledWith(1000);

		await (service as any).runCleanup();
		expect(service.isInitialCleanupReady()).toBe(true);
		expect(schedule).toHaveBeenLastCalledWith(60 * 60 * 1000);

		await (service as any).runCleanup();
		expect(service.isInitialCleanupReady()).toBe(true);
		expect(schedule).toHaveBeenLastCalledWith(60 * 1000);
		expect(cleanupCycle).toHaveBeenCalledTimes(3);
	});
});
