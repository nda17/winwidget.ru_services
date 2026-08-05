import { BadRequestException } from '@nestjs/common';
import { WidgetType } from '../domain/widgets-domain.types';
import type {
	WidgetsOwnerDirectoryItem,
	WidgetsOwnerSearchResult
} from '../internal/core-internal.client';
import { WidgetsAdminMonitoringService } from './widgets-admin-monitoring.service';

const owner = (
	overrides: Partial<WidgetsOwnerDirectoryItem> = {}
): WidgetsOwnerDirectoryItem => ({
	id: 'user-1',
	name: 'Owner',
	status: 'ACTIVE',
	deletedAt: null,
	rights: ['USER'],
	email: 'owner@example.test',
	phone: null,
	subscription: null,
	...overrides
});

const setup = () => {
	const repository = { client: jest.fn() };
	const core = {
		resolveOwners: jest.fn(),
		searchOwners: jest.fn()
	};
	const domain = {
		adminGet: jest.fn(),
		ownerId: jest.fn()
	};
	return {
		service: new WidgetsAdminMonitoringService(
			repository as never,
			core as never,
			domain as never
		),
		repository,
		core,
		domain
	};
};

describe('WidgetsAdminMonitoringService', () => {
	it('filters a plan through the local entitlement projection', async () => {
		const { service, core } = setup();
		const queryRows = jest.fn().mockResolvedValue({ rows: [], total: 0 });
		(service as unknown as { queryRows: typeof queryRows }).queryRows =
			queryRows;

		await expect(service.list(1, 20, { plan: 'HARD' })).resolves.toEqual({
			items: [],
			total: 0,
			page: 1,
			limit: 20,
			totalPages: 1
		});
		expect(queryRows).toHaveBeenCalledWith(
			expect.objectContaining({ plan: 'HARD' }),
			20,
			0
		);
		expect(core.searchOwners).not.toHaveBeenCalled();
	});

	it('always excludes tombstoned owners and applies a local plan predicate', () => {
		const { service } = setup();
		const where = (
			service as unknown as {
				monitoringWhere: (filters: { plan: 'HARD' }) => {
					strings: readonly string[];
				};
			}
		).monitoringWhere({ plan: 'HARD' });
		const sql = where.strings.join(' ');
		expect(sql).toContain('widgets.owner_projections');
		expect(sql).toContain('owner_projection.tombstoned = false');
		expect(sql).toContain('owner_projection.deleted_at IS NULL');
		expect(sql).toContain('widgets.entitlement_projections');
	});

	it('rejects search input that Core cannot validate', async () => {
		const { service } = setup();
		await expect(
			service.list(1, 20, { search: 'x'.repeat(201) })
		).rejects.toThrow('Поисковый запрос слишком длинный');
	});

	it('bounds owner-directory search and asks for a narrower query', async () => {
		const { service, core } = setup();
		let cursor = 0;
		core.searchOwners.mockImplementation(
			async (): Promise<WidgetsOwnerSearchResult> => {
				cursor += 1;
				return {
					items: [owner()],
					nextAfterId: `user-${String(cursor).padStart(4, '0')}`
				};
			}
		);
		const consume = jest.fn().mockResolvedValue(undefined);

		await expect(
			(
				service as unknown as {
					eachOwnerBatch: (
						search: string,
						callback: typeof consume
					) => Promise<void>;
				}
			).eachOwnerBatch('owner', consume)
		).rejects.toThrow('Поисковый запрос слишком широкий');
		expect(core.searchOwners).toHaveBeenCalledTimes(100);
		expect(consume).toHaveBeenCalledTimes(100);
	});

	it('preserves the legacy detail error for a deleted owner', async () => {
		const { service, core, domain } = setup();
		domain.adminGet.mockResolvedValue({});
		domain.ownerId.mockResolvedValue('user-deleted');
		core.resolveOwners.mockResolvedValue([
			owner({
				id: 'user-deleted',
				status: 'DELETED',
				deletedAt: '2026-08-04T12:00:00.000Z'
			})
		]);

		await expect(
			service.get(WidgetType.WHEEL, 'widget-1')
		).rejects.toEqual(
			expect.objectContaining({
				constructor: BadRequestException,
				message: 'Сначала восстановите удалённого владельца виджета'
			})
		);
	});

	it('builds admin alerts from Widgets-owned tables and entitlement projection', async () => {
		const { service, repository } = setup();
		const queryRaw = jest.fn().mockResolvedValue([
			{
				alertType: 'ACTIVE_WIDGET_WITHOUT_ACCESS',
				widgetType: WidgetType.WHEEL,
				id: 'widget-1',
				ownerId: 'user-1',
				name: 'Летняя акция',
				installDomain: 'example.test',
				updatedAt: new Date('2026-08-05T12:00:00.000Z')
			}
		]);
		repository.client.mockReturnValue({ $queryRaw: queryRaw });

		await expect(service.adminAlerts()).resolves.toEqual({
			items: [
				{
					type: 'ACTIVE_WIDGET_WITHOUT_ACCESS',
					severity: 'HIGH',
					referenceId: 'widget-1',
					ownerId: 'user-1',
					title: 'Активный виджет без права доступа',
					message:
						'Колесо "Летняя акция" активен, но у владельца нет активной подписки',
					alertAt: '2026-08-05T12:00:00.000Z'
				}
			]
		});
		const sql = queryRaw.mock.calls[0][0].strings.join(' ');
		expect(sql).toContain('widgets.entitlement_projections');
		expect(sql).toContain('entitlement.tombstoned = false');
		expect(sql).toContain('HAVING COUNT(DISTINCT user_id) > 1');
		expect(sql).not.toContain('COUNT(l.id)');
	});

	it('returns usage for every requested owner in stable input order', async () => {
		const { service, repository } = setup();
		const findMany = jest.fn().mockResolvedValue([
			{
				userId: 'user-2',
				widgetCount: 3,
				leadCount: 8,
				leadPeriodKey: '2026-08',
				leadPeriodStartsAt: new Date('2026-08-01T00:00:00.000Z'),
				leadPeriodEndsAt: new Date('2026-09-01T00:00:00.000Z')
			}
		]);
		repository.client.mockReturnValue({
			widgetUsageCounter: { findMany }
		});

		await expect(
			service.ownerUsage(['user-1', 'user-2'])
		).resolves.toEqual({
			items: [
				{
					userId: 'user-1',
					widgetCount: 0,
					leadCount: 0,
					periodKey: null,
					periodStartsAt: null,
					periodEndsAt: null
				},
				{
					userId: 'user-2',
					widgetCount: 3,
					leadCount: 8,
					periodKey: '2026-08',
					periodStartsAt: '2026-08-01T00:00:00.000Z',
					periodEndsAt: '2026-09-01T00:00:00.000Z'
				}
			]
		});
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { userId: { in: ['user-1', 'user-2'] } }
			})
		);
	});

	it('includes the service-owned usage counter in owner overview', async () => {
		const { service, repository } = setup();
		const client = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			$transaction: jest.fn((queries: Promise<unknown>[]) =>
				Promise.all(queries)
			),
			widgetUsageCounter: {
				findUnique: jest.fn().mockResolvedValue({
					userId: 'user-1',
					widgetCount: 1,
					leadCount: 4,
					leadPeriodKey: '2026-08',
					leadPeriodStartsAt: new Date('2026-08-01T00:00:00.000Z'),
					leadPeriodEndsAt: new Date('2026-09-01T00:00:00.000Z')
				})
			}
		};
		repository.client.mockReturnValue(client);

		await expect(service.ownerOverview('user-1')).resolves.toMatchObject({
			usage: {
				widgetCount: 1,
				leadCount: 4,
				periodKey: '2026-08',
				periodStartsAt: '2026-08-01T00:00:00.000Z',
				periodEndsAt: '2026-09-01T00:00:00.000Z'
			}
		});
		expect(client.widgetUsageCounter.findUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { userId: 'user-1' } })
		);
	});
});
