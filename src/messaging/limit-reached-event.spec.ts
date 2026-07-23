import { enqueueEntityLimitReachedEvent } from '@/messaging/limit-reached-event';
import type { Prisma } from '@prisma/client';

describe('enqueueEntityLimitReachedEvent', () => {
	it('creates one fan-out event and deduplicates email destinations', async () => {
		const create = jest.fn().mockResolvedValue({ id: 'event-1' });
		const transaction = {
			outboxEvent: { create }
		} as unknown as Prisma.TransactionClient;

		await enqueueEntityLimitReachedEvent(transaction, {
			entity: { id: 'widget-1', name: 'Колесо', type: 'widget' },
			limit: 100,
			accountEmail: 'Owner@Example.com',
			integrationEmail: 'owner@example.com',
			telegramChatId: ' 123 '
		});

		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: 'lead.limit.reached.v1',
				routingKey: 'lead.limit.reached.v1',
				payload: expect.objectContaining({
					limit: 100,
					destinations: {
						emails: ['owner@example.com'],
						telegramChatId: '123'
					}
				})
			})
		});
	});
});
