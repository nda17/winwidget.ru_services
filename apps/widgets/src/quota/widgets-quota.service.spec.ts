import { ConfigService } from '@nestjs/config';
import { WidgetsQuotaService } from './widgets-quota.service';

describe('WidgetsQuotaService read snapshot', () => {
	it('does not acquire the mutation quota lock for an incomplete projection', async () => {
		const prisma = {
			widgetEntitlementProjection: {
				findUnique: jest.fn().mockResolvedValue(null)
			},
			widgetUsageCounter: {
				findUnique: jest.fn().mockResolvedValue(null)
			},
			$transaction: jest.fn((queries: Array<Promise<unknown>>) =>
				Promise.all(queries)
			),
			$queryRaw: jest.fn()
		};
		const service = new WidgetsQuotaService(
			prisma as never,
			{
				get: jest.fn().mockReturnValue('60000')
			} as unknown as ConfigService
		);

		await expect(service.readSnapshot('user-1')).resolves.toEqual({
			entitlement: null,
			counter: null
		});
		expect(
			prisma.widgetEntitlementProjection.findUnique
		).toHaveBeenCalledWith({
			where: { userId: 'user-1' }
		});
		expect(prisma.widgetUsageCounter.findUnique).toHaveBeenCalledWith({
			where: { userId: 'user-1' }
		});
		expect(prisma.$queryRaw).not.toHaveBeenCalled();
	});
});
