import { ConfigService } from '@nestjs/config';
import type { ChannelWrapper } from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';
import { OperationsRuntimeService } from '../runtime/operations-runtime.service';
import {
	OPERATIONS_AUDIT_DLQ_RETENTION_MS,
	OPERATIONS_AUDIT_SOURCES,
	OPERATIONS_DATABASE_RESTORE_DLQ,
	OPERATIONS_DATABASE_RESTORE_QUEUE,
	OPERATIONS_DATABASE_RESTORE_RETRY_QUEUE,
	OPERATIONS_SCHEDULED_JOB_DLQ,
	OPERATIONS_SCHEDULED_JOB_QUEUE,
	OPERATIONS_SCHEDULED_JOB_RETRY_QUEUE
} from './operations-messaging.constants';
import { OperationsRabbitMqService } from './operations-rabbitmq.service';

interface RabbitInternals {
	channel: ChannelWrapper | null;
	topologyReady: boolean;
	consumerReady: boolean;
	jobConsumerRegistered: boolean;
	jobConsumerReady: boolean;
	consumerGeneration: number;
	consumerTags: Map<string, string>;
	handleConsumerCancellation(
		channel: ConfirmChannel,
		source: (typeof OPERATIONS_AUDIT_SOURCES)[number],
		generation: number
	): void;
}

describe('OperationsRabbitMqService consumer readiness', () => {
	it('keeps seven service audit sources and no Core compatibility queue', () => {
		expect(OPERATIONS_AUDIT_SOURCES.map(source => source.source)).toEqual([
			'campaigns',
			'reporting',
			'widgets',
			'billing',
			'identity',
			'platform',
			'support'
		]);
		expect(OPERATIONS_AUDIT_DLQ_RETENTION_MS).toBe(604_800_000);
	});
	it('passively verifies privileged topology without binding queues', async () => {
		const service = new OperationsRabbitMqService(
			{} as ConfigService,
			{
				rabbitEnabled: true,
				workerEnabled: true
			} as OperationsRuntimeService
		);
		const checkExchange = jest.fn().mockResolvedValue(undefined);
		const checkQueue = jest.fn().mockResolvedValue(undefined);
		const assertExchange = jest.fn();
		const assertQueue = jest.fn();
		const bindQueue = jest.fn();
		const channel = {
			checkExchange,
			checkQueue,
			assertExchange,
			assertQueue,
			bindQueue,
			prefetch: jest.fn().mockResolvedValue(undefined)
		} as unknown as ConfirmChannel;
		(service as unknown as RabbitInternals).channel = {
			addSetup: jest.fn(async setup => setup(channel))
		} as unknown as ChannelWrapper;

		await service.prepareAuditTopology();

		expect(checkExchange.mock.calls.map(([exchange]) => exchange)).toEqual(
			[
				'winwidget.events',
				'winwidget.retry',
				'winwidget.dead-letter',
				'winwidget.manual-retry'
			]
		);
		expect(checkQueue).toHaveBeenCalledTimes(
			OPERATIONS_AUDIT_SOURCES.length * 3
		);
		expect(assertExchange).not.toHaveBeenCalled();
		expect(assertQueue).not.toHaveBeenCalled();
		expect(bindQueue).not.toHaveBeenCalled();
	});

	it('gives the restore-worker only the database restore queue family', async () => {
		const service = new OperationsRabbitMqService(
			{} as ConfigService,
			{
				rabbitEnabled: true,
				workerEnabled: false,
				restoreWorkerEnabled: true
			} as OperationsRuntimeService
		);
		const checkQueue = jest.fn().mockResolvedValue(undefined);
		const consume = jest
			.fn()
			.mockResolvedValue({ consumerTag: 'restore-worker-consumer' });
		const prefetch = jest.fn().mockResolvedValue(undefined);
		const channel = {
			checkQueue,
			consume,
			prefetch
		} as unknown as ConfirmChannel;
		const internal = service as unknown as RabbitInternals;
		internal.topologyReady = true;
		internal.channel = {
			addSetup: jest.fn(async setup => setup(channel))
		} as unknown as ChannelWrapper;

		await service.consumeDatabaseRestoreJobs(async () => 'ack');

		expect(checkQueue.mock.calls.map(([queue]) => queue)).toEqual([
			OPERATIONS_DATABASE_RESTORE_QUEUE,
			OPERATIONS_DATABASE_RESTORE_RETRY_QUEUE,
			OPERATIONS_DATABASE_RESTORE_DLQ
		]);
		expect(checkQueue).not.toHaveBeenCalledWith(
			OPERATIONS_SCHEDULED_JOB_QUEUE
		);
		expect(checkQueue).not.toHaveBeenCalledWith(
			OPERATIONS_SCHEDULED_JOB_RETRY_QUEUE
		);
		expect(checkQueue).not.toHaveBeenCalledWith(
			OPERATIONS_SCHEDULED_JOB_DLQ
		);
		expect(prefetch).toHaveBeenCalledWith(1);
		expect(service.isReady()).toBe(true);
	});

	it('keeps the worker publish path away from events and manual retry', async () => {
		const service = new OperationsRabbitMqService(
			{} as ConfigService,
			{
				rabbitEnabled: true,
				workerEnabled: true
			} as OperationsRuntimeService
		);
		const publish = jest.fn();
		(service as unknown as RabbitInternals).channel = {
			publish
		} as unknown as ChannelWrapper;

		for (const exchange of [
			'winwidget.events',
			'winwidget.manual-retry'
		]) {
			await expect(
				service.publish(exchange, 'forbidden', { eventId: 'event-1' })
			).rejects.toThrow(
				'RabbitMQ exchange is not allowed for the Operations worker'
			);
		}
		expect(publish).not.toHaveBeenCalled();
	});

	it('fails readiness and reopens the channel after broker cancellation', async () => {
		const service = new OperationsRabbitMqService(
			{} as ConfigService,
			{
				rabbitEnabled: true,
				workerEnabled: true
			} as OperationsRuntimeService
		);
		const internal = service as unknown as RabbitInternals;
		internal.topologyReady = true;
		internal.consumerReady = true;
		internal.consumerGeneration = 3;
		for (const source of OPERATIONS_AUDIT_SOURCES) {
			internal.consumerTags.set(
				source.source,
				`consumer-${source.source}`
			);
		}
		const channel = {
			close: jest.fn().mockResolvedValue(undefined)
		} as unknown as ConfirmChannel;

		internal.handleConsumerCancellation(
			channel,
			OPERATIONS_AUDIT_SOURCES[0],
			3
		);

		expect(service.isReady()).toBe(false);
		expect(internal.consumerTags.size).toBe(
			OPERATIONS_AUDIT_SOURCES.length - 1
		);
		expect(channel.close).toHaveBeenCalledTimes(1);
	});

	it('ignores cancellation callbacks from an obsolete channel generation', () => {
		const service = new OperationsRabbitMqService(
			{} as ConfigService,
			{
				rabbitEnabled: true,
				workerEnabled: true
			} as OperationsRuntimeService
		);
		const internal = service as unknown as RabbitInternals;
		internal.topologyReady = true;
		internal.consumerReady = true;
		internal.consumerGeneration = 4;
		const channel = { close: jest.fn() } as unknown as ConfirmChannel;

		internal.handleConsumerCancellation(
			channel,
			OPERATIONS_AUDIT_SOURCES[0],
			3
		);

		expect(service.isReady()).toBe(true);
		expect(channel.close).not.toHaveBeenCalled();
	});
});
