import type { Prisma } from '@prisma/operations-client';
import { OperationsOutboxService } from './operations-outbox.service';

describe('OperationsOutboxService', () => {
	it('requires and uses the caller transaction for dependent events', async () => {
		const created = { id: 'outbox-1' };
		const transaction = {
			outboxEvent: {
				create: jest.fn().mockResolvedValue(created)
			}
		} as unknown as Prisma.TransactionClient;
		const service = new OperationsOutboxService();
		const eventId = '3ad36f14-550c-47bd-8f69-2c913cdb83ee';

		await expect(
			service.enqueue(transaction, {
				eventId,
				eventType: 'operations.example.changed.v1',
				aggregateType: 'example',
				aggregateId: 'example-1',
				routingKey: 'operations.example.changed.v1',
				payload: { schemaVersion: 1, eventId }
			})
		).resolves.toBe(created);
		expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventId,
				messageId: eventId,
				exchange: 'winwidget.events'
			})
		});
	});
});
