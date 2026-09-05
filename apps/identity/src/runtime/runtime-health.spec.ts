import { IdentityHealthService } from '../health/identity-health.service';
import { IdentityHousekeepingService } from './identity-housekeeping.service';
import {
	parseIdentityPort,
	parseIdentityProcessRole
} from './identity-runtime.service';

describe('Identity current runtime readiness', () => {
	it('keeps the canonical roles and API port fail-closed', () => {
		expect(parseIdentityProcessRole(undefined)).toBe('api');
		expect(parseIdentityProcessRole('worker')).toBe('worker');
		expect(() => parseIdentityProcessRole('combined')).toThrow();
		expect(parseIdentityPort('api', {})).toBe(4900);
		expect(() =>
			parseIdentityPort('api', { IDENTITY_PORT: '4901' })
		).toThrow('canonical port 4900');
	});

	it('requires the exact database identity and every enabled component', async () => {
		const identity = {
			serviceName: 'identity-service',
			databaseId: '00000000-0000-4000-8000-000000000001'
		};
		const worker = { isReady: jest.fn().mockReturnValue(false) };
		const housekeeping = { isReady: jest.fn().mockReturnValue(false) };
		const health = new IdentityHealthService(
			{
				$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
				serviceIdentity: {
					findUnique: jest.fn().mockImplementation(() => identity)
				}
			} as any,
			{
				role: 'worker',
				rabbitEnabled: true,
				workerEnabled: true,
				outboxPublisherEnabled: false
			} as any,
			{
				isConnected: jest.fn().mockReturnValue(true),
				isTopologyReady: jest.fn().mockReturnValue(true)
			} as any,
			worker as any,
			{ isReady: jest.fn().mockReturnValue(true) } as any,
			{ isReady: jest.fn().mockReturnValue(true) } as any,
			housekeeping as any
		);

		await expect(health.readiness()).rejects.toThrow(
			'Identity worker is not ready'
		);
		worker.isReady.mockReturnValue(true);
		await expect(health.readiness()).rejects.toThrow(
			'Identity housekeeping is not ready'
		);
		housekeeping.isReady.mockReturnValue(true);
		await expect(health.readiness()).resolves.toMatchObject({
			status: 'ready',
			service: 'identity',
			role: 'worker'
		});

		identity.serviceName = 'another-service';
		await expect(health.readiness()).rejects.toThrow(
			'Identity database is not ready'
		);
	});

	it('runs housekeeping immediately for the enabled worker role', async () => {
		jest.useFakeTimers();
		const execute = jest.fn().mockResolvedValue(0);
		const housekeeping = new IdentityHousekeepingService(
			{
				$executeRaw: execute,
				$transaction: jest.fn((queries: Promise<number>[]) =>
					Promise.all(queries)
				)
			} as any,
			{
				workerEnabled: true,
				housekeepingIntervalMs: 60_000,
				outboxRetentionDays: 7,
				receiptRetentionDays: 90,
				failureRetentionDays: 30
			} as any
		);
		try {
			housekeeping.onModuleInit();
			await jest.advanceTimersByTimeAsync(0);
			expect(execute).toHaveBeenCalledTimes(10);
			expect(execute.mock.calls[8][0].sql).toContain(
				'identity.login_otp_challenges'
			);
			expect(execute.mock.calls[9][0].sql).toContain(
				'identity.login_otp_rate_limits'
			);
			expect(execute.mock.calls[9][0].sql).toContain(
				'target.expires_at <'
			);
			expect(housekeeping.isReady()).toBe(true);
		} finally {
			housekeeping.onApplicationShutdown();
			jest.useRealTimers();
		}
	});
});
