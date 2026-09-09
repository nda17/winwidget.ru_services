import { ConfigService } from '@nestjs/config';
import type { Transporter } from 'nodemailer';
import { Prisma } from '@prisma/notification-delivery-client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EmailService } from '../email/email.service';
import { assertMessagingEventContract } from '../messaging/messaging-event-contract';
import {
	SUPPORT_NOTIFICATION_EVENT_TYPES,
	SUPPORT_NOTIFICATION_KINDS,
	SUPPORT_NOTIFICATION_OUTCOME_EVENT_TYPE,
	SupportNotificationKind,
	NOTIFICATION_DELIVERY_KINDS
} from '../messaging/messaging.constants';
import {
	assertSupportNotificationEvent,
	assertSupportNotificationOutcome,
	parseSupportNotificationContext,
	SupportNotificationEvent,
	SupportNotificationContext
} from '../messaging/support-notification.contract';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { TelegramInfoTransportService } from '../telegram/telegram-info-transport.service';
import { TelegramSupportTransportService } from '../telegram/telegram-support-transport.service';
import { SupportNotificationContextService } from './support-notification-context.service';
import { NotificationDeliveryAdapterService } from './notification-delivery-adapter.service';
import type { NotificationDeliveryPrismaService } from './prisma/notification-delivery-prisma.service';
import type { WincrmInvitationContextService } from './wincrm-invitation-context.service';
import type { WincrmTaskReminderContextService } from './wincrm-task-reminder-context.service';
import { NotificationDeliveryOutcomeService } from './notification-delivery-outcome.service';
import { parseNotificationDeliveryKinds } from './notification-delivery-worker.service';

const event = (
	kind: SupportNotificationKind = 'support-team-email'
): SupportNotificationEvent => ({
	schemaVersion: 1,
	eventId: '11111111-1111-4111-8111-111111111111',
	eventType: SUPPORT_NOTIFICATION_EVENT_TYPES[kind],
	occurredAt: '2026-09-09T10:00:00.000Z',
	reference: {
		type: 'support-notification',
		id: '22222222-2222-4222-8222-222222222222'
	}
});
const context = (
	kind: SupportNotificationKind = 'support-team-email'
): SupportNotificationContext => ({
	schemaVersion: 1,
	eventId: event().eventId,
	intentId: event().reference.id,
	kind,
	deliver: true,
	reason: null,
	destination:
		kind === 'support-team-telegram'
			? {
					bot: 'SUPPORT',
					telegramChatId: '-1001234567890',
					messageThreadId: 12
				}
			: { email: 'verified@example.test' },
	content: {
		conversationId: '33333333-3333-4333-8333-333333333333',
		conversationNumber: 42,
		notificationType:
			kind === 'support-client-email'
				? 'OPERATOR_REPLY'
				: 'NEW_CONVERSATION'
	}
});
const fixtureToken = 'a'.repeat(48);
function configuration(extra: Record<string, unknown> = {}) {
	const values: Record<string, unknown> = {
		NOTIFICATION_DELIVERY_KINDS: SUPPORT_NOTIFICATION_KINDS.join(','),
		SUPPORT_INTERNAL_BASE_URL: 'http://127.0.0.1:5100',
		SUPPORT_NOTIFICATION_DELIVERY_TOKEN: fixtureToken,
		SMTP_SERVER: 'smtp.example.test',
		SMTP_LOGIN: 'fixture',
		SMTP_PASSWORD: 'fixture-only',
		TELEGRAM_INFO_BOT_TOKEN: '999:information-fixture-token-only',
		TELEGRAM_SUPPORT_BOT_TOKEN: '123:support-fixture-token-only',
		MODE: 'test',
		TELEGRAM_API_BASE_URL: 'http://127.0.0.1:12345',
		...extra
	};
	return { get: (key: string) => values[key] } as ConfigService;
}

