import { PlatformSiteSettingsService } from './site-settings.service';

describe('PlatformSiteSettingsService', () => {
	it('updates the aggregate and audit Outbox in one transaction', async () => {
		const current = {
			id: 'singleton',
			bannerEnabled: false,
			bannerText: '',
			snowflakeEnabled: false,
			updatedAt: new Date('2026-08-23T10:00:00.000Z')
		};
		const updated = {
			...current,
			bannerEnabled: true,
			updatedAt: new Date('2026-08-23T11:00:00.000Z')
		};
		const transaction = {
			$queryRaw: jest
				.fn()
				.mockResolvedValue([{ fingerprint: 'a'.repeat(64) }]),
			siteSettings: {
				findUnique: jest.fn().mockResolvedValue(current),
				update: jest.fn().mockResolvedValue(updated)
			},
			platformSourceSequence: {
				upsert: jest.fn().mockResolvedValue({ nextValue: 8n })
			},
			outboxEvent: { create: jest.fn().mockResolvedValue({}) }
		};
		const prisma = {
			$transaction: jest
				.fn()
				.mockImplementation((work: (tx: unknown) => unknown) =>
					work(transaction)
				)
		};
		const service = new PlatformSiteSettingsService(prisma as never);

		await expect(
			service.update(
				{ bannerEnabled: true },
				{
					actor: {
						active: true,
						subject: 'admin-1',
						sessionId: 'session-1',
						roles: ['ADMIN']
					}
				}
			)
		).resolves.toEqual({
			id: 'singleton',
			bannerEnabled: true,
			bannerText: '',
			snowflakeEnabled: false,
			updatedAt: '2026-08-23T11:00:00.000Z'
		});

		expect(transaction.siteSettings.update).toHaveBeenCalledWith({
			where: { id: 'singleton' },
			data: {
				bannerEnabled: true,
				aggregateVersion: { increment: 1n },
				sourceSequence: 7n
			}
		});
		expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
	});

	it('publishes canonical sorted changedFields regardless of JSON field order', async () => {
		const current = {
			id: 'singleton',
			bannerEnabled: false,
			bannerText: '',
			snowflakeEnabled: false,
			updatedAt: new Date('2026-08-23T10:00:00.000Z')
		};
		const transaction = {
			$queryRaw: jest
				.fn()
				.mockResolvedValue([{ fingerprint: 'a'.repeat(64) }]),
			siteSettings: {
				findUnique: jest.fn().mockResolvedValue(current),
				update: jest.fn().mockResolvedValue({
					...current,
					bannerEnabled: true,
					bannerText: 'notice'
				})
			},
			platformSourceSequence: {
				upsert: jest.fn().mockResolvedValue({ nextValue: 2n })
			},
			outboxEvent: { create: jest.fn().mockResolvedValue({}) }
		};
		const prisma = {
			$transaction: jest
				.fn()
				.mockImplementation((work: (tx: unknown) => unknown) =>
					work(transaction)
				)
		};
		const service = new PlatformSiteSettingsService(prisma as never);

		await service.update(
			{ bannerText: 'notice', bannerEnabled: true },
			{
				actor: {
					active: true,
					subject: 'admin-1',
					sessionId: 'session-1',
					roles: ['ADMIN']
				}
			}
		);

		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				payload: expect.objectContaining({
					section: 'PLATFORM_CONTENT',
					metadata: expect.objectContaining({
						changedFields: ['bannerEnabled', 'bannerText']
					})
				})
			})
		});
	});

	it('fails closed before audit when the database cannot refresh its semantic fingerprint', async () => {
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([]),
			siteSettings: {
				findUnique: jest.fn().mockResolvedValue({
					id: 'singleton',
					bannerEnabled: false,
					bannerText: '',
					snowflakeEnabled: false,
					updatedAt: new Date('2026-08-23T10:00:00.000Z')
				}),
				update: jest.fn().mockResolvedValue({})
			},
			platformSourceSequence: {
				upsert: jest.fn().mockResolvedValue({ nextValue: 2n })
			},
			outboxEvent: { create: jest.fn().mockResolvedValue({}) }
		};
		const prisma = {
			$transaction: jest
				.fn()
				.mockImplementation((work: (tx: unknown) => unknown) =>
					work(transaction)
				)
		};
		const service = new PlatformSiteSettingsService(prisma as never);

		await expect(
			service.update(
				{ bannerEnabled: true },
				{
					actor: {
						active: true,
						subject: 'admin-1',
						sessionId: 'session-1',
						roles: ['ADMIN']
					}
				}
			)
		).rejects.toThrow('PLATFORM_SEMANTIC_FINGERPRINT_REFRESH_FAILED');
		expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
	});
});
