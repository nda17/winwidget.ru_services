import { enqueueLeadIntegrationEvents } from '@/messaging/lead-integration-event';
import {
	INTEGRATION_ROUTING_KEYS,
	LEAD_INTEGRATION_KINDS
} from '@/messaging/messaging.constants';
import type { Prisma } from '@prisma/client';

describe('enqueueLeadIntegrationEvents', () => {
	it('creates one outbox event for every configured integration', async () => {
		const createMany = jest.fn().mockResolvedValue({ count: 5 });
		const createSnapshots = jest.fn().mockResolvedValue({ count: 3 });
		const transaction = {
			outboxEvent: { createMany },
			integrationCredentialSnapshot: { createMany: createSnapshots }
		} as unknown as Prisma.TransactionClient;
		const createdAt = new Date('2026-07-23T12:00:00.000Z');

		await enqueueLeadIntegrationEvents(transaction, {
			source: 'widget',
			entity: { id: 'widget-1', name: 'Колесо' },
			lead: {
				id: 'lead-1',
				contact: '+79990000000',
				createdAt
			},
			integrations: {
				email: 'owner@example.com',
				webhookUrl: 'https://example.com/webhook',
				telegramChatId: '123',
				bitrix24WebhookUrl: 'https://example.bitrix24.ru/rest/1/key',
				amoCrmDomain: 'example.amocrm.ru',
				amoCrmToken: 'token'
			}
		});

		expect(createMany).toHaveBeenCalledTimes(1);
		const data = createMany.mock.calls[0][0].data;
		expect(data).toHaveLength(5);
		expect(
			data.map((event: { routingKey: string }) => event.routingKey)
		).toEqual(
			LEAD_INTEGRATION_KINDS.map(kind => INTEGRATION_ROUTING_KEYS[kind])
		);
		expect(data[0].payload).toMatchObject({
			schemaVersion: 2,
			eventType: 'lead.integration.requested.v2',
			source: 'widget',
			entity: { id: 'widget-1', name: 'Колесо' },
			lead: {
				id: 'lead-1',
				createdAt: createdAt.toISOString()
			}
		});
		expect(createSnapshots).toHaveBeenCalledTimes(1);
		expect(createSnapshots.mock.calls[0][0].data).toHaveLength(3);
		expect(JSON.stringify(data)).not.toContain('token');
		expect(JSON.stringify(data)).not.toContain('/rest/1/key');
		expect(JSON.stringify(data)).not.toContain(
			'https://example.com/webhook'
		);
	});

	it('does not create outbox rows when no integrations are enabled', async () => {
		const createMany = jest.fn();
		const transaction = {
			outboxEvent: { createMany },
			integrationCredentialSnapshot: { createMany: jest.fn() }
		} as unknown as Prisma.TransactionClient;

		await enqueueLeadIntegrationEvents(transaction, {
			source: 'quiz',
			entity: { id: 'quiz-1', name: 'Квиз' },
			lead: {
				id: 'lead-1',
				createdAt: new Date()
			},
			integrations: {
				email: ' ',
				webhookUrl: null
			}
		});

		expect(createMany).not.toHaveBeenCalled();
	});

	it('does not enqueue incomplete amoCRM credentials', async () => {
		const createMany = jest.fn();
		const transaction = {
			outboxEvent: { createMany },
			integrationCredentialSnapshot: { createMany: jest.fn() }
		} as unknown as Prisma.TransactionClient;

		await enqueueLeadIntegrationEvents(transaction, {
			source: 'callback',
			entity: { id: 'callback-1', name: 'Звонок' },
			lead: {
				id: 'lead-1',
				createdAt: new Date()
			},
			integrations: {
				amoCrmDomain: 'example.amocrm.ru',
				amoCrmToken: ''
			}
		});

		expect(createMany).not.toHaveBeenCalled();
	});
});
