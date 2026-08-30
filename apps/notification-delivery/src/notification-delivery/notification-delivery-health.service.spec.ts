import {
	NotificationDeliveryHealthService,
	parseNotificationDeliveryHealthPort
} from './notification-delivery-health.service';

describe('NotificationDeliveryHealthService', () => {
	it('validates the dedicated health port', () => {
		expect(parseNotificationDeliveryHealthPort()).toBe(4401);
		expect(parseNotificationDeliveryHealthPort('4402')).toBe(4402);
		expect(() => parseNotificationDeliveryHealthPort('0')).toThrow();
		expect(() => parseNotificationDeliveryHealthPort('4401x')).toThrow();
	});

	const createReadyDependencies = () => {
		const worker = { isReady: jest.fn().mockReturnValue(true) };
		const outbox = { isReady: jest.fn().mockReturnValue(true) };
		const retention = {
			isInitialCleanupReady: jest.fn().mockReturnValue(true)
		};
		const rabbitMq = {
			isConnected: jest.fn().mockReturnValue(true),
			areConsumersReady: jest.fn().mockReturnValue(true)
		};
		const prisma = {
			$queryRaw: jest.fn().mockResolvedValue([{ one: 1 }])
		};
		return { worker, outbox, retention, rabbitMq, prisma };
	};

	it('reports readiness only when worker, outbox, retention, RabbitMQ and DB are ready', async () => {
		const { worker, outbox, retention, rabbitMq, prisma } =
			createReadyDependencies();
		const service = new NotificationDeliveryHealthService(
			worker as any,
			outbox as any,
			retention as any,
			rabbitMq as any,
			prisma as any
		);

		await expect(service.getReadinessHealth()).resolves.toEqual(
			expect.objectContaining({
				status: 'ready',
				service: 'notification-delivery-worker'
			})
		);
		expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
	});

	it('rejects readiness until the initial retention cleanup completes', async () => {
		const { worker, outbox, retention, rabbitMq, prisma } =
			createReadyDependencies();
		retention.isInitialCleanupReady.mockReturnValue(false);
		const service = new NotificationDeliveryHealthService(
			worker as any,
			outbox as any,
			retention as any,
			rabbitMq as any,
			prisma as any
		);

		await expect(service.getReadinessHealth()).rejects.toThrow(
			'Notification delivery retention is not ready'
		);
		expect(prisma.$queryRaw).not.toHaveBeenCalled();
	});

	it('stays ready when retention remains initialized after a later cleanup error', async () => {
		const { worker, outbox, retention, rabbitMq, prisma } =
			createReadyDependencies();
		const service = new NotificationDeliveryHealthService(
			worker as any,
			outbox as any,
			retention as any,
			rabbitMq as any,
			prisma as any
		);

		await expect(service.getReadinessHealth()).resolves.toEqual(
			expect.objectContaining({ status: 'ready' })
		);
		await expect(service.getReadinessHealth()).resolves.toEqual(
			expect.objectContaining({ status: 'ready' })
		);
		expect(retention.isInitialCleanupReady).toHaveBeenCalledTimes(4);
	});
});
