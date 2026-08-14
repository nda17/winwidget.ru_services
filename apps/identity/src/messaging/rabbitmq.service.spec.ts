import { DESTINATION_QUEUE } from './messaging.constants';
import { IdentityRabbitMqService } from './rabbitmq.service';

describe('Identity RabbitMQ ownership topology', () => {
	it('reasserts the legacy main queue with durable-only arguments', async () => {
		const channel = {
			assertExchange: jest.fn(),
			assertQueue: jest.fn(),
			bindQueue: jest.fn()
		};
		const service = new IdentityRabbitMqService(
			{} as any,
			{ workerEnabled: true } as any
		);
		await (service as any).assertTopology(channel);
		const declaration = channel.assertQueue.mock.calls.find(
			call => call[0] === DESTINATION_QUEUE
		);
		expect(declaration).toEqual([DESTINATION_QUEUE, { durable: true }]);
	});
});
