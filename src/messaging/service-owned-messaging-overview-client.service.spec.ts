import {
	BadGatewayException,
	ServiceUnavailableException
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
	CAMPAIGNS_MESSAGING_HEARTBEAT_SERVICES,
	REPORTING_MESSAGING_HEARTBEAT_SERVICES,
	ServiceOwnedMessagingOverviewClientService
} from './service-owned-messaging-overview-client.service';

const CAMPAIGNS_TOKEN =
	'campaigns-core-overview-token-at-least-32-characters';
const REPORTING_TOKEN =
	'reporting-core-overview-token-at-least-32-characters';
const NOW = '2026-08-15T12:00:00.000Z';

const overview = (services: readonly string[]) => ({
	schemaVersion: 1,
	generatedAt: NOW,
	outbox: { PENDING: 1, PUBLISHING: 2, PUBLISHED: 3, FAILED: 4 },
	oldestPendingAt: null,
	unresolvedFailures: 5,
	retryingFailures: 6,
	processedLast24Hours: 7,
	heartbeats: services.map(service => ({
		service,
		status: 'ok',
		activeInstances: 1,
		lastSeenAt: NOW
	}))
});

const createClient = (
	overrides: Partial<
		Record<'CAMPAIGNS_INTERNAL_TOKEN' | 'REPORTING_INTERNAL_TOKEN', string>
	> = {}
) => {
	const values = {
		CAMPAIGNS_INTERNAL_TOKEN: CAMPAIGNS_TOKEN,
		REPORTING_INTERNAL_TOKEN: REPORTING_TOKEN,
		...overrides
	};
	return new ServiceOwnedMessagingOverviewClientService({
		get: jest.fn((key: keyof typeof values) => values[key])
	} as unknown as ConfigService);
};

describe('ServiceOwnedMessagingOverviewClientService', () => {
	afterEach(() => jest.restoreAllMocks());

	it.each([
		{
			owner: 'Campaigns',
			request: (client: ServiceOwnedMessagingOverviewClientService) =>
				client.getCampaignsOverview(),
			url: 'http://127.0.0.1:4500/internal/v1/campaigns/messaging/overview',
			token: CAMPAIGNS_TOKEN,
			services: CAMPAIGNS_MESSAGING_HEARTBEAT_SERVICES
		},
		{
			owner: 'Reporting',
			request: (client: ServiceOwnedMessagingOverviewClientService) =>
				client.getReportingOverview(),
			url: 'http://127.0.0.1:4600/internal/v1/reporting/messaging/overview',
			token: REPORTING_TOKEN,
			services: REPORTING_MESSAGING_HEARTBEAT_SERVICES
		}
	])(
		'uses the exact loopback path and scoped token for $owner',
		async ({ request, url, token, services }) => {
			const body = overview(services);
			const fetchMock = jest
				.spyOn(global, 'fetch')
				.mockResolvedValue(
					new Response(JSON.stringify(body), { status: 200 })
				);

			await expect(request(createClient())).resolves.toEqual(body);
			expect(fetchMock).toHaveBeenCalledWith(
				url,
				expect.objectContaining({
					redirect: 'error',
					headers: expect.objectContaining({
						'x-winwidget-service': 'core',
						'x-winwidget-internal-token': token
					})
				})
			);
		}
	);

	it.each([
		{
			name: 'an extra root field',
			mutate: (body: Record<string, unknown>) => {
				body.unexpected = true;
			}
		},
		{
			name: 'a missing required heartbeat',
			mutate: (body: Record<string, unknown>) => {
				(body.heartbeats as unknown[]).pop();
			}
		},
		{
			name: 'an ok heartbeat without live evidence',
			mutate: (body: Record<string, unknown>) => {
				const heartbeat = (
					body.heartbeats as Array<Record<string, unknown>>
				)[0];
				heartbeat.lastSeenAt = null;
			}
		}
	])('rejects $name', async ({ mutate }) => {
		const body = overview(CAMPAIGNS_MESSAGING_HEARTBEAT_SERVICES);
		mutate(body);
		jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify(body), { status: 200 })
			);

		await expect(
			createClient().getCampaignsOverview()
		).rejects.toBeInstanceOf(BadGatewayException);
	});

	it('checks each owner token independently and never sends an insecure token', async () => {
		const fetchMock = jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(
				new Response(
					JSON.stringify(overview(CAMPAIGNS_MESSAGING_HEARTBEAT_SERVICES)),
					{ status: 200 }
				)
			);
		const client = createClient({ REPORTING_INTERNAL_TOKEN: 'change_me' });

		await expect(client.getCampaignsOverview()).resolves.toMatchObject({
			processedLast24Hours: 7
		});
		await expect(client.getReportingOverview()).rejects.toBeInstanceOf(
			ServiceUnavailableException
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
