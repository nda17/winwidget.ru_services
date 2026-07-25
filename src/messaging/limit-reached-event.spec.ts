import { enqueueEntityLimitReachedEvent } from '@/messaging/limit-reached-event';
import type { Prisma } from '@prisma/client';

describe('enqueueEntityLimitReachedEvent', () => {
	it('creates one current event per normalized destination', async () => {
		const createMany = jest.fn().mockResolvedValue({ count: 3 });
		const transaction = {
			outboxEvent: { createMany }
		} as unknown as Prisma.TransactionClient;

		await enqueueEntityLimitReachedEvent(transaction, {
			entity: { id: 'widget-1', name: 'Колесо', type: 'widget' },
			limit: 100,
			accountEmail: 'Owner@Example.com',
			integrationEmail: 'integration@example.com',
			telegramChatId: ' 123 '
		});

		expect(createMany).toHaveBeenCalledTimes(1);
		const events = (createMany as jest.Mock).mock.calls[0][0].data;
		const emailEvents = events.filter(
			event => event.eventType === 'lead.limit.reached.email.v2'
		);
		expect(emailEvents).toHaveLength(2);
		expect(
			emailEvents.map(event => event.payload.destination.email).sort()
		).toEqual(['integration@example.com', 'owner@example.com']);
		expect(emailEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					routingKey: 'lead.limit.reached.email.v2',
					payload: expect.objectContaining({
						schemaVersion: 2,
						limit: 100,
						destination: { email: expect.any(String) }
					})
				})
			])
		);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: 'lead.limit.reached.telegram.v2',
					routingKey: 'lead.limit.reached.telegram.v2',
					payload: expect.objectContaining({
						destination: { telegramChatId: '123' }
					})
				})
			])
		);
		for (const event of events) {
			expect(event.messageId).toBe(event.id);
			expect(event.headers).toEqual(
				expect.objectContaining({
					'x-correlation-id': event.id,
					'x-request-id': event.id
				})
			);
		}
	});
});
