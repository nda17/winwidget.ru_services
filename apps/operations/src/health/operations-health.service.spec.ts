import { OperationsRuntimeService } from '../runtime/operations-runtime.service';
import { OperationsHealthService } from './operations-health.service';

describe('OperationsHealthService', () => {
	it('is ready while ownership is staged and business traffic remains fenced', async () => {
		const ownership = { isActive: jest.fn().mockResolvedValue(false) };
		const service = new OperationsHealthService(
			{
				$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }])
			} as never,
			{
				role: 'worker',
				rabbitEnabled: true,
				workerEnabled: true,
				outboxPublisherEnabled: false
			} as OperationsRuntimeService,
			{
				isConnected: jest.fn().mockReturnValue(true),
				isReady: jest.fn().mockReturnValue(true)
			} as never,
			{ isReady: jest.fn().mockReturnValue(true) } as never,
			{ isReady: jest.fn().mockReturnValue(true) } as never,
			ownership as never
		);

		await expect(service.readiness()).resolves.toEqual(
			expect.objectContaining({ status: 'ready', service: 'operations' })
		);
		expect(ownership.isActive).toHaveBeenCalledTimes(1);
	});
});
