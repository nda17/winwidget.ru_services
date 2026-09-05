import { CrmBillingReconciliationService } from './billing-reconciliation.service';
describe('CRM billing pending operation reconciliation', () => {
	const fixture = (enabled = true, workerEnabled = true) => {
		const prisma = {
			$queryRaw: jest
				.fn()
				.mockResolvedValue([
					{ workspaceId: 'workspace', commandId: 'command' }
				])
		};
		const capacity = {
			known: jest.fn().mockResolvedValue({ commandId: 'command' }),
			synchronize: jest.fn().mockResolvedValue({})
		};
		return {
			prisma,
			capacity,
			service: new CrmBillingReconciliationService(
				prisma as never,
				{ enabled } as never,
				capacity as never,
				{ workerEnabled } as never
			)
		};
	};
	afterEach(() => jest.useRealTimers());
	it('uses DB due time and a bounded indexed queue, never billing write commands', async () => {
		const f = fixture();
		await f.service.tick();
		const sql = f.prisma.$queryRaw.mock.calls[0][0].join('');
		expect(sql).toContain('clock_timestamp()');
		expect(sql).toContain('ORDER BY next_check_at, command_id LIMIT 25');
		expect(f.capacity.synchronize).toHaveBeenCalledTimes(1);
	});
	it.each([
		[false, true],
		[true, false]
	])(
		'does no background work when disabled/API role',
		async (enabled, worker) => {
			jest.useFakeTimers();
			const f = fixture(enabled, worker);
			f.service.onModuleInit();
			await jest.advanceTimersByTimeAsync(15000);
			expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
			await f.service.beforeApplicationShutdown();
		}
	);
	it('keeps future attempts after a database outage', async () => {
		jest.useFakeTimers();
		const f = fixture();
		f.prisma.$queryRaw.mockRejectedValueOnce(Error('DB_DOWN'));
		f.service.onModuleInit();
		await jest.advanceTimersByTimeAsync(10000);
		expect(f.prisma.$queryRaw).toHaveBeenCalledTimes(2);
		expect(f.capacity.synchronize).toHaveBeenCalledTimes(1);
		await f.service.beforeApplicationShutdown();
	});
	it('continues unrelated work when a proof dependency fails and drains before shutdown', async () => {
		jest.useFakeTimers();
		const f = fixture();
		f.prisma.$queryRaw.mockResolvedValue([
			{ workspaceId: 'w', commandId: 'a' },
			{ workspaceId: 'w', commandId: 'b' }
		]);
		let finish!: () => void;
		f.capacity.synchronize
			.mockImplementationOnce(
				() =>
					new Promise<void>(resolve => {
						finish = resolve;
					})
			)
			.mockRejectedValueOnce(Error('BILLING_DOWN'));
		f.service.onModuleInit();
		await jest.advanceTimersByTimeAsync(5000);
		let stopped = false;
		const closing = f.service.beforeApplicationShutdown().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		finish();
		await closing;
		expect(stopped).toBe(true);
		await jest.advanceTimersByTimeAsync(20000);
		expect(f.prisma.$queryRaw).toHaveBeenCalledTimes(1);
	});
});
