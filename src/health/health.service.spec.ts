import { HealthService } from '@/health/health.service';
import type { NotificationDeliveryClientService } from '@/messaging/notification-delivery-client.service';
import type { RabbitMqManagementService } from '@/messaging/rabbitmq-management.service';
import type { PrismaService } from '@/prisma.service';
import type { ConfigService } from '@nestjs/config';

const createOverview = () => ({
	outbox: {
		PENDING: 1,
		PUBLISHING: 0,
		PUBLISHED: 10,
		FAILED: 2
	},
	oldestPendingAt: '2026-07-27T11:58:00.000Z',
	operational: {
		staleOutbox: 1,
		dueOutbox: 1,
		unresolvedFailuresByCategory: {
			TRANSIENT: 2,
			RATE_LIMIT: 0,
			PERMANENT: 1,
			AUTH_CONFIGURATION: 0,
			UNCLASSIFIED: 0
		}
	},
	unresolvedFailures: 3,
	retryingFailures: 0,
	deliveredLast24Hours: 10,
	heartbeat: {
		service: 'notification-delivery-worker' as const,
		status: 'ok' as const,
		activeInstances: 1,
		lastSeenAt: '2026-07-27T11:59:55.000Z',
		lastSuccessfulPublishAt: '2026-07-27T11:59:50.000Z',
		lastSuccessfulConsumeAt: '2026-07-27T11:59:45.000Z'
	}
});

const createService = (
	notificationDelivery: Partial<NotificationDeliveryClientService> = {
		getOverview: jest.fn().mockResolvedValue(createOverview())
	}
) => {
	const prisma = {
		$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
		outboxEvent: {
			count: jest.fn().mockResolvedValue(1),
			findFirst: jest.fn().mockResolvedValue({
				createdAt: new Date('2026-07-27T11:59:00.000Z')
			})
		},
		integrationDeliveryFailure: {
			count: jest.fn().mockResolvedValue(4)
		}
	} as unknown as PrismaService;
	const service = new HealthService(
		prisma,
		{ get: jest.fn() } as unknown as ConfigService,
		{} as RabbitMqManagementService,
		notificationDelivery as NotificationDeliveryClientService
	);
	return { service, prisma };
};

describe('HealthService notification delivery monitoring', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	it('combines legacy and notification-delivery backlog without old moved failures', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
		const { service, prisma } = createService();
		const resultPromise = (service as any).getNotificationDeliveryResult();

		const check = await (service as any).checkMessagingBacklog(
			resultPromise
		);

		expect(prisma.integrationDeliveryFailure.count).toHaveBeenCalledWith({
			where: {
				resolvedAt: null,
				integration: {
					notIn: [
						'email',
						'telegram',
						'payment-email',
						'payment-telegram',
						'limit-email',
						'limit-telegram'
					]
				}
			}
		});
		expect(check).toMatchObject({
			id: 'messaging_backlog',
			status: 'warning',
			message: 'Outbox FAILED: 3, DLQ: 7, старейшее ожидание: 120 сек.'
		});
	});

	it('reports an unavailable internal API without throwing the admin checks', async () => {
		const { service } = createService({
			getOverview: jest
				.fn()
				.mockRejectedValue(new Error('connect ECONNREFUSED'))
		});
		const resultPromise = (service as any).getNotificationDeliveryResult();

		await expect(
			(service as any).checkNotificationDelivery(resultPromise)
		).resolves.toMatchObject({
			id: 'notification_delivery',
			status: 'down',
			message: 'connect ECONNREFUSED'
		});
		await expect(
			(service as any).checkMessagingBacklog(resultPromise)
		).resolves.toMatchObject({
			status: 'warning',
			message: expect.stringContaining(
				'Notification Delivery metrics недоступны'
			)
		});
	});

	it('keeps API readiness independent from Notification Delivery', async () => {
		const getOverview = jest
			.fn()
			.mockRejectedValue(new Error('service is down'));
		const { service } = createService({ getOverview });

		await expect(service.getReadinessHealth()).resolves.toEqual(
			expect.objectContaining({
				status: 'ready',
				service: 'api'
			})
		);
		expect(getOverview).not.toHaveBeenCalled();
	});
});