describe('Support notification broker/context contracts', () => {
	afterEach(() => jest.restoreAllMocks());
	it('keeps old defaults and binds each opt-in kind to its own request/retry/DLQ', async () => {
		expect(parseNotificationDeliveryKinds(undefined)).toHaveLength(11);
		for (const kind of SUPPORT_NOTIFICATION_KINDS) {
			const payload = event(kind);
			for (const routingKey of [
				payload.eventType,
				`manual.${kind}`,
				`${kind}.dead-letter`,
				kind
			])
				expect(() =>
					assertMessagingEventContract(payload, {
						kind,
						eventType: payload.eventType,
						routingKey,
						messageId: payload.eventId
					})
				).not.toThrow();
			const channel = {
				assertExchange: jest.fn(),
				assertQueue: jest.fn(),
				bindQueue: jest.fn()
			};
			const rabbit = new RabbitMqService(
				configuration({ NOTIFICATION_DELIVERY_KINDS: kind })
			);
			await (
				rabbit as unknown as {
					assertTopology(channel: unknown): Promise<void>;
				}
			).assertTopology(channel);
			const supportQueues = channel.assertQueue.mock.calls
				.map(([queue]) => queue as string)
				.filter(queue => queue.includes('.support.'));
			expect(supportQueues).toHaveLength(5);
			expect(channel.bindQueue).toHaveBeenCalledWith(
				expect.any(String),
				'winwidget.events',
				`manual.${kind}`
			);
		}
		const disabled = new SupportNotificationContextService(
			configuration({
				NOTIFICATION_DELIVERY_KINDS: 'email',
				SUPPORT_INTERNAL_BASE_URL: undefined
			}),
			new TelegramSupportTransportService(configuration())
		);
		expect(() => disabled.onModuleInit()).not.toThrow();
	});
	it.each([
		{ email: 'private@example.test' },
		{ content: { text: 'private' } },
		{ eventId: 'bad' },
		{ occurredAt: '2026-09-09' },
		{
			reference: { ...event().reference, conversationId: event().eventId }
		}
	])('rejects extra information and malformed events %j', extra => {
		expect(() =>
			assertSupportNotificationEvent({ ...event(), ...extra })
		).toThrow();
	});
	it('rejects mismatched message identity, kind, destinations, and topic fallback', () => {
		const payload = event();
		expect(() =>
			assertMessagingEventContract(payload, {
				kind: 'support-client-email',
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: payload.eventId
			})
		).toThrow();
		expect(() =>
			assertMessagingEventContract(payload, {
				eventType: payload.eventType,
				routingKey: payload.eventType,
				messageId: payload.reference.id
			})
		).toThrow();
		for (const extra of [
			{ destination: { email: 'UNVERIFIED@EXAMPLE.TEST' } },
			{ secret: 'private' },
			{ eventId: payload.reference.id },
			{ content: { ...context().content, subject: 'private' } }
		])
			expect(() =>
				parseSupportNotificationContext(
					{ ...context(), ...extra },
					payload,
					'support-team-email'
				)
			).toThrow();
		for (const messageThreadId of [undefined, null, 0, -1, 1.5])
			expect(() =>
				parseSupportNotificationContext(
					{
						...context('support-team-telegram'),
						destination: {
							bot: 'SUPPORT',
							telegramChatId: '-1001234567890',
							messageThreadId
						}
					},
					event('support-team-telegram'),
					'support-team-telegram'
				)
			).toThrow();
	});
	it('uses the scoped bounded POST and never includes identity or destinations in its request', async () => {
		const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify(context()), {
				headers: { 'content-type': 'application/json' }
			})
		);
		const service = new SupportNotificationContextService(
			configuration(),
			new TelegramSupportTransportService(configuration())
		);
		expect(() => service.onModuleInit()).not.toThrow();
		await expect(
			service.resolve(event(), 'support-team-email')
		).resolves.toEqual(context());
		expect(fetchMock).toHaveBeenCalledWith(
			`http://127.0.0.1:5100/internal/v1/notification-delivery/support-notifications/${event().reference.id}/delivery-context`,
			expect.objectContaining({
				method: 'POST',
				redirect: 'error',
				headers: {
					'content-type': 'application/json',
					'x-winwidget-service': 'notification-delivery',
					'x-winwidget-internal-token': fixtureToken
				},
				body: JSON.stringify({
					schemaVersion: 1,
					eventId: event().eventId,
					kind: 'support-team-email'
				})
			})
		);
	});
	it.each([
		new Response('x'.repeat(8193), {
			headers: { 'content-type': 'application/json' }
		}),
		new Response('{}', {
			status: 503,
			headers: { 'content-type': 'application/json' }
		}),
		new Response('{}', { headers: { 'content-type': 'text/html' } })
	])('fails safely for invalid context responses', async response => {
		jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);
		const service = new SupportNotificationContextService(
			configuration(),
			new TelegramSupportTransportService(configuration())
		);
		await expect(
			service.resolve(event(), 'support-team-email')
		).rejects.toMatchObject({
			message: 'Support notification context is unavailable',
			code: 'ETIMEDOUT'
		});
	});
	it.each([
		'https://user:password@example.test',
		'https://example.test/private',
		'http://example.test',
		'https://example.test/?token=private'
	])('rejects unscoped origin %s', origin => {
		expect(() =>
			new SupportNotificationContextService(
				configuration({ SUPPORT_INTERNAL_BASE_URL: origin }),
				new TelegramSupportTransportService(configuration())
			).onModuleInit()
		).toThrow();
	});
	it('publishes only the three new safe outcome contracts', async () => {
		const createMany = jest.fn();
		const tx = {
			notificationDeliveryOutboxEvent: { createMany }
		} as unknown as Prisma.TransactionClient;
		const outcomes = new NotificationDeliveryOutcomeService();
		for (const status of ['DELIVERED', 'FAILED', 'SKIPPED'] as const) {
			await outcomes.createDeliveryOutcome(tx, {
				kind: 'support-team-email',
				eventId: event().eventId,
				payload: event(),
				status,
				skipReason: 'CHANNEL_DISABLED',
				failure: {
					normalizedCode: 'SMTP_421',
					safeReason: 'private provider detail must not leave ND'
				}
			});
			const entry = createMany.mock.calls.at(-1)![0].data[0];
			expect(() =>
				assertSupportNotificationOutcome(entry.payload)
			).not.toThrow();
			expect(() =>
				assertMessagingEventContract(entry.payload, {
					eventType: entry.eventType,
					routingKey: entry.routingKey,
					messageId: entry.messageId
				})
			).not.toThrow();
			expect(entry.routingKey).toBe(
				SUPPORT_NOTIFICATION_OUTCOME_EVENT_TYPE
			);
			expect(JSON.stringify(entry)).not.toContain(
				'private provider detail'
			);
		}
		expect(
			new Set(
				createMany.mock.calls.map(
					([data]) => data.data[0].deduplicationKey
				)
			).size
		).toBe(3);
		const value = createMany.mock.calls[0][0].data[0].payload;
		expect(() =>
			assertSupportNotificationOutcome({
				...value,
				destination: { email: 'private@example.test' }
			})
		).toThrow();
	});
	it('preserves existing database kinds and adds exact independent support routes', () => {
		const sql = readFileSync(
			join(
				__dirname,
				'../../prisma/migrations/20260909010000_add_support_notifications/migration.sql'
			),
			'utf8'
		);
		for (const kind of NOTIFICATION_DELIVERY_KINDS) {
			expect(sql).toContain(`'${kind}'`);
			expect(sql).toContain(`'manual.${kind}'`);
			expect(sql).toContain(`'${kind}.dead-letter'`);
		}
		for (const type of Object.values(SUPPORT_NOTIFICATION_EVENT_TYPES))
			expect(sql).toContain(type);
		expect(sql).toContain(SUPPORT_NOTIFICATION_OUTCOME_EVENT_TYPE);
	});
});

