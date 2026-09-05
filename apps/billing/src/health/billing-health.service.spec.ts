import type { BillingOutboxPublisherService } from '../messaging/billing-outbox-publisher.service';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BillingRabbitMqService } from '../messaging/billing-rabbitmq.service';
import type { BillingWorkerService } from '../messaging/billing-worker.service';
import type { BillingPrismaService } from '../prisma/billing-prisma.service';
import type { BillingProviderWorkerService } from '../provider/billing-provider-worker.service';
import { PaymentMethodCryptoService } from '../provider/payment-method-crypto.service';
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
		'YOOKASSA_PRODUCTION_SECRET_KEY',
		'PAYMENT_METHOD_ENCRYPTION_KEY',
		'APP_REVISION',
		'BILLING_WINCRM_PAYMENTS_ENABLED',
		'BILLING_WINCRM_PROVIDER_RABBITMQ_URL'
	] as const;
	const originalEnvironment = new Map(
		environmentKeys.map(key => [key, process.env[key]])
	);
	beforeEach(() => {
		delete process.env.BILLING_WINCRM_PAYMENTS_ENABLED;
		delete process.env.BILLING_WINCRM_PROVIDER_RABBITMQ_URL;
	});

	afterEach(() => {
		for (const key of environmentKeys) {
			const value = originalEnvironment.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	const createService = (
		role: 'api' | 'scheduler' | 'worker' | 'outbox-publisher'
	) => {
		const runtime = {
			role,
			apiEnabled: role === 'api',
			rabbitEnabled: role === 'worker' || role === 'outbox-publisher',
			workerEnabled: role === 'worker',
			outboxPublisherEnabled: role === 'outbox-publisher',
			schedulerEnabled: role === 'scheduler'
		} as BillingRuntimeService;
		const yookassa = new YooKassaService();
		const paymentMethodCrypto = new PaymentMethodCryptoService();
		const crmEntitlementFindFirst = jest.fn().mockResolvedValue(null);
		const crmCommercialPolicyFindFirst = jest
			.fn()
			.mockResolvedValue({ version: 1 });
		const crmCommerceAccountFindFirst = jest.fn().mockResolvedValue(null);
		const crmPaidPeriodFindFirst = jest.fn().mockResolvedValue(null);
		const crmProviderOperationFindFirst = jest
			.fn()
			.mockResolvedValue(null);
		const wincrmWorkerReady = jest.fn().mockReturnValue(true);
		const wincrmSchedulerReady = jest.fn().mockReturnValue(true);
		const service = new BillingHealthService(
			{
				$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
				crmEntitlement: {
					findFirst: crmEntitlementFindFirst
				},
				crmCommercialPolicy: { findFirst: crmCommercialPolicyFindFirst },
				crmCommerceAccount: { findFirst: crmCommerceAccountFindFirst },
				crmPaidPeriod: { findFirst: crmPaidPeriodFindFirst },
				crmProviderOperation: { findFirst: crmProviderOperationFindFirst },
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
			paymentMethodCrypto,
			{
				isReady: jest.fn().mockReturnValue(true)
			} as unknown as BillingOutboxPublisherService,
			{
				isReady: jest.fn().mockReturnValue(true)
			} as unknown as BillingSchedulerService,
			{ isReady: wincrmWorkerReady } as never,
			{ isReady: wincrmSchedulerReady } as never
		);
		return {
			crmEntitlementFindFirst,
			crmCommercialPolicyFindFirst,
			crmCommerceAccountFindFirst,
			crmPaidPeriodFindFirst,
			crmProviderOperationFindFirst,
			wincrmWorkerReady,
			wincrmSchedulerReady,
			service,
			yookassa
		};
	};
	it('does not require new-sales workers before CRM commerce rollout', async () => {
		const test = createService('scheduler');
		test.crmCommerceAccountFindFirst.mockRejectedValue(
			new Error('migration not deployed')
		);
		test.wincrmSchedulerReady.mockReturnValue(false);
		await expect(test.service.readiness()).resolves.toMatchObject({
			status: 'ready'
		});
		expect(test.crmCommerceAccountFindFirst).not.toHaveBeenCalled();
		expect(test.wincrmSchedulerReady).not.toHaveBeenCalled();
	});
	it('always requires the paid-period schema used by entitlement reads', async () => {
		const test = createService('scheduler');
		test.crmPaidPeriodFindFirst.mockRejectedValue(
			new Error('migration missing')
		);
		await expect(test.service.readiness()).rejects.toThrow(
			'Billing database is not ready'
		);
	});
	it('requires commerce schema when CRM payments are enabled', async () => {
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'true';
		const test = createService('scheduler');
		test.crmProviderOperationFindFirst.mockRejectedValue(
			new Error('migration missing')
		);
		await expect(test.service.readiness()).rejects.toThrow(
			'Billing database is not ready'
		);
	});
	it('keeps checking reconciliation schema with new sales disabled and its broker configured', async () => {
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'false';
		process.env.BILLING_WINCRM_PROVIDER_RABBITMQ_URL =
			'amqp://synthetic:synthetic@127.0.0.1:5672/test';
		const test = createService('scheduler');
		await expect(test.service.readiness()).resolves.toMatchObject({
			status: 'ready'
		});
		expect(test.crmCommerceAccountFindFirst).toHaveBeenCalledTimes(1);
		expect(test.crmProviderOperationFindFirst).toHaveBeenCalledTimes(1);
	});
	it.each(['worker', 'scheduler'] as const)(
		'fails readiness if the enabled CRM %s is not ready',
		async role => {
			process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'true';
			const test = createService(role);
			(role === 'worker'
				? test.wincrmWorkerReady
				: test.wincrmSchedulerReady
			).mockReturnValue(false);
			await expect(test.service.readiness()).rejects.toThrow(
				'WinCRM commerce workers are not ready'
			);
		}
	);

	it('publishes only a boolean when production YooKassa credentials are configured', async () => {
		process.env.MODE = 'production';
		process.env.YOOKASSA_PRODUCTION_SHOP_ID = 'test-shop';
		process.env.YOOKASSA_PRODUCTION_SECRET_KEY = 'test-secret';
		process.env.PAYMENT_METHOD_ENCRYPTION_KEY = Buffer.alloc(
			32,
			7
		).toString('base64');
		process.env.APP_REVISION = 'billing-test-revision';
		const { service } = createService('worker');

		const readiness = await service.readiness();

		expect(readiness).toMatchObject({
			status: 'ready',
			role: 'worker',
			providers: { yookassa: true },
			providerConfiguration: {
				yookassa: {
					mode: 'production',
					shopIdConfigured: true,
					secretKeyConfigured: true,
					credentialsConfigured: true
				},
				paymentMethodEncryptionKeyConfigured: true
			}
		});
		expect(JSON.stringify(readiness)).not.toContain('test-shop');
		expect(JSON.stringify(readiness)).not.toContain('test-secret');
	});

	it('fails worker readiness closed when YooKassa credentials are missing', async () => {
		process.env.MODE = 'production';
		process.env.YOOKASSA_PRODUCTION_SHOP_ID = 'test-shop';
		delete process.env.YOOKASSA_PRODUCTION_SECRET_KEY;
		process.env.PAYMENT_METHOD_ENCRYPTION_KEY = Buffer.alloc(
			32,
			7
		).toString('base64');
		const { service } = createService('worker');

		await expect(service.readiness()).rejects.toThrow(
			'Billing provider configuration is not ready'
		);
	});

	it('fails readiness closed when the commercial policy seed is absent', async () => {
		const { crmCommercialPolicyFindFirst, service } = createService('api');
		crmCommercialPolicyFindFirst.mockResolvedValueOnce(null);
		await expect(service.readiness()).rejects.toThrow(
			'Billing database is not ready'
		);
	});

	it('fails worker readiness closed when the payment-method key is not a valid base64 32-byte key', async () => {
		process.env.MODE = 'production';
		process.env.YOOKASSA_PRODUCTION_SHOP_ID = 'test-shop';
		process.env.YOOKASSA_PRODUCTION_SECRET_KEY = 'test-secret';
		process.env.PAYMENT_METHOD_ENCRYPTION_KEY = 'not-a-valid-key';
		const { service } = createService('worker');

		await expect(service.readiness()).rejects.toThrow(
			'Billing payment-method encryption is not ready'
		);
	});

	it('does not add provider configuration to non-worker readiness', async () => {
		process.env.PAYMENT_METHOD_ENCRYPTION_KEY = Buffer.alloc(
			32,
			7
		).toString('base64');
		const { service, yookassa } = createService('api');
		const configured = jest.spyOn(yookassa, 'isConfigured');

		const readiness = await service.readiness();

		expect(readiness).not.toHaveProperty('providers');
		expect(readiness).not.toHaveProperty('providerConfiguration');
		expect(configured).not.toHaveBeenCalled();
	});

	it('checks the WinCRM provisioning provenance schema before reporting readiness', async () => {
		process.env.PAYMENT_METHOD_ENCRYPTION_KEY = Buffer.alloc(
			32,
			7
		).toString('base64');
		const { crmEntitlementFindFirst, service } = createService('api');

		await expect(service.readiness()).resolves.toMatchObject({
			status: 'ready',
			role: 'api'
		});
		expect(crmEntitlementFindFirst).toHaveBeenCalledWith({
			select: {
				provisioningCommandId: true,
				provisioningCommandType: true,
				policyVersion: true,
				graceUntil: true
			}
		});
	});

	it('fails readiness closed when the WinCRM provisioning provenance schema is missing', async () => {
		process.env.PAYMENT_METHOD_ENCRYPTION_KEY = Buffer.alloc(
			32,
			7
		).toString('base64');
		const { crmEntitlementFindFirst, service } = createService('api');
		crmEntitlementFindFirst.mockRejectedValue(new Error('missing column'));

		await expect(service.readiness()).rejects.toThrow(
			'Billing database is not ready'
		);
	});

	it.each([undefined, 'not-a-valid-key'])(
		'fails API readiness closed for invalid payment-method key %s',
		async key => {
			if (key === undefined)
				delete process.env.PAYMENT_METHOD_ENCRYPTION_KEY;
			else process.env.PAYMENT_METHOD_ENCRYPTION_KEY = key;
			const { service } = createService('api');

			await expect(service.readiness()).rejects.toThrow(
				'Billing payment-method encryption is not ready'
			);
		}
	);

	it.each(['scheduler', 'outbox-publisher'] as const)(
		'does not require the payment-method key for %s readiness',
		async role => {
			delete process.env.PAYMENT_METHOD_ENCRYPTION_KEY;
			const { service } = createService(role);

			await expect(service.readiness()).resolves.toMatchObject({
				status: 'ready',
				role
			});
		}
	);
});

describe('Billing production secret ownership', () => {
	const compose = readFileSync(
		resolve(__dirname, '../../../../deploy/docker-compose.prod.yml'),
		'utf8'
	);

	const serviceBlock = (service: string): string => {
		const marker = `  ${service}:\n`;
		const start = compose.indexOf(marker);
		if (start < 0)
			throw new Error(`Compose service ${service} is missing`);
		const remaining = compose.slice(start + marker.length);
		const next = remaining.search(/^  [a-z0-9][a-z0-9-]*:\n/m);
		return next < 0 ? remaining : remaining.slice(0, next);
	};

	it('passes the payment-method key only to api and worker roles', () => {
		const key = 'PAYMENT_METHOD_ENCRYPTION_KEY:';

		expect(serviceBlock('billing-api')).toContain(key);
		expect(serviceBlock('billing-worker')).toContain(key);
		expect(serviceBlock('billing-scheduler')).not.toContain(key);
		expect(serviceBlock('billing-outbox-publisher')).not.toContain(key);
	});

	it('keeps YooKassa credentials owned only by the worker role', () => {
		for (const service of [
			'billing-api',
			'billing-scheduler',
			'billing-outbox-publisher'
		]) {
			expect(serviceBlock(service)).not.toContain(
				'YOOKASSA_PRODUCTION_SHOP_ID:'
			);
			expect(serviceBlock(service)).not.toContain(
				'YOOKASSA_PRODUCTION_SECRET_KEY:'
			);
		}
		expect(serviceBlock('billing-worker')).toContain(
			'YOOKASSA_PRODUCTION_SHOP_ID:'
		);
		expect(serviceBlock('billing-worker')).toContain(
			'YOOKASSA_PRODUCTION_SECRET_KEY:'
		);
	});
});
