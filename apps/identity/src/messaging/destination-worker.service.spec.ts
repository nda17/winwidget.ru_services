import type { ConsumeMessage } from 'amqplib';
import {
	DEAD_ROUTING_KEY,
	DESTINATION_EVENT
} from './messaging.constants';
import {
	DestinationUnavailableWorkerService,
	semanticJsonHash
} from './destination-worker.service';

function message(content: string): ConsumeMessage {
	return {
		content: Buffer.from(content),
		fields: {} as ConsumeMessage['fields'],
		properties: {
			messageId: '00000000-0000-4000-8000-000000000001',
			headers: {},
			contentType: 'application/json'
		} as ConsumeMessage['properties']
	};
}

function worker() {
	const transaction = {
		consumerReceipt: {
			upsert: jest.fn(),
			createMany: jest.fn(),
			findUnique: jest.fn(),
			updateMany: jest.fn(),
			findFirst: jest.fn(),
			update: jest.fn()
		},
		consumerFailure: { upsert: jest.fn(), updateMany: jest.fn() },
		outboxEvent: { createMany: jest.fn(), create: jest.fn() },
		telegramNotificationChannel: {
			findUnique: jest.fn(),
			updateMany: jest.fn()
		}
	};
	const prisma = {
		$transaction: jest.fn(
			(callback: (tx: typeof transaction) => unknown) =>
				callback(transaction)
		)
	};
	const rabbit = {
		ack: jest.fn(),
		nack: jest.fn(),
		consume: jest.fn(),
		isConsumerReady: jest.fn().mockReturnValue(true)
	};
	const service = new DestinationUnavailableWorkerService(
		prisma as any,
		{ workerEnabled: true } as any,
		rabbit as any,
		{ emitUserChanged: jest.fn() } as any,
		{ isActive: jest.fn().mockResolvedValue(true) } as any
	);
	return { service, prisma, transaction, rabbit };
}

describe('destination unavailable consumer contract', () => {
	it('uses a stable semantic hash across key order and JSONB round-trips', () => {
		const first = {
			eventType: DESTINATION_EVENT,
			destination: { telegramChatId: '123' },
			schemaVersion: 1,
			sourceEventId: '00000000-0000-4000-8000-000000000002',
			sourceKind: 'telegram',
			normalizedCode: 'CHAT_NOT_FOUND',
			occurredAt: '2026-08-14T10:00:00.000Z'
		};
		const jsonbRoundTrip = {
			occurredAt: first.occurredAt,
			normalizedCode: first.normalizedCode,
			sourceKind: first.sourceKind,
			sourceEventId: first.sourceEventId,
			schemaVersion: first.schemaVersion,
			destination: { telegramChatId: '123' },
			eventType: first.eventType
		};
		expect(semanticJsonHash(first)).toBe(semanticJsonHash(jsonbRoundTrip));
		expect(semanticJsonHash(JSON.parse(JSON.stringify(first)))).toBe(
			semanticJsonHash(first)
		);
	});

	it.each(['not-json', JSON.stringify({ schemaVersion: 1 })])(
		'durably parks invalid payload %s and ACKs only after the DLQ outbox write',
		async body => {
			const value = worker();
			await (value.service as any).handle(message(body));
			expect(
				value.transaction.consumerFailure.upsert
			).toHaveBeenCalledWith(
				expect.objectContaining({
					create: expect.objectContaining({
						eventType: 'identity.consumer.poison.v1',
						routingKey: DEAD_ROUTING_KEY
					})
				})
			);
			expect(
				value.transaction.outboxEvent.createMany
			).toHaveBeenCalledWith(
				expect.objectContaining({
					data: [
						expect.objectContaining({
							eventType: 'identity.consumer.poison.v1',
							routingKey: DEAD_ROUTING_KEY
						})
					]
				})
			);
			expect(value.rabbit.ack).toHaveBeenCalledTimes(1);
			expect(value.rabbit.nack).not.toHaveBeenCalled();
		}
	);

	it('parks a receipt payload mismatch instead of hot-loop requeueing', async () => {
		const value = worker();
		jest
			.spyOn(value.service as any, 'claim')
			.mockRejectedValue(new Error('Consumer receipt payload mismatch'));
		const body = JSON.stringify({
			schemaVersion: 1,
			eventType: DESTINATION_EVENT,
			sourceEventId: '00000000-0000-4000-8000-000000000002',
			sourceKind: 'telegram',
			destination: { telegramChatId: '123' },
			normalizedCode: 'CHAT_NOT_FOUND',
			occurredAt: '2026-08-14T10:00:00.000Z'
		});
		await (value.service as any).handle(message(body));
		expect(value.transaction.consumerFailure.upsert).toHaveBeenCalled();
		expect(value.rabbit.ack).toHaveBeenCalledTimes(1);
		expect(value.rabbit.nack).not.toHaveBeenCalled();
	});
});
