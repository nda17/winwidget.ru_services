import { SubscriptionController } from './subscription.controller';

describe('SubscriptionController Widgets usage projection', () => {
	const subscriptionService = {
		checkAndResetPeriod: jest.fn(),
		getOrCreateTrialSubscription: jest.fn(),
		adminGetAllSubscriptions: jest.fn()
	};
	const widgetsAdminOverviewClient = {
		getOwnerUsage: jest.fn()
	};
	const controller = new SubscriptionController(
		subscriptionService as never,
		{} as never,
		{} as never,
		widgetsAdminOverviewClient as never
	);

	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('returns service-owned lead usage for the existing subscription shape', async () => {
		subscriptionService.checkAndResetPeriod.mockResolvedValue({
			id: 'subscription-1',
			userId: 'user-1',
			leadsThisPeriod: 999
		});
		widgetsAdminOverviewClient.getOwnerUsage.mockResolvedValue([
			{
				userId: 'user-1',
				widgetCount: 2,
				leadCount: 7,
				periodKey: 'period-1',
				periodStartsAt: null,
				periodEndsAt: null
			}
		]);

		await expect(controller.getMySubscription('user-1')).resolves.toEqual({
			id: 'subscription-1',
			userId: 'user-1',
			leadsThisPeriod: 7
		});
		expect(
			subscriptionService.getOrCreateTrialSubscription
		).not.toHaveBeenCalled();
		expect(widgetsAdminOverviewClient.getOwnerUsage).toHaveBeenCalledWith([
			'user-1'
		]);
	});

	it('reads Widgets usage after creating a missing trial subscription', async () => {
		subscriptionService.checkAndResetPeriod.mockResolvedValue(null);
		subscriptionService.getOrCreateTrialSubscription.mockResolvedValue({
			id: 'trial-1',
			userId: 'user-1',
			leadsThisPeriod: 0
		});
		widgetsAdminOverviewClient.getOwnerUsage.mockResolvedValue([
			{
				userId: 'user-1',
				widgetCount: 0,
				leadCount: 0,
				periodKey: null,
				periodStartsAt: null,
				periodEndsAt: null
			}
		]);

		await expect(controller.getMySubscription('user-1')).resolves.toEqual({
			id: 'trial-1',
			userId: 'user-1',
			leadsThisPeriod: 0
		});
	});

	it('replaces stale counters for an admin subscription page in one bounded call', async () => {
		subscriptionService.adminGetAllSubscriptions.mockResolvedValue({
			items: [
				{ id: 'subscription-1', userId: 'user-1', leadsThisPeriod: 10 },
				{ id: 'subscription-2', userId: 'user-2', leadsThisPeriod: 20 }
			],
			total: 2,
			page: 1,
			limit: 15,
			totalPages: 1
		});
		widgetsAdminOverviewClient.getOwnerUsage.mockResolvedValue([
			{
				userId: 'user-1',
				widgetCount: 1,
				leadCount: 3,
				periodKey: null,
				periodStartsAt: null,
				periodEndsAt: null
			},
			{
				userId: 'user-2',
				widgetCount: 2,
				leadCount: 4,
				periodKey: null,
				periodStartsAt: null,
				periodEndsAt: null
			}
		]);

		const result = await controller.adminGetAll();

		expect(result.items).toEqual([
			{ id: 'subscription-1', userId: 'user-1', leadsThisPeriod: 3 },
			{ id: 'subscription-2', userId: 'user-2', leadsThisPeriod: 4 }
		]);
		expect(widgetsAdminOverviewClient.getOwnerUsage).toHaveBeenCalledWith([
			'user-1',
			'user-2'
		]);
	});

	it('does not call Widgets for an empty admin page', async () => {
		const page = {
			items: [],
			total: 0,
			page: 1,
			limit: 15,
			totalPages: 1
		};
		subscriptionService.adminGetAllSubscriptions.mockResolvedValue(page);

		await expect(controller.adminGetAll()).resolves.toBe(page);
		expect(
			widgetsAdminOverviewClient.getOwnerUsage
		).not.toHaveBeenCalled();
	});
});
