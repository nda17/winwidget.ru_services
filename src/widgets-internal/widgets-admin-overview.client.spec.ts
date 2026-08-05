import { ServiceUnavailableException } from '@nestjs/common';
import { WidgetsAdminOverviewClient } from './widgets-admin-overview.client';

describe('WidgetsAdminOverviewClient', () => {
	const originalBaseUrl = process.env.WIDGETS_INTERNAL_BASE_URL;
	const originalToken = process.env.WIDGETS_INTERNAL_TOKEN;
	const token = 'widgets-internal-test-token-with-32-characters';

	beforeEach(() => {
		process.env.WIDGETS_INTERNAL_BASE_URL = 'http://127.0.0.1:4700';
		process.env.WIDGETS_INTERNAL_TOKEN = token;
	});

	afterEach(() => {
		jest.restoreAllMocks();
		if (originalBaseUrl === undefined) {
			delete process.env.WIDGETS_INTERNAL_BASE_URL;
		} else {
			process.env.WIDGETS_INTERNAL_BASE_URL = originalBaseUrl;
		}
		if (originalToken === undefined) {
			delete process.env.WIDGETS_INTERNAL_TOKEN;
		} else {
			process.env.WIDGETS_INTERNAL_TOKEN = originalToken;
		}
	});

	it('uses only the private loopback contract and validates its shape', async () => {
		const payload = {
			widgets: {
				total: 0,
				active: 0,
				inactive: 0,
				byType: [],
				latest: []
			},
			leads: { total: 0, byType: [], latest: [] },
			usage: {
				widgetCount: 0,
				leadCount: 0,
				periodKey: null,
				periodStartsAt: null,
				periodEndsAt: null
			}
		};
		const fetchMock = jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify(payload), { status: 200 })
			);

		await expect(
			new WidgetsAdminOverviewClient().getOwnerOverview('user-1')
		).resolves.toEqual(payload);
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:4700/internal/v1/widgets/admin-owner-overview',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ userId: 'user-1' }),
				headers: expect.objectContaining({
					'x-winwidget-internal-token': token
				})
			})
		);
	});

	it.each([
		'https://127.0.0.1:4700',
		'http://widgets-service:4700',
		'http://127.0.0.1:4700/path'
	])(
		'fails closed for a non-loopback private origin: %s',
		async baseUrl => {
			process.env.WIDGETS_INTERNAL_BASE_URL = baseUrl;

			await expect(
				new WidgetsAdminOverviewClient().getOwnerOverview('user-1')
			).rejects.toBeInstanceOf(ServiceUnavailableException);
		}
	);

	it('fails closed for a malformed Widgets response', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ widgets: {}, leads: {} }), {
				status: 200
			})
		);

		await expect(
			new WidgetsAdminOverviewClient().getOwnerOverview('user-1')
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('loads and validates service-owned admin alerts', async () => {
		const payload = {
			items: [
				{
					type: 'WIDGET_INVALID_DOMAIN',
					severity: 'MEDIUM',
					referenceId: 'widget-1',
					ownerId: 'user-1',
					title: 'Некорректный домен виджета',
					message: 'Некорректный домен',
					alertAt: '2026-08-05T12:00:00.000Z'
				}
			]
		};
		const fetchMock = jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify(payload), { status: 200 })
			);

		await expect(
			new WidgetsAdminOverviewClient().getAdminAlerts()
		).resolves.toEqual(payload.items);
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:4700/api/v1/internal/v1/widgets/admin-alerts',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					'x-winwidget-internal-token': token
				})
			})
		);
	});

	it('fails closed for a malformed admin alert', async () => {
		jest.spyOn(global, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					items: [
						{
							type: 'UNKNOWN',
							severity: 'HIGH',
							referenceId: 'widget-1',
							ownerId: 'user-1',
							title: 'title',
							message: 'message',
							alertAt: '2026-08-05T12:00:00.000Z'
						}
					]
				}),
				{ status: 200 }
			)
		);

		await expect(
			new WidgetsAdminOverviewClient().getAdminAlerts()
		).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('loads a bounded owner usage batch in requested order', async () => {
		const items = [
			{
				userId: 'user-1',
				widgetCount: 2,
				leadCount: 7,
				periodKey: '2026-08',
				periodStartsAt: '2026-08-01T00:00:00.000Z',
				periodEndsAt: '2026-09-01T00:00:00.000Z'
			},
			{
				userId: 'user-2',
				widgetCount: 0,
				leadCount: 0,
				periodKey: null,
				periodStartsAt: null,
				periodEndsAt: null
			}
		];
		const fetchMock = jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ items }), { status: 200 })
			);

		await expect(
			new WidgetsAdminOverviewClient().getOwnerUsage(['user-1', 'user-2'])
		).resolves.toEqual(items);
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:4700/api/v1/internal/v1/widgets/owner-usage',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ userIds: ['user-1', 'user-2'] }),
				headers: expect.objectContaining({
					'x-winwidget-internal-token': token
				})
			})
		);
	});

	it('rejects an unbounded owner usage request before transport', async () => {
		const fetchMock = jest.spyOn(global, 'fetch');
		await expect(
			new WidgetsAdminOverviewClient().getOwnerUsage(
				Array.from({ length: 101 }, (_, index) => `user-${index}`)
			)
		).rejects.toThrow('Widgets owner usage input is invalid');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
