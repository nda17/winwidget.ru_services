import type { BillingOutboxPublisherService } from '../messaging/billing-outbox-publisher.service';
import type { BillingRabbitMqService } from '../messaging/billing-rabbitmq.service';
import type { BillingWorkerService } from '../messaging/billing-worker.service';
import type { BillingPrismaService } from '../prisma/billing-prisma.service';
import type { BillingProviderWorkerService } from '../provider/billing-provider-worker.service';
import { YooKassaService } from '../provider/yookassa.service';
import type { BillingRuntimeService } from '../runtime/billing-runtime.service';
import type { BillingSchedulerService } from '../scheduler/billing-scheduler.service';
import { BillingHealthService } from './billing-health.service';

describe('BillingHealthService provider configuration', () => {
	const environmentKeys = [
		'MODE',
		'YOOKASSA_SHOP_ID',
		'YOOKASSA_SECRET_KEY',
		'YOOKASSA_PRODUCTION_SHOP_ID',
		'YOOKASSA_PRODUCTION_SECRET_KEY'
	] as const;
	const originalEnvironment = new Map(
		environmentKeys.map(key => [key, process.env[key]])
	);

	afterEach(() => {
		for (const key of environmentKeys) {
			const value = originalEnvironment.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	const createService = (role: 'api' | 'worker') => {
		const runtime = {
			role,
			rabbitEnabled: role === 'worker',
			workerEnabled: role === 'worker',
			outboxPublisherEnabled: false,
			schedulerEnabled: false
		} as BillingRuntimeService;
		const yookassa = new YooKassaService();
		const service = new BillingHealthService(
			{
				$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
				serviceIdentity: {
					findUnique: jest.fn().mockResolvedValue({
						serviceName: 'billing-service',
						databaseId: '00000000-0000-4000-8000-000000000001'
					})
				}
			} as unknown as BillingPrismaService,
			runtime,
			{
				isConnected: jest.fn().mockReturnValue(true),
				isTopologyReady: jest.fn().mockReturnValue(true)
			} as unknown as BillingRabbitMqService,
			{
				isReady: jest.fn().mockReturnValue(true)
			} as unknown as BillingWorkerService,
			{
				isReady: jest.fn().mockReturnValue(true)
			} as unknown as BillingProviderWorkerService,
			yookassa,
			{
				isReady: jest.fn().mockReturnValue(true)
			} as unknown as BillingOutboxPublisherService,
			{
				isReady: jest.fn().mockReturnValue(true)
			} as unknown as BillingSchedulerService
		);
		return { service, yookassa };
	};

	it('publishes only a boolean when production YooKassa credentials are configured', async () => {
		process.env.MODE = 'production';
		process.env.YOOKASSA_PRODUCTION_SHOP_ID = 'test-shop';
		process.env.YOOKASSA_PRODUCTION_SECRET_KEY = 'test-secret';
		const { service } = createService('worker');

		const readiness = await service.readiness();

		expect(readiness).toMatchObject({
			status: 'ready',
			role: 'worker',
			providers: { yookassa: true }
		});
		expect(JSON.stringify(readiness)).not.toContain('test-shop');
		expect(JSON.stringify(readiness)).not.toContain('test-secret');
	});

	it('keeps the worker ready while publishing an unconfigured provider', async () => {
		process.env.MODE = 'production';
		process.env.YOOKASSA_PRODUCTION_SHOP_ID = 'test-shop';
		delete process.env.YOOKASSA_PRODUCTION_SECRET_KEY;
		const { service } = createService('worker');

		await expect(service.readiness()).resolves.toMatchObject({
			status: 'ready',
			providers: { yookassa: false }
		});
	});

	it('does not add provider configuration to non-worker readiness', async () => {
		const { service, yookassa } = createService('api');
		const configured = jest.spyOn(yookassa, 'isConfigured');

		const readiness = await service.readiness();

		expect(readiness).not.toHaveProperty('providers');
		expect(configured).not.toHaveBeenCalled();
	});
});
