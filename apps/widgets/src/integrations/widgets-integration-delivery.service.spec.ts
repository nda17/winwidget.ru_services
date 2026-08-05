import { createHash } from 'node:crypto';
import type { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import {
	assertWidgetsIntegrationMessageSize,
	WidgetsIntegrationDeliveryService,
	WidgetsIntegrationDestinationError,
	WidgetsLeadIntegrationEvent
} from './widgets-integration-delivery.service';
import type { WidgetsSafeHttpService } from './widgets-safe-http.service';

const eventId = '33333333-3333-4333-8333-333333333333';
const credentialRef = '11111111-1111-4111-8111-111111111111';
const fingerprint = (value: string) =>
	createHash('sha256').update(value).digest('hex');

const leadEvent = (
	integration: WidgetsLeadIntegrationEvent['integration'] = 'webhook'
): WidgetsLeadIntegrationEvent => ({
	schemaVersion: 2,
	eventType: 'lead.integration.requested.v2',
	integration,
	source: 'widget',
	entity: { id: 'widget-1', name: 'Колесо' },
	lead: {
		id: 'lead-1',
		contact: '+79990000000',
		name: 'Иван',
		phone: '+79990000000',
		email: 'ivan@example.com',
		bonus: 'Скидка 10%',
		timeSlot: '18:00',
		timezone: 'Europe/Moscow',
		actionLabel: 'Промокод',
		actionValue: 'WW10',
		url: 'https://shop.example/offer',
		createdAt: '2026-08-04T12:00:00.000Z'
	},
	destination: { credentialRef }
});

describe('WidgetsIntegrationDeliveryService', () => {
	const createService = () => {
		const prisma = {
			integrationCredentialSnapshot: { findUnique: jest.fn() }
		} as unknown as WidgetsPrismaService;
		const http = {
			postJson: jest.fn().mockResolvedValue(undefined),
			amoApiUrl: jest
				.fn()
				.mockReturnValue('https://tenant.amocrm.ru/api/v4/leads/complex')
		} as unknown as WidgetsSafeHttpService;
		return {
			service: new WidgetsIntegrationDeliveryService(prisma, http),
			prisma,
			http
		};
	};

	it('accepts the exact v2 lead contract', () => {
		const { service } = createService();
		expect(service.parse(leadEvent(), 'webhook')).toEqual(leadEvent());
	});

	it.each([
		['unexpected root field', { ...leadEvent(), extra: true }],
		['invalid source', { ...leadEvent(), source: 'unknown' }],
		[
			'non-canonical date',
			{
				...leadEvent(),
				lead: { ...leadEvent().lead, createdAt: '2026-08-04' }
			}
		],
		[
			'secret-like nested field',
			{
				...leadEvent(),
				lead: { ...leadEvent().lead, answers: { token: 'hidden' } }
			}
		]
	])('rejects %s', (_label, value) => {
		const { service } = createService();
		expect(() => service.parse(value, 'webhook')).toThrow();
	});

	it('preserves the legacy public webhook payload exactly', async () => {
		const { service, prisma, http } = createService();
		(
			prisma.integrationCredentialSnapshot.findUnique as jest.Mock
		).mockResolvedValue({
			id: credentialRef,
			eventId,
			integration: 'webhook',
			source: 'widget',
			entityId: 'widget-1',
			targetFingerprint: fingerprint('https://hooks.example/lead'),
			credentials: { webhookUrl: 'https://hooks.example/lead' },
			version: 1
		});

		await service.deliver('webhook', eventId, leadEvent());

		expect((http.postJson as jest.Mock).mock.calls).toMatchInlineSnapshot(`
[
  [
    "https://hooks.example/lead",
    {
      "entity": {
        "id": "widget-1",
        "name": "Колесо",
      },
      "eventId": "33333333-3333-4333-8333-333333333333",
      "eventType": "lead.created.v1",
      "lead": {
        "actionLabel": "Промокод",
        "actionValue": "WW10",
        "bonus": "Скидка 10%",
        "contact": "+79990000000",
        "createdAt": "2026-08-04T12:00:00.000Z",
        "email": "ivan@example.com",
        "id": "lead-1",
        "name": "Иван",
        "phone": "+79990000000",
        "timeSlot": "18:00",
        "timezone": "Europe/Moscow",
        "url": "https://shop.example/offer",
      },
      "source": "widget",
    },
    {
      "headers": {
        "X-WinWidget-Event-Id": "33333333-3333-4333-8333-333333333333",
      },
      "policy": "webhook",
    },
  ],
]
`);
	});

	it('accepts refreshed snapshot credentials for a manual retry', async () => {
		const { service, prisma, http } = createService();
		(
			prisma.integrationCredentialSnapshot.findUnique as jest.Mock
		).mockResolvedValue({
			id: credentialRef,
			eventId,
			integration: 'webhook',
			source: 'widget',
			entityId: 'widget-1',
			targetFingerprint: fingerprint('https://hooks.example/manual-retry'),
			credentials: {
				webhookUrl: 'https://hooks.example/manual-retry'
			},
			version: 2
		});

		await service.deliver('webhook', eventId, leadEvent());

		expect(http.postJson).toHaveBeenCalledWith(
			'https://hooks.example/manual-retry',
			expect.any(Object),
			expect.objectContaining({ policy: 'webhook' })
		);
	});

	it('preserves the legacy Bitrix24 JSON fields and comments', async () => {
		const { service, prisma, http } = createService();
		const webhookUrl = 'https://portal.bitrix24.ru/rest/42/private-token';
		(
			prisma.integrationCredentialSnapshot.findUnique as jest.Mock
		).mockResolvedValue({
			id: credentialRef,
			eventId,
			integration: 'bitrix24',
			source: 'widget',
			entityId: 'widget-1',
			targetFingerprint: fingerprint('https://portal.bitrix24.ru/rest/42'),
			credentials: { bitrix24WebhookUrl: webhookUrl },
			version: 1
		});

		await service.deliver('bitrix24', eventId, leadEvent('bitrix24'));

		expect((http.postJson as jest.Mock).mock.calls).toMatchInlineSnapshot(`
[
  [
    "https://portal.bitrix24.ru/rest/42/private-token/crm.lead.add.json",
    {
      "fields": {
        "COMMENTS": "Колесо фортуны: Колесо\nКонтакт: +79990000000\nРезультат: Скидка 10%\nПромокод: WW10\nВремя: 18:00\nЧасовой пояс: Europe/Moscow\nСтраница: https://shop.example/offer",
        "EMAIL": [
          {
            "VALUE": "ivan@example.com",
            "VALUE_TYPE": "WORK",
          },
        ],
        "NAME": "Иван",
        "PHONE": [
          {
            "VALUE": "+79990000000",
            "VALUE_TYPE": "WORK",
          },
        ],
        "SOURCE_ID": "WEB",
        "TITLE": "Заявка с виджета «Колесо» — Скидка 10%",
      },
    },
    {
      "policy": "bitrix24",
    },
  ],
]
`);
	});

	it('preserves the legacy amoCRM lead, contact and description payload', async () => {
		const { service, prisma, http } = createService();
		(
			prisma.integrationCredentialSnapshot.findUnique as jest.Mock
		).mockResolvedValue({
			id: credentialRef,
			eventId,
			integration: 'amo-crm',
			source: 'widget',
			entityId: 'widget-1',
			targetFingerprint: fingerprint('tenant.amocrm.ru'),
			credentials: {
				amoCrmDomain: 'tenant.amocrm.ru',
				amoCrmToken: 'private-token'
			},
			version: 1
		});

		await service.deliver('amo-crm', eventId, leadEvent('amo-crm'));

		expect((http.postJson as jest.Mock).mock.calls).toMatchInlineSnapshot(`
[
  [
    "https://tenant.amocrm.ru/api/v4/leads/complex",
    [
      {
        "_embedded": {
          "contacts": [
            {
              "custom_fields_values": [
                {
                  "field_code": "PHONE",
                  "values": [
                    {
                      "enum_code": "WORK",
                      "value": "+79990000000",
                    },
                  ],
                },
                {
                  "field_code": "EMAIL",
                  "values": [
                    {
                      "enum_code": "WORK",
                      "value": "ivan@example.com",
                    },
                  ],
                },
              ],
              "first_name": "Иван",
            },
          ],
        },
        "custom_fields_values": [
          {
            "field_code": "DESCRIPTION",
            "values": [
              {
                "value": "Колесо фортуны: Колесо\nКонтакт: +79990000000\nРезультат: Скидка 10%\nПромокод: WW10\nВремя: 18:00\nЧасовой пояс: Europe/Moscow\nСтраница: https://shop.example/offer",
              },
            ],
          },
        ],
        "name": "Заявка с виджета «Колесо» — Скидка 10%",
      },
    ],
    {
      "headers": {
        "Authorization": "Bearer private-token",
      },
      "policy": "amo-crm",
    },
  ],
]
`);
	});

	it('rejects a snapshot whose source or target fingerprint changed', async () => {
		const { service, prisma, http } = createService();
		(
			prisma.integrationCredentialSnapshot.findUnique as jest.Mock
		).mockResolvedValue({
			id: credentialRef,
			eventId,
			integration: 'webhook',
			source: 'quiz',
			entityId: 'widget-1',
			targetFingerprint: fingerprint('https://hooks.example/other'),
			credentials: { webhookUrl: 'https://hooks.example/lead' },
			version: 1
		});

		await expect(
			service.deliver('webhook', eventId, leadEvent())
		).rejects.toBeInstanceOf(WidgetsIntegrationDestinationError);
		expect(http.postJson).not.toHaveBeenCalled();
	});
});

describe('assertWidgetsIntegrationMessageSize', () => {
	it('accepts the configured boundary and rejects empty or oversized content', () => {
		expect(() =>
			assertWidgetsIntegrationMessageSize(Buffer.alloc(1024), 1024)
		).not.toThrow();
		expect(() =>
			assertWidgetsIntegrationMessageSize(Buffer.alloc(0), 1024)
		).toThrow();
		expect(() =>
			assertWidgetsIntegrationMessageSize(Buffer.alloc(1025), 1024)
		).toThrow();
	});
});
