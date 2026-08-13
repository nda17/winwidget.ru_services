import type { BillingPrismaService } from '../prisma/billing-prisma.service';
import { BillingMessagingAdminService } from './billing-messaging-admin.service';

describe('BillingMessagingAdminService overview', () => {
	const originalFetch = global.fetch;

	const createService = () =>
		new BillingMessagingAdminService({
			outboxEvent: {
				groupBy: jest.fn().mockResolvedValue([]),
				findFirst: jest.fn().mockResolvedValue(null),
				count: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1)
			},
			integrationDeliveryFailure: {
				count: jest.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(1),
				groupBy: jest.fn().mockResolvedValue([
					{
						category: 'TRANSIENT',
						normalizedCode: 'PROVIDER_TIMEOUT',
						_count: { _all: 2 }
					},
					{
						category: null,
						normalizedCode: null,
						_count: { _all: 1 }
					}
				])
			},
			integrationDeliveryReceipt: {
				count: jest.fn().mockResolvedValue(0)
			}
		} as unknown as BillingPrismaService);

	afterEach(() => {
		global.fetch = originalFetch;
		jest.restoreAllMocks();
	});

	it('publishes readiness for all four Billing process roles', async () => {
		const rolesByPort: Record<string, string> = {
			'4800': 'api',
			'4801': 'scheduler',
			'4802': 'worker',
			'4803': 'outbox-publisher'
		};
		global.fetch = jest.fn(async input => {
			const url = new URL(String(input));
			return {
				ok: true,
				json: jest.fn().mockResolvedValue({
					status: 'ready',
					service: 'billing',
					role: rolesByPort[url.port],
					revision: 'a'.repeat(40),
					...(url.port === '4802' ? { providers: { yookassa: true } } : {})
				})
			} as unknown as Response;
		});

		await expect(createService().overview()).resolves.toMatchObject({
			schemaVersion: 1,
			unresolvedFailures: 3,
			retryingFailures: 1,
			operational: {
				dueOutbox: 2,
				staleOutbox: 1,
				unresolvedFailuresByCategory: {
					TRANSIENT: 2,
					RATE_LIMIT: 0,
					PERMANENT: 0,
					AUTH_CONFIGURATION: 0,
					UNCLASSIFIED: 1
				}
			},
			providers: { yookassa: true },
			heartbeats: [
				{
					service: 'billing-api',
					status: 'ok',
					activeInstances: 1,
					lastSeenAt: expect.any(String),
					revision: 'a'.repeat(40)
				},
				{
					service: 'billing-scheduler',
					status: 'ok'
				},
				{
					service: 'billing-worker',
					status: 'ok'
				},
				{
					service: 'billing-outbox-publisher',
					status: 'ok'
				}
			]
		});
		expect(global.fetch).toHaveBeenCalledTimes(4);
	});

	it('accepts an older worker readiness while omitting provider state', async () => {
		const rolesByPort: Record<string, string> = {
			'4800': 'api',
			'4801': 'scheduler',
			'4802': 'worker',
			'4803': 'outbox-publisher'
		};
		global.fetch = jest.fn(async input => {
			const url = new URL(String(input));
			return {
				ok: true,
				json: jest.fn().mockResolvedValue({
					status: 'ready',
					service: 'billing',
					role: rolesByPort[url.port],
					revision: 'a'.repeat(40)
				})
			} as unknown as Response;
		});

		const overview = await createService().overview();

		expect(overview).not.toHaveProperty('providers');
		expect(
			overview.heartbeats.find(item => item.service === 'billing-worker')
		).toMatchObject({ status: 'ok', activeInstances: 1 });
	});

	it('marks only the unavailable role down without exposing probe errors', async () => {
		global.fetch = jest.fn(async input => {
			const url = new URL(String(input));
			if (url.port === '4802') throw new Error('secret transport detail');
			const rolesByPort: Record<string, string> = {
				'4800': 'api',
				'4801': 'scheduler',
				'4803': 'outbox-publisher'
			};
			return {
				ok: true,
				json: jest.fn().mockResolvedValue({
					status: 'ready',
					service: 'billing',
					role: rolesByPort[url.port],
					revision: 'a'.repeat(40)
				})
			} as unknown as Response;
		});

		const overview = await createService().overview();

		expect(
			overview.heartbeats.find(item => item.service === 'billing-worker')
		).toEqual({
			service: 'billing-worker',
			status: 'down',
			activeInstances: 0,
			lastSeenAt: null,
			revision: null
		});
		expect(JSON.stringify(overview)).not.toContain(
			'secret transport detail'
		);
	});
});
