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

describe('WidgetsConfigurationService AI consultant deletion', () => {
	it('deletes the widget without invoking any lead contract', async () => {
		const widget = {
			id: 'ai-1',
			userId: 'user-1',
			publicKey: 'public-ai-1',
			name: 'AI-консультант',
			isActive: true,
			installDomain: 'example.test',
			config: {},
			draftConfig: {},
			draftInstallDomain: 'example.test',
			draftRevision: 1,
			publishedVersion: 1,
			publishedFromDraftRevision: 1,
			publishedAt: new Date('2026-08-28T00:00:00.000Z'),
			createdAt: new Date('2026-08-28T00:00:00.000Z'),
			updatedAt: new Date('2026-08-28T00:00:00.000Z')
		};
		const transaction = {
			widgetConfigRevision: {
				findMany: jest.fn().mockResolvedValue([]),
				deleteMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			widgetRuntimeDailyStepMetric: {
				deleteMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			widgetRuntimeDailyMetric: {
				deleteMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			widgetRuntimePresence: {
				deleteMany: jest.fn().mockResolvedValue({ count: 0 })
			}
		};
		const repository = {
			allLeadsInTransaction: jest.fn(),
			delete: jest.fn().mockResolvedValue(widget)
		};
		const access = {
			assertOwnerCanModify: jest.fn().mockResolvedValue(undefined),
			owned: jest.fn().mockResolvedValue(widget)
		};
		const quota = {
			withWidgetDeletion: jest.fn(
				async (
					_userId: string,
					_input: unknown,
					operation: (client: unknown) => Promise<{ value: unknown }>
				) => (await operation(transaction)).value
			)
		};
		const reporting = {
			enqueueLead: jest.fn(),
			enqueueWidget: jest.fn().mockResolvedValue(undefined),
			widgetAggregateType: jest
				.fn()
				.mockReturnValue('widgets.widget.aiConsultant'),
			aggregateId: jest.fn().mockReturnValue('aiConsultant:ai-1')
		};
		const images = {
			isManaged: jest.fn().mockReturnValue(false),
			delete: jest.fn()
		};
		const service = new WidgetsConfigurationService(
			repository as never,
			access as never,
			quota as never,
			reporting as never,
			{} as never,
			images as never,
			{} as never,
			{} as never
		);

		await expect(
			service.delete(
				WidgetType.AI_CONSULTANT,
				widget.id,
				widget.userId,
				'correlation-1'
			)
		).resolves.toBe(widget);
		expect(repository.allLeadsInTransaction).not.toHaveBeenCalled();
		expect(reporting.enqueueLead).not.toHaveBeenCalled();
		expect(repository.delete).toHaveBeenCalledWith(
			WidgetType.AI_CONSULTANT,
			widget.id,
			transaction
		);
		expect(reporting.enqueueWidget).toHaveBeenCalledWith(
			transaction,
			WidgetType.AI_CONSULTANT,
			widget,
			true,
			'correlation-1'
		);
	});
});
