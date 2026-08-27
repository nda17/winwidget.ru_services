import type { PlatformPrismaService } from '../prisma/platform-prisma.service';
import { PlatformMessagingAdminService } from './platform-messaging-admin.service';

describe('PlatformMessagingAdminService', () => {
	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
	});

	it('returns exact Outbox and two-role readiness overview', async () => {
		jest
			.useFakeTimers()
			.setSystemTime(new Date('2026-08-24T12:00:00.000Z'));
		const prisma = {
			outboxEvent: {
				groupBy: jest.fn().mockResolvedValue([
					{ status: 'PENDING', _count: { _all: 2 } },
					{ status: 'PROCESSING', _count: { _all: 1 } },
					{ status: 'PUBLISHED', _count: { _all: 7 } }
				]),
				findFirst: jest
					.fn()
					.mockResolvedValueOnce({
						availableAt: new Date('2026-08-24T11:58:00.000Z')
					})
					.mockResolvedValueOnce(null)
					.mockResolvedValueOnce(null),
				count: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1)
			}
		} as unknown as PlatformPrismaService;
		jest.spyOn(global, 'fetch').mockImplementation(async input => {
			const url = String(input);
			const role = url.includes(':5001') ? 'outbox-publisher' : 'api';
			return new Response(
				JSON.stringify({
					status: 'ready',
					service: 'platform',
					role,
					revision: 'a'.repeat(40),
					database: {
						serviceName: 'platform-service',
						databaseId: '11111111-1111-4111-8111-111111111111',
						currentSemanticFingerprint: 'b'.repeat(64),
						createdAt: '2026-08-24T10:00:00.000Z',
						updatedAt: '2026-08-24T11:00:00.000Z'
					}
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		});

		await expect(
			new PlatformMessagingAdminService(prisma).overview()
		).resolves.toEqual({
			schemaVersion: 1,
			generatedAt: '2026-08-24T12:00:00.000Z',
			outbox: { PENDING: 2, PROCESSING: 1, PUBLISHED: 7 },
			oldestPendingAt: '2026-08-24T11:58:00.000Z',
			operational: { dueOutbox: 2, staleOutbox: 1 },
			heartbeats: [
				{
					service: 'platform-api',
					status: 'ok',
					activeInstances: 1,
					lastSeenAt: '2026-08-24T12:00:00.000Z',
					revision: 'a'.repeat(40)
				},
				{
					service: 'platform-outbox-publisher',
					status: 'ok',
					activeInstances: 1,
					lastSeenAt: '2026-08-24T12:00:00.000Z',
					revision: 'a'.repeat(40)
				}
			]
		});
	});

	it('marks malformed readiness responses down without hiding Outbox data', async () => {
		const prisma = {
			outboxEvent: {
				groupBy: jest.fn().mockResolvedValue([]),
				findFirst: jest.fn().mockResolvedValue(null),
				count: jest.fn().mockResolvedValue(0)
			}
		} as unknown as PlatformPrismaService;
		jest
			.spyOn(global, 'fetch')
			.mockResolvedValue(new Response('{}', { status: 200 }));

		const overview = await new PlatformMessagingAdminService(
			prisma
		).overview();
		expect(overview.outbox).toEqual({
			PENDING: 0,
			PROCESSING: 0,
			PUBLISHED: 0
		});
		expect(overview.heartbeats).toEqual([
			expect.objectContaining({ service: 'platform-api', status: 'down' }),
			expect.objectContaining({
				service: 'platform-outbox-publisher',
				status: 'down'
			})
		]);
	});
});
