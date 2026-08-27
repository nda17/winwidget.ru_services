import { OperationsRuntimeService } from '../runtime/operations-runtime.service';
import { OperationsHealthService } from './operations-health.service';

describe('OperationsHealthService', () => {
	it('is ready when the database and enabled workers are ready', async () => {
		const service = new OperationsHealthService(
			{
				$queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
				serviceIdentity: {
					findUnique: jest.fn().mockResolvedValue({
						serviceName: 'operations-service',
						databaseId: '11111111-1111-4111-8111-111111111111'
					})
				}
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
			{ isReady: jest.fn().mockReturnValue(true) } as never,
			{ isReady: jest.fn().mockReturnValue(true) } as never,
			{ isReady: jest.fn().mockReturnValue(true) } as never,
			{ getOverview: jest.fn() } as never,
			{ getIdentityAdminHealth: jest.fn() } as never,
			{ get: jest.fn() } as never
		);

		await expect(service.readiness()).resolves.toEqual(
			expect.objectContaining({ status: 'ready', service: 'operations' })
		);
	});
});