describe('Support notification external delivery', () => {
	afterEach(() => jest.restoreAllMocks());
	function adapterFixture() {
		const email = {
			sendSupportNotification: jest.fn()
		} as unknown as EmailService;
		const info = {
			sendMessage: jest.fn()
		} as unknown as TelegramInfoTransportService;
		const support = {
			sendMessage: jest.fn()
		} as unknown as TelegramSupportTransportService;
		const resolve = jest.fn(
			async (_: unknown, kind: SupportNotificationKind) => context(kind)
		);
		const findFirst = jest
			.fn()
			.mockResolvedValue({ leaseExpiresAt: new Date(Date.now() + 60000) });
		const adapter = new NotificationDeliveryAdapterService(
			email,
			info,
			{
				notificationDeliveryReceipt: { findFirst }
			} as unknown as NotificationDeliveryPrismaService,
			{} as WincrmInvitationContextService,
			{} as WincrmTaskReminderContextService,
			undefined,
			{ resolve } as unknown as SupportNotificationContextService,
			support
		);
		return { adapter, email, info, support, resolve, findFirst };
	}
	it('requires a live matching lease, sends once per recipient/channel, and never uses INFO bot', async () => {
		const fixture = adapterFixture();
		await expect(
			fixture.adapter.deliver(
				'support-team-email',
				event(),
				event().eventId
			)
		).rejects.toThrow('matching active claim');
		expect(fixture.resolve).not.toHaveBeenCalled();
		for (const kind of SUPPORT_NOTIFICATION_KINDS)
			await fixture.adapter.deliver(
				kind,
				event(kind),
				event().eventId,
				'active-claim'
			);
		expect(fixture.email.sendSupportNotification).toHaveBeenCalledTimes(2);
		expect(fixture.support.sendMessage).toHaveBeenCalledWith(
			'-1001234567890',
			expect.stringContaining(
				'https://winwidget.ru/admin/support?conversationId='
			),
			{ messageThreadId: 12, parseMode: null }
		);
		expect(fixture.info.sendMessage).not.toHaveBeenCalled();
		fixture.findFirst.mockResolvedValue(null);
		await expect(
			fixture.adapter.deliver(
				'support-team-email',
				event(),
				event().eventId,
				'expired-claim'
			)
		).rejects.toThrow('no longer active');
		expect(fixture.email.sendSupportNotification).toHaveBeenCalledTimes(2);
	});
	it('keeps missing confirmed email as a safe skip without calling any transport', async () => {
		const fixture = adapterFixture();
		fixture.resolve.mockResolvedValue({
			...context('support-client-email'),
			deliver: false,
			destination: null,
			content: null,
			reason: 'RECIPIENT_UNAVAILABLE'
		});
		await expect(
			fixture.adapter.deliver(
				'support-client-email',
				event('support-client-email'),
				event().eventId,
				'claim'
			)
		).resolves.toEqual({
			status: 'SKIPPED',
			reason: 'RECIPIENT_UNAVAILABLE'
		});
		expect(fixture.email.sendSupportNotification).not.toHaveBeenCalled();
		expect(fixture.support.sendMessage).not.toHaveBeenCalled();
	});
	it('uses Support credentials only, with the exact forum topic', async () => {
		const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ ok: true })
		} as Response);
		await new TelegramSupportTransportService(configuration()).sendMessage(
			'-1001234567890',
			'Обращение №42',
			{ messageThreadId: 12, parseMode: null }
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe(
			'http://127.0.0.1:12345/bot123:support-fixture-token-only/sendMessage'
		);
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
			chat_id: '-1001234567890',
			message_thread_id: 12,
			text: 'Обращение №42',
			disable_web_page_preview: true
		});
	});
	it.each([undefined, 0, -1])(
		'never falls back to a general Telegram chat for topic %s',
		async messageThreadId => {
			const fetchMock = jest.spyOn(globalThis, 'fetch');
			await expect(
				new TelegramSupportTransportService(configuration()).sendMessage(
					'-1001234567890',
					'Обращение №42',
					{ messageThreadId }
				)
			).rejects.toMatchObject({ code: 'TELEGRAM_CONFIGURATION_INVALID' });
			expect(fetchMock).not.toHaveBeenCalled();
		}
	);
	it('uses branded emails with fixed authenticated destinations and no conversation content', async () => {
		const sendMail = jest.fn();
		const email = new EmailService({ sendMail } as unknown as Transporter);
		const content = context().content!;
		await email.sendSupportNotification(
			'verified@example.test',
			content,
			true,
			event().eventId
		);
		expect(sendMail.mock.calls[0][0]).toMatchObject({
			to: 'verified@example.test',
			subject: 'Вам ответила поддержка',
			messageId: `<${event().eventId}.support-notification@winwidget.ru>`
		});
		expect(sendMail.mock.calls[0][0].html).toContain(
			`https://crm.winwidget.ru/inbox?supportConversation=${content.conversationId}`
		);
		await email.sendSupportNotification(
			'staff@example.test',
			content,
			false,
			event().eventId
		);
		expect(sendMail.mock.calls[1][0].html).toContain(
			`https://winwidget.ru/admin/support?conversationId=${content.conversationId}`
		);
	});
});
