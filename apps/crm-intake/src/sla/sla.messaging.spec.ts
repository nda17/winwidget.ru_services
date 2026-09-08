import { randomUUID } from 'node:crypto';
import {
	SlaRabbit,
	SLA_EXCHANGE,
	SLA_DEAD_EXCHANGE,
	SLA_QUEUE,
	SLA_EVENT_TYPE
} from './sla.messaging';

let mockReturned = false;
let mockReturn: (value: unknown) => void;
const mockChannel = {
	on: jest.fn((event, handler) => {
		if (event === 'return') mockReturn = handler;
	}),
	once: jest.fn(),
	assertExchange: jest.fn(),
	assertQueue: jest.fn(),
	bindQueue: jest.fn(),
	prefetch: jest.fn(),
	consume: jest.fn().mockResolvedValue({ consumerTag: 'sla-only' }),
	cancel: jest.fn(),
	ack: jest.fn(),
	nack: jest.fn()
};
const mockWrapper = {
	on: jest.fn(),
	waitForConnect: jest.fn(),
	addSetup: jest.fn(async fn => fn(mockChannel)),
	close: jest.fn(),
	publish: jest.fn(async (_exchange, _route, _body, properties) => {
		if (mockReturned) mockReturn({ properties });
		return true;
	})
};
const mockConnection = {
	on: jest.fn(),
	connect: jest.fn(),
	close: jest.fn(),
	isConnected: jest.fn().mockReturnValue(true),
	createChannel: jest.fn(options => {
		void options.setup(mockChannel);
		return mockWrapper;
	})
};
jest.mock('amqp-connection-manager', () => ({
	connect: jest.fn(() => mockConnection)
}));
const event = () => ({
	schemaVersion: 1 as const,
	eventId: randomUUID(),
	jobId: randomUUID(),
	workspaceId: randomUUID(),
	generation: 1
});
describe('Intake SLA isolated confirmed messaging', () => {
	const env = process.env;
	beforeEach(() => {
		jest.clearAllMocks();
		mockReturned = false;
		process.env = {
			...env,
			CRM_INTAKE_SLA_RABBITMQ_URL: 'amqp://ci:ci@127.0.0.1/sla_test',
			CRM_INTAKE_SLA_RABBITMQ_ASSERT_TOPOLOGY: 'true'
		};
	});
	afterEach(() => {
		process.env = env;
	});
	it('declares only independent SLA queues; push consumer readiness requires its tag', async () => {
		const rabbit = new SlaRabbit();
		await rabbit.onModuleInit();
		expect(rabbit.ready(true)).toBe(false);
		await rabbit.consume(async () => undefined);
		expect(
			mockChannel.assertQueue.mock.calls.map(([name]) => name)
		).toEqual([SLA_QUEUE, `${SLA_QUEUE}.dead-letter`]);
		expect(
			mockChannel.assertExchange.mock.calls.map(([name]) => name)
		).toEqual([SLA_EXCHANGE, SLA_DEAD_EXCHANGE]);
		expect(mockChannel.consume).toHaveBeenCalledWith(
			SLA_QUEUE,
			expect.any(Function),
			{ noAck: false }
		);
		expect(rabbit.ready(true)).toBe(true);
		await rabbit.onApplicationShutdown();
	});
	it('uses confirm + mandatory-return before marking a Buffer publication successful', async () => {
		const rabbit = new SlaRabbit();
		await rabbit.onModuleInit();
		await rabbit.publish(event(), 'MAIN', 0);
		expect(mockConnection.createChannel).toHaveBeenCalledWith(
			expect.objectContaining({ confirm: true })
		);
		expect(mockWrapper.publish).toHaveBeenCalledWith(
			SLA_EXCHANGE,
			SLA_EVENT_TYPE,
			expect.any(Buffer),
			expect.objectContaining({ mandatory: true, persistent: true })
		);
		mockReturned = true;
		await expect(rabbit.publish(event(), 'MAIN', 0)).rejects.toThrow(
			'MANDATORY_RETURN'
		);
		await expect(rabbit.publish(event(), 'RETRY_1', 1)).rejects.toThrow(
			'INVALID_ROUTE'
		);
		await rabbit.onApplicationShutdown();
	});
	it('does not borrow the existing Intake RabbitMQ principal if SLA credentials are absent', async () => {
		delete process.env.CRM_INTAKE_SLA_RABBITMQ_URL;
		process.env.CRM_INTAKE_RABBITMQ_URL =
			'amqp://ci:ci@127.0.0.1/acceptance';
		await expect(new SlaRabbit().onModuleInit()).rejects.toThrow(
			'CRM_INTAKE_SLA_RABBITMQ_URL must be configured'
		);
	});
});
