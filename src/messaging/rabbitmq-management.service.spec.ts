import {
	BILLING_OWNED_QUEUE_NAMES,
	getMessagingQueueHealthExpectations,
	MESSAGING_QUEUE_NAMES
} from '@/messaging/messaging.constants';
import { RabbitMqManagementService } from '@/messaging/rabbitmq-management.service';
import type { ConfigService } from '@nestjs/config';

describe('RabbitMqManagementService', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('returns every current messaging queue namespace and its technical queues', async () => {
		const billingQueues = getMessagingQueueHealthExpectations({
			billingOwner: true
		})
			.filter(expectation =>
				BILLING_OWNED_QUEUE_NAMES.some(
					queue =>
						expectation.name === queue ||
						expectation.name.startsWith(`${queue}.`)
				)
			)
			.map(expectation => expectation.name);
		const knownQueues = [
			MESSAGING_QUEUE_NAMES.email,
			MESSAGING_QUEUE_NAMES['campaign-email'],
			`${MESSAGING_QUEUE_NAMES['campaign-email']}.retry-v2.1`,
			`${MESSAGING_QUEUE_NAMES['notification-delivery-outcome']}.dead-letter`,
			'winwidget.notification.daily-summary.telegram',
			'winwidget.notification.daily-summary.telegram.retry.1',
			'winwidget.notification.daily-summary.telegram.dead-letter',
			'winwidget.campaigns.snapshot',
			'winwidget.campaigns.snapshot.retry.1',
			'winwidget.campaigns.snapshot.dead-letter',
			'winwidget.campaigns.delivery-outcome.v2',
			'winwidget.campaigns.delivery-outcome.v2.retry.1',
			'winwidget.reporting.delivery-outcome',
			'winwidget.reporting.delivery-outcome.dead-letter',
			'winwidget.widgets.identity-user',
			'winwidget.widgets.identity-user.retry.1',
			'winwidget.widgets.billing-subscription',
			'winwidget.widgets.billing-subscription.dead-letter',
			...billingQueues
		];
		expect(MESSAGING_QUEUE_NAMES['billing-offer-source']).toBe(
			'winwidget.billing.offer.v2'
		);
		expect(billingQueues).toContain('winwidget.billing.offer.v2');
		expect(
			billingQueues.some(queue =>
				queue.startsWith('winwidget.billing.offer.v1')
			)
		).toBe(false);
		expect(billingQueues).toHaveLength(40);
		const queues = [
			...knownQueues.map(name => ({
				name,
				messages: 0,
				messages_ready: 0,
				messages_unacknowledged: 0,
				consumers: 1
			})),
			{
				name: 'winwidget.notification.unknown',
				messages: 0,
				messages_ready: 0,
				messages_unacknowledged: 0,
				consumers: 0
			}
		];
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
			ok: true,
			json: jest.fn().mockResolvedValue(queues)
		} as unknown as Response);
		const config = {
			get: jest.fn((key: string) => {
				const values: Record<string, string> = {
					RABBITMQ_MANAGEMENT_URL: 'http://127.0.0.1:15672',
					RABBITMQ_MONITOR_USER: 'monitor',
					RABBITMQ_MONITOR_PASSWORD: 'password',
					RABBITMQ_VHOST: 'winwidget'
				};
				return values[key];
			})
		} as unknown as ConfigService;
		const service = new RabbitMqManagementService(config);

		const result = await service.getMessagingQueues();

		expect(result.map(queue => queue.name)).toEqual(
			[...knownQueues].sort((left, right) => left.localeCompare(right))
		);
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:15672/api/queues/winwidget',
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: `Basic ${Buffer.from('monitor:password').toString('base64')}`
				})
			})
		);
	});
});
