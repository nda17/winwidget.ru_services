import type { ConfigService } from '@nestjs/config';
import { RabbitMqService } from './rabbitmq.service';

describe('RabbitMqService invitation topology opt-in', () => {
	it.each([undefined, 'email', 'email,wincrm-invitation-email'])(
		'asserts invitation queues only for explicit opt-in %s',
		async configuredKinds => {
			const service = new RabbitMqService({
				get: (key: string) =>
					key === 'NOTIFICATION_DELIVERY_KINDS'
						? configuredKinds
						: undefined
			} as ConfigService);
			const channel = {
				assertExchange: jest.fn(),
				assertQueue: jest.fn(),
				bindQueue: jest.fn()
			};
			await (
				service as unknown as {
					assertTopology(channel: unknown): Promise<void>;
				}
			).assertTopology(channel);
			const queues = channel.assertQueue.mock.calls.map(
				call => call[0] as string
			);
			expect(queues).toContain('winwidget.payment-notification.email');
			const invitationQueues = queues.filter(queue =>
				queue.startsWith('winwidget.notification.wincrm.invitation.email')
			);
			if (configuredKinds?.includes('wincrm-invitation-email')) {
				expect(invitationQueues).toContain(
					'winwidget.notification.wincrm.invitation.email'
				);
				expect(invitationQueues).toContain(
					'winwidget.notification.wincrm.invitation.email.dead-letter'
				);
				expect(
					invitationQueues.some(queue => queue.includes('.retry-v2.'))
				).toBe(true);
			} else expect(invitationQueues).toEqual([]);
		}
	);
});
