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

	it('reports readiness only when worker, outbox, RabbitMQ and DB are ready', async () => {
		const worker = { isReady: jest.fn().mockReturnValue(true) };
		const outbox = { isReady: jest.fn().mockReturnValue(true) };
		const rabbitMq = {
			isConnected: jest.fn().mockReturnValue(true),
			areConsumersReady: jest.fn().mockReturnValue(true)
		};
		const prisma = {
			$queryRaw: jest.fn().mockResolvedValue([{ one: 1 }])
		};
		const service = new NotificationDeliveryHealthService(
			worker as any,
			outbox as any,
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
});
