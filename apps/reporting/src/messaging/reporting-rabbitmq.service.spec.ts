import {
	REPORTING_ACCEPTED_ROUTING_KEYS,
	REPORTING_DEAD_LETTER_EXCHANGE,
	REPORTING_EVENTS_EXCHANGE,
	REPORTING_MANUAL_RETRY_EXCHANGE,
	REPORTING_QUEUE_NAMES,
	REPORTING_RETRY_DELAYS_MS,
	REPORTING_RETRY_EXCHANGE
} from './reporting-messaging.constants';
import { ReportingRabbitMqService } from './reporting-rabbitmq.service';
import type { ConfirmChannel } from 'amqplib';

describe('ReportingRabbitMqService topology ownership', () => {
	it('declares only Reporting-owned exchanges and only binds shared exchanges', async () => {
		const channel = {
			assertExchange: jest.fn().mockResolvedValue(undefined),
			assertQueue: jest.fn().mockResolvedValue(undefined),
			bindQueue: jest.fn().mockResolvedValue(undefined)
		};
		const service = new ReportingRabbitMqService(
			{} as never,
			{} as never,
			{} as never
		);
		await (
			service as unknown as {
				assertTopology(channel: ConfirmChannel): Promise<void>;
			}
		).assertTopology(channel as unknown as ConfirmChannel);

		expect(channel.assertExchange).toHaveBeenCalledWith(
			REPORTING_RETRY_EXCHANGE,
			'direct',
			{ durable: true }
		);
		expect(channel.assertExchange).toHaveBeenCalledWith(
			REPORTING_MANUAL_RETRY_EXCHANGE,
			'direct',
			{ durable: true }
		);
		expect(channel.assertExchange).not.toHaveBeenCalledWith(
			REPORTING_EVENTS_EXCHANGE,
			expect.anything(),
			expect.anything()
		);
		expect(channel.assertExchange).not.toHaveBeenCalledWith(
			REPORTING_DEAD_LETTER_EXCHANGE,
			expect.anything(),
			expect.anything()
		);
		expect(channel.bindQueue).toHaveBeenCalledWith(
			expect.any(String),
			REPORTING_EVENTS_EXCHANGE,
			expect.any(String)
		);

		const settingsEventBindings = channel.bindQueue.mock.calls.filter(
			([queue, exchange]) =>
				queue === REPORTING_QUEUE_NAMES.reportingSettings &&
				exchange === REPORTING_EVENTS_EXCHANGE
		);
		expect(REPORTING_ACCEPTED_ROUTING_KEYS.reportingSettings).toEqual([
			'reporting.settings.changed.v1',
			'reporting.core-operational-routing.changed.v1'
		]);
		expect(settingsEventBindings).toEqual([
			[
				REPORTING_QUEUE_NAMES.reportingSettings,
				REPORTING_EVENTS_EXCHANGE,
				'reporting.settings.changed.v1'
			],
			[
				REPORTING_QUEUE_NAMES.reportingSettings,
				REPORTING_EVENTS_EXCHANGE,
				'reporting.core-operational-routing.changed.v1'
			]
		]);
		for (const [index, delay] of REPORTING_RETRY_DELAYS_MS.entries()) {
			expect(channel.assertQueue).toHaveBeenCalledWith(
				`${REPORTING_QUEUE_NAMES.reportingSettings}.retry.${index + 1}`,
				{
					durable: true,
					messageTtl: delay,
					deadLetterExchange: REPORTING_EVENTS_EXCHANGE,
					deadLetterRoutingKey: 'reporting.settings.changed.v1'
				}
			);
		}
	});
});
