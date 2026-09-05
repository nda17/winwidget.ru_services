import { WincrmCommerceSchedulerService } from './wincrm-commerce-scheduler.service';

jest.mock('../domain/wincrm-commerce.service', () => ({
	WincrmCommerceService: class {}
}));

describe('WinCRM durable renewal scheduler', () => {
	const originalFlag = process.env.BILLING_WINCRM_PAYMENTS_ENABLED;
	const originalBrokerUrl =
		process.env.BILLING_WINCRM_PROVIDER_RABBITMQ_URL;
	let scheduler: WincrmCommerceSchedulerService;
	const advanceRenewals = jest.fn();
	beforeEach(() => {
		jest.useFakeTimers();
		advanceRenewals.mockReset().mockResolvedValue(undefined);
		delete process.env.BILLING_WINCRM_PAYMENTS_ENABLED;
		delete process.env.BILLING_WINCRM_PROVIDER_RABBITMQ_URL;
		scheduler = new WincrmCommerceSchedulerService(
			{ schedulerEnabled: true } as never,
			{ advanceRenewals } as never
		);
	});
	afterEach(() => {
		scheduler.onApplicationShutdown();
		jest.useRealTimers();
		jest.restoreAllMocks();
		if (originalFlag === undefined)
			delete process.env.BILLING_WINCRM_PAYMENTS_ENABLED;
		else process.env.BILLING_WINCRM_PAYMENTS_ENABLED = originalFlag;
		if (originalBrokerUrl === undefined)
			delete process.env.BILLING_WINCRM_PROVIDER_RABBITMQ_URL;
		else
			process.env.BILLING_WINCRM_PROVIDER_RABBITMQ_URL = originalBrokerUrl;
	});
	it('is inert by default, without querying payments or starting a timer', async () => {
		scheduler.onModuleInit();
		await scheduler.tick();
		expect(advanceRenewals).not.toHaveBeenCalled();
		expect(jest.getTimerCount()).toBe(0);
		expect(scheduler.isReady()).toBe(true);
	});
	it('runs only inside the scheduler role', async () => {
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'true';
		scheduler = new WincrmCommerceSchedulerService(
			{ schedulerEnabled: false } as never,
			{ advanceRenewals } as never
		);
		scheduler.onModuleInit();
		await scheduler.tick();
		expect(advanceRenewals).not.toHaveBeenCalled();
		expect(jest.getTimerCount()).toBe(0);
	});
	it('reserves durable work immediately and on each minute without overlap', async () => {
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'true';
		let complete!: () => void;
		advanceRenewals.mockReturnValueOnce(
			new Promise<void>(resolve => {
				complete = resolve;
			})
		);
		expect(scheduler.isReady()).toBe(false);
		scheduler.onModuleInit();
		expect(scheduler.isReady()).toBe(true);
		expect(advanceRenewals).toHaveBeenCalledWith(expect.any(Date));
		await jest.advanceTimersByTimeAsync(180_000);
		expect(advanceRenewals).toHaveBeenCalledTimes(1);
		complete();
		await jest.advanceTimersByTimeAsync(60_000);
		expect(advanceRenewals).toHaveBeenCalledTimes(2);
	});
	it('stops ticking before rollout when neither sales nor reconciliation is configured', async () => {
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'true';
		scheduler.onModuleInit();
		await jest.advanceTimersByTimeAsync(1);
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'false';
		await jest.advanceTimersByTimeAsync(120_000);
		expect(advanceRenewals).toHaveBeenCalledTimes(1);
	});
	it('keeps durable reconciliation alive after sales close while its broker is configured', async () => {
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'false';
		process.env.BILLING_WINCRM_PROVIDER_RABBITMQ_URL =
			'amqp://synthetic:synthetic@127.0.0.1:5672/test';
		scheduler.onModuleInit();
		await jest.advanceTimersByTimeAsync(60_000);
		expect(advanceRenewals).toHaveBeenCalledTimes(2);
		expect(scheduler.isReady()).toBe(true);
	});
	it('recovers after a failed reservation and emits only a static warning', async () => {
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'true';
		const warning = jest
			.spyOn(scheduler['logger'], 'warn')
			.mockImplementation(() => {});
		advanceRenewals.mockRejectedValueOnce(
			new Error('sensitive-database-url')
		);
		scheduler.onModuleInit();
		await jest.advanceTimersByTimeAsync(60_000);
		expect(advanceRenewals).toHaveBeenCalledTimes(2);
		expect(warning).toHaveBeenCalledWith(
			'WinCRM renewal scheduling is temporarily unavailable'
		);
		expect(JSON.stringify(warning.mock.calls)).not.toContain(
			'sensitive-database-url'
		);
	});
	it('clears its timer and rejects new work after shutdown', async () => {
		process.env.BILLING_WINCRM_PAYMENTS_ENABLED = 'true';
		scheduler.onModuleInit();
		scheduler.onApplicationShutdown();
		await scheduler.tick();
		await jest.advanceTimersByTimeAsync(120_000);
		expect(advanceRenewals).toHaveBeenCalledTimes(1);
		expect(jest.getTimerCount()).toBe(0);
		expect(scheduler.isReady()).toBe(false);
	});
});
