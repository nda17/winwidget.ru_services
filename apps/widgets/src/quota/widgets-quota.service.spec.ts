import { ConfigService } from '@nestjs/config';
import {
	EntitlementPlan,
	EntitlementStatus,
	OwnerStatus
} from '@prisma/widgets-client';
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

	it('validates AI entitlement with read-only queries and no FOR UPDATE', async () => {
		const now = new Date();
		const owner = {
			userId: 'user-1',
			status: OwnerStatus.ACTIVE,
			tombstoned: false,
			deletedAt: null
		};
		const entitlement = {
			userId: 'user-1',
			status: EntitlementStatus.ACTIVE,
			plan: EntitlementPlan.HARD,
			startsAt: new Date(now.getTime() - 60_000),
			expiresAt: new Date(now.getTime() + 60_000),
			maxWidgets: 10,
			maxLeadsPerPeriod: null,
			unlimited: true,
			tombstoned: false,
			sourceOccurredAt: now,
			aggregateVersion: 2
		};
		const counter = {
			userId: 'user-1',
			entitlementVersion: 2,
			widgetCount: 1,
			leadCount: 0
		};
		const prisma = {
			widgetOwnerProjection: {
				findUnique: jest.fn().mockResolvedValue(owner)
			},
			widgetEntitlementProjection: {
				findUnique: jest.fn().mockResolvedValue(entitlement)
			},
			widgetUsageCounter: {
				findUnique: jest.fn().mockResolvedValue(counter),
				update: jest.fn()
			},
			widgetUsageLedgerEntry: { create: jest.fn() },
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

		await expect(service.aiSnapshot('user-1')).resolves.toEqual({
			entitlement,
			counter
		});
		expect(prisma.$queryRaw).not.toHaveBeenCalled();
		expect(prisma.widgetUsageCounter.update).not.toHaveBeenCalled();
		expect(prisma.widgetUsageLedgerEntry.create).not.toHaveBeenCalled();
	});
});
