import {
	ServiceUnavailableException,
	type ExecutionContext
} from '@nestjs/common';
import { ServiceDatabasePhase } from '@prisma/identity-client';
import { IdentityHealthService } from '../health/identity-health.service';
import { IdentityHousekeepingService } from './identity-housekeeping.service';
import { IdentityOwnershipGuard } from './identity-ownership.service';
import {
	parseIdentityPort,
	parseIdentityProcessRole
} from './identity-runtime.service';

function context(path: string): ExecutionContext {
	return {
		switchToHttp: () => ({ getRequest: () => ({ path }) })
	} as unknown as ExecutionContext;
}

describe('Identity runtime ownership fencing', () => {
	it('keeps the canonical roles and API port fail-closed', () => {
		expect(parseIdentityProcessRole(undefined)).toBe('api');
		expect(parseIdentityProcessRole('worker')).toBe('worker');
		expect(() => parseIdentityProcessRole('combined')).toThrow();
		expect(parseIdentityPort('api', {})).toBe(4900);
		expect(() =>
			parseIdentityPort('api', { IDENTITY_PORT: '4901' })
		).toThrow('canonical port 4900');
	});

	it('allows health while dark but blocks every domain route before ACTIVE', async () => {
		const ownership = {
			assertActive: jest
				.fn()
				.mockRejectedValue(
					new ServiceUnavailableException(
						'Identity ownership is not active'
					)
				)
		};
		const guard = new IdentityOwnershipGuard(ownership as any);
		await expect(
			guard.canActivate(context('/health/ready'))
		).resolves.toBe(true);
		await expect(
			guard.canActivate(context('/auth/register'))
		).rejects.toThrow('Identity ownership is not active');
	});

	it('reports dark readiness without requiring worker side effects', async () => {
		const state: {
			serviceName: string;
			databaseId: string;
			phase: ServiceDatabasePhase;
			ownershipGeneration: bigint;
			importedAt: Date;
			activatedAt: Date | null;
		} = {
			serviceName: 'identity-service',
			databaseId: '00000000-0000-4000-8000-000000000001',
			phase: ServiceDatabasePhase.IMPORTED,
			ownershipGeneration: 0n,
			importedAt: new Date(),
			activatedAt: null
		};
		const ownership = {
			state: jest.fn().mockResolvedValue(state),
			isActive: jest.fn().mockResolvedValue(false),
			assertActive: jest.fn()
		};
		const worker = { isReady: jest.fn().mockReturnValue(false) };
		const housekeeping = { isReady: jest.fn().mockReturnValue(false) };
		const health = new IdentityHealthService(
			{
				$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }])
			} as any,
			{ role: 'worker', rabbitEnabled: true, workerEnabled: true } as any,
			{
				isConnected: jest.fn().mockReturnValue(true),
				isTopologyReady: jest.fn().mockReturnValue(true)
			} as any,
			worker as any,
			{ isReady: jest.fn().mockReturnValue(false) } as any,
			{ isReady: jest.fn().mockReturnValue(true) } as any,
			housekeeping as any,
			ownership as any
		);
		await expect(health.readiness()).resolves.toMatchObject({
			status: 'ready',
			ownership: { phase: ServiceDatabasePhase.IMPORTED }
		});

		state.phase = ServiceDatabasePhase.ACTIVE;
		state.ownershipGeneration = 1n;
		state.activatedAt = new Date();
		ownership.isActive.mockResolvedValue(true);
		await expect(health.readiness()).rejects.toThrow(
			'Identity worker is not ready'
		);
		worker.isReady.mockReturnValue(true);
		housekeeping.isReady.mockReturnValue(true);
		await expect(health.readiness()).resolves.toMatchObject({
			status: 'ready',
			ownership: { phase: ServiceDatabasePhase.ACTIVE }
		});
	});

	it('runs housekeeping promptly after IMPORTED transitions to ACTIVE', async () => {
		jest.useFakeTimers();
		const ownership = {
			isActive: jest
				.fn()
				.mockResolvedValueOnce(false)
				.mockResolvedValue(true)
		};
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
			} as any,
			ownership as any
		);
		try {
			housekeeping.onModuleInit();
			await Promise.resolve();
			await Promise.resolve();
			expect(housekeeping.isReady()).toBe(false);
			await jest.advanceTimersByTimeAsync(1_000);
			expect(execute).toHaveBeenCalledTimes(8);
			expect(housekeeping.isReady()).toBe(true);
		} finally {
			housekeeping.onApplicationShutdown();
			jest.useRealTimers();
		}
	});
});
