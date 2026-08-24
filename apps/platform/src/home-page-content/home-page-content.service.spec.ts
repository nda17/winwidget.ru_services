import { PlatformHomePageContentService } from './home-page-content.service';

describe('PlatformHomePageContentService', () => {
	it('updates only DEV raw code while preserving structured content and auditing', async () => {
		const currentContent = {
			hero: { title: 'kept' },
			head: { enabled: false, html: '' },
			body: { enabled: false, html: '' }
		};
		const expectedContent = {
			...currentContent,
			head: { enabled: true, html: '<meta name="test" content="ok">' },
			body: { enabled: true, html: '<script src="/trusted.js"></script>' }
		};
		const transaction = {
			$queryRaw: jest
				.fn()
				.mockResolvedValue([{ fingerprint: 'a'.repeat(64) }]),
			homePageContent: {
				findUnique: jest.fn().mockResolvedValue({
					id: 'singleton',
					content: currentContent,
					updatedAt: new Date('2026-08-23T10:00:00.000Z')
				}),
				update: jest.fn().mockResolvedValue({
					id: 'singleton',
					content: expectedContent,
					updatedAt: new Date('2026-08-23T11:00:00.000Z')
				})
			},
			platformSourceSequence: {
				upsert: jest.fn().mockResolvedValue({ nextValue: 13n })
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
		const service = new PlatformHomePageContentService(prisma as never);

		const result = await service.updateRaw(
			{
				content: {
					head: expectedContent.head,
					body: expectedContent.body
				}
			},
			{
				actor: {
					active: true,
					subject: 'dev-1',
					sessionId: 'session-1',
					roles: ['DEV']
				}
			}
		);

		expect(transaction.homePageContent.update).toHaveBeenCalledWith({
			where: { id: 'singleton' },
			data: {
				content: expectedContent,
				aggregateVersion: { increment: 1n },
				sourceSequence: 12n
			}
		});
		expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			id: 'singleton',
			content: expectedContent,
			updatedAt: '2026-08-23T11:00:00.000Z'
		});
	});
});
