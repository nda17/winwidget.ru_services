import { PlatformOutboxPublisherService } from './platform-outbox-publisher.service';

const event = () => ({
	id: 'outbox-1',
	eventId: '11111111-1111-4111-8111-111111111111',
	messageId: null,
	deduplicationKey: null,
	eventType: 'admin.audit.event.v1',
	aggregateType: 'platform.admin-audit',
	aggregateId: 'singleton',
	aggregateVersion: null,
	sourceSequence: null,
	correlationId: null,
	exchange: 'winwidget.events',
	routingKey: 'admin.audit.platform.v1',
	payload: {},
	deliveryAttempt: 0,
	status: 'PROCESSING',
	attempt: 1,
	availableAt: new Date('2026-08-23T10:00:00.000Z'),
	leaseToken: 'lease-1',
	leaseUntil: new Date('2026-08-23T10:01:00.000Z'),
	publishedAt: null,
	lastError: null,
	createdAt: new Date('2026-08-23T10:00:00.000Z'),
	updatedAt: new Date('2026-08-23T10:00:00.000Z')
});

function publisher(options: {
	claimCount?: number;
	publishCount?: number;
	releaseCount?: number;
	publishError?: Error;
}) {
	const prisma = {
		outboxEvent: {
			findFirst: jest.fn().mockResolvedValue(event()),
			updateMany: jest
				.fn()
				.mockResolvedValueOnce({ count: options.claimCount ?? 1 })
				.mockResolvedValueOnce({ count: options.publishCount ?? 1 })
				.mockResolvedValueOnce({ count: options.releaseCount ?? 1 }),
			findUniqueOrThrow: jest.fn().mockResolvedValue(event())
		}
	};
	const rabbit = {
		publish: options.publishError
			? jest.fn().mockRejectedValue(options.publishError)
			: jest.fn().mockResolvedValue(undefined)
	};
	const value = new PlatformOutboxPublisherService(
		prisma as never,
		{
			outboxPublisherEnabled: true,
			outboxPollIntervalMs: 1_000,
			outboxBatchSize: 10
		} as never,
		rabbit as never
	);
	return { value, prisma, rabbit };
}

describe('PlatformOutboxPublisherService CAS', () => {
	it('rechecks availableAt in the claim CAS predicate', async () => {
		const current = publisher({ claimCount: 0 });
		await expect(current.value.publishOne()).resolves.toBe(false);
		expect(current.prisma.outboxEvent.updateMany).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: expect.objectContaining({
					availableAt: { lte: expect.any(Date) }
				})
			})
		);
		expect(current.rabbit.publish).not.toHaveBeenCalled();
	});

	it('fails when the published transition loses its lease', async () => {
		const current = publisher({ publishCount: 0, releaseCount: 0 });
		await expect(current.value.publishOne()).rejects.toThrow(
			'PLATFORM_OUTBOX_RESCHEDULE_LEASE_LOST'
		);
	});

	it('fails when an error reschedule loses its lease', async () => {
		const current = publisher({
			publishError: new Error('rabbit unavailable'),
			publishCount: 0
		});
		await expect(current.value.publishOne()).rejects.toThrow(
			'PLATFORM_OUTBOX_RESCHEDULE_LEASE_LOST'
		);
	});
});
