import { EntitlementStatus } from '@prisma/widgets-client';
import { WidgetsConfigurationService } from './widgets-configuration.service';
import { getWidgetDefinition, WidgetType } from './widgets-domain.types';

const entitlement = (status: EntitlementStatus) => ({
	id: 'subscription-1',
	userId: 'user-1',
	plan: 'EASY',
	billingPeriod: 'MONTHLY',
	status,
	startsAt: new Date('2026-07-01T00:00:00.000Z'),
	expiresAt: new Date('2026-08-01T00:00:00.000Z'),
	periodResetsAt: new Date('2026-08-01T00:00:00.000Z'),
	maxWidgets: 3,
	maxLeadsPerPeriod: 100,
	unlimited: false,
	tombstoned: false,
	sourceCreatedAt: new Date('2026-07-01T00:00:00.000Z'),
	sourceOccurredAt: new Date('2026-08-01T00:00:00.000Z')
});

describe('WidgetsConfigurationService list compatibility', () => {
	it.each(
		Object.values(WidgetType).flatMap(type =>
			[EntitlementStatus.EXPIRED, EntitlementStatus.CANCELLED].map(
				status => [type, status] as const
			)
		)
	)(
		'returns existing %s items for a %s entitlement',
		async (type, status) => {
			const repository = {
				findManyForOwner: jest.fn().mockResolvedValue([])
			};
			const quota = {
				readSnapshot: jest.fn().mockResolvedValue({
					entitlement: entitlement(status),
					counter: { leadCount: 7 }
				}),
				snapshot: jest.fn()
			};
			const service = new WidgetsConfigurationService(
				repository as never,
				{} as never,
				quota as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never
			);

			await expect(service.list(type, 'user-1')).resolves.toEqual({
				[getWidgetDefinition(type).responseCollection]: [],
				subscription: expect.objectContaining({
					status,
					leadsThisPeriod: 7
				})
			});
			expect(quota.readSnapshot).toHaveBeenCalledWith('user-1');
			expect(quota.snapshot).not.toHaveBeenCalled();
		}
	);

	it.each(Object.values(WidgetType))(
		'returns existing %s items when the entitlement projection is incomplete',
		async type => {
			const repository = {
				findManyForOwner: jest.fn().mockResolvedValue([])
			};
			const quota = {
				readSnapshot: jest.fn().mockResolvedValue({
					entitlement: null,
					counter: null
				})
			};
			const service = new WidgetsConfigurationService(
				repository as never,
				{} as never,
				quota as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never
			);

			await expect(service.list(type, 'user-1')).resolves.toEqual({
				[getWidgetDefinition(type).responseCollection]: [],
				subscription: null
			});
		}
	);
});
