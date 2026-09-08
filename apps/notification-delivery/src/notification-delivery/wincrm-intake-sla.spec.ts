import type { ConfigService } from '@nestjs/config';
import { RequestMethod, type ExecutionContext } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { Transporter } from 'nodemailer';
import { EmailService } from '../email/email.service';
import { assertMessagingEventContract } from '../messaging/messaging-event-contract';
import {
	WINCRM_INTAKE_SLA_EMAIL_EVENT_TYPE as EMAIL,
	WINCRM_INTAKE_SLA_TELEGRAM_EVENT_TYPE as TELEGRAM,
	WINCRM_INTAKE_SLA_KINDS,
	WINCRM_TASK_REMINDER_EMAIL_EVENT_TYPE,
	WINCRM_TASK_REMINDER_KINDS,
	MESSAGING_QUEUE_NAMES,
	MESSAGING_ROUTING_KEYS,
	MANUAL_RETRY_EXCHANGE,
	DEAD_LETTER_EXCHANGE,
	getDeadLetterRoutingKey
} from '../messaging/messaging.constants';
import type { WincrmIntakeSlaEventPayload } from '../messaging/delivery-event.types';
import {
	assertWincrmIntakeSlaEvent,
	parseSlaDeliveryContext
} from '../messaging/wincrm-intake-sla.contract';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import {
	parseNotificationDeliveryKinds,
	type NotificationDeliveryWorkerService
} from './notification-delivery-worker.service';
import { WincrmIntakeSlaContextService } from './wincrm-intake-sla-context.service';
import { TelegramInfoTransportService } from '../telegram/telegram-info-transport.service';
import { NotificationDeliveryAdapterService } from './notification-delivery-adapter.service';
import type { NotificationDeliveryPrismaService } from './prisma/notification-delivery-prisma.service';
import type { WincrmInvitationContextService } from './wincrm-invitation-context.service';
import type { WincrmTaskReminderContextService } from './wincrm-task-reminder-context.service';
import {
	WincrmIntakeSlaReadinessController,
	WincrmIntakeSlaReadinessGuard
} from './wincrm-intake-sla-readiness.controller';
import type { NotificationDeliveryHealthService } from './notification-delivery-health.service';

const event: WincrmIntakeSlaEventPayload = {
	schemaVersion: 1,
	eventId: '11111111-1111-4111-8111-111111111111',
	eventType: EMAIL,
	occurredAt: '2026-09-08T10:00:00.000Z',
	reference: {
		type: 'wincrm-intake-sla',
		id: '11111111-1111-4111-8111-111111111111',
		workspaceId: '33333333-3333-4333-8333-333333333333'
	}
};
const otherId = '22222222-2222-4222-8222-222222222222';
const fixtureToken = 's'.repeat(48),
	reverseToken = 'r'.repeat(48);
const context = () => ({
	schemaVersion: 1,
	eventId: event.eventId,
	notificationId: event.reference.id,
	workspaceId: event.reference.workspaceId,
	channel: 'EMAIL',
	deliver: true,
	destination: { email: 'person@example.test', telegramChatId: null },
	content: {
		entryId: '44444444-4444-4444-8444-444444444444',
		title: '<script>Private intake & "client"</script>',
		dueAt: '2026-09-08T10:30:00.000Z',
		timeZone: 'Europe/Moscow'
	}
});
const denied = () => ({
	...context(),
	deliver: false,
	destination: null,
	content: null
});
function setupConfig(overrides: Record<string, string | undefined> = {}) {
	const values: Record<string, string | undefined> = {
		NOTIFICATION_DELIVERY_KINDS: WINCRM_INTAKE_SLA_KINDS.join(','),
		CRM_INTAKE_INTERNAL_BASE_URL: 'http://127.0.0.1:4702',
		CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN: fixtureToken,
		NOTIFICATION_DELIVERY_CRM_INTAKE_TOKEN: reverseToken,
		SMTP_SERVER: 'smtp.example.test',
		SMTP_LOGIN: 'fixture',
		SMTP_PASSWORD: 'fixture-only',
		TELEGRAM_INFO_BOT_TOKEN: 'fixture-only',
		MODE: 'development',
		...overrides
	};
	const config = { get: (key: string) => values[key] } as ConfigService;
	return {
		config,
		service: new WincrmIntakeSlaContextService(
			config,
			new TelegramInfoTransportService(config)
		)
	};
}

describe('Intake SLA opaque broker and owner context contracts', () => {
	afterEach(() => jest.restoreAllMocks());
	it('retains eleven default kinds and opts into independent SLA channels only', () => {
		const defaults = parseNotificationDeliveryKinds(undefined);
		expect(defaults).toHaveLength(11);
		for (const kind of WINCRM_INTAKE_SLA_KINDS)
			expect(defaults).not.toContain(kind);
		expect(
			parseNotificationDeliveryKinds(WINCRM_INTAKE_SLA_KINDS.join(','))
		).toEqual(WINCRM_INTAKE_SLA_KINDS);
		for (const [kind, type] of [
			[WINCRM_INTAKE_SLA_KINDS[0], EMAIL],
			[WINCRM_INTAKE_SLA_KINDS[1], TELEGRAM]
		] as const) {
			expect(MESSAGING_ROUTING_KEYS[kind]).toBe(type);
			for (const routingKey of [
				type,
				`manual.${kind}`,
				`${kind}.dead-letter`,
				kind
			])
				expect(() =>
					assertMessagingEventContract(
						{ ...event, eventType: type },
						{ kind, eventType: type, routingKey, messageId: event.eventId }
					)
				).not.toThrow();
		}
	});
	it.each([
		{ destination: { email: 'person@example.test' } },
		{ content: { title: 'Private' } },
		{ recipientSubject: 'private' },
		{ schemaVersion: 2 },
		{ eventType: WINCRM_TASK_REMINDER_EMAIL_EVENT_TYPE },
		{ eventId: '11111111-1111-1111-8111-111111111111' },
		{ occurredAt: '2026-09-08' },
		{ reference: { ...event.reference, id: otherId } },
		{ reference: { ...event.reference, type: 'wincrm-task-reminder' } },
		{ reference: { ...event.reference, workspaceId: 'invalid' } },
		{ reference: { ...event.reference, entryId: otherId } }
	])(
		'rejects PII, foreign owner types and invalid reference metadata %j',
		extra =>
			expect(() =>
				assertWincrmIntakeSlaEvent({ ...event, ...extra })
			).toThrow()
	);
	it('binds payload type, channel, AMQP message ID and routing key before consumer processing', () => {
		for (const extra of [
			{ messageId: otherId },
			{ eventType: TELEGRAM },
			{ kind: 'wincrm-intake-sla-telegram' as const },
			{ kind: 'wincrm-task-reminder-email' as const },
			{ routingKey: WINCRM_TASK_REMINDER_EMAIL_EVENT_TYPE }
		])
			expect(() =>
				assertMessagingEventContract(event, {
					kind: 'wincrm-intake-sla-email',
					eventType: EMAIL,
					routingKey: EMAIL,
					messageId: event.eventId,
					...extra
				})
			).toThrow();
	});
	it('accepts active email/Telegram and terminal no-send without leaking destinations', () => {
		expect(
			parseSlaDeliveryContext(context(), event, 'EMAIL')
		).toMatchObject({ deliver: true });
		expect(
			parseSlaDeliveryContext(denied(), event, 'EMAIL')
		).toMatchObject({ deliver: false, content: null, destination: null });
		expect(
			parseSlaDeliveryContext(
				{
					...context(),
					channel: 'TELEGRAM',
					destination: { email: null, telegramChatId: '123' }
				},
				{ ...event, eventType: TELEGRAM },
				'TELEGRAM'
			)
		).toMatchObject({ deliver: true });
	});
	it.each([
		{ schemaVersion: 2 },
		{ eventId: otherId },
		{ notificationId: otherId },
		{ workspaceId: otherId },
		{ channel: 'TELEGRAM' },
		{ retryAt: null },
		{ deliver: 'true' },
		{
			destination: { email: 'Person@example.test', telegramChatId: null }
		},
		{
			destination: { email: 'person@example.test', telegramChatId: '123' }
		},
		{ content: { ...context().content, entryId: 'invalid' } },
		{ content: { ...context().content, title: '' } },
		{ content: { ...context().content, title: 'x'.repeat(201) } },
		{ content: { ...context().content, dueAt: '2026-09-08' } },
		{ content: { ...context().content, timeZone: 'Mars/Test' } },
		{ content: { ...context().content, timeZone: '+03:00' } },
		{
			content: { ...context().content, actionUrl: 'https://example.test' }
		}
	])('rejects mismatched or unbounded owner context %j', extra =>
		expect(() =>
			parseSlaDeliveryContext({ ...context(), ...extra }, event, 'EMAIL')
		).toThrow()
	);
	it('rejects no-send PII and mixed Telegram destinations', () => {
		for (const value of [
			{ ...denied(), content: context().content },
			{ ...denied(), destination: context().destination }
		])
			expect(() =>
				parseSlaDeliveryContext(value, event, 'EMAIL')
			).toThrow();
		for (const destination of [
			{ email: 'person@example.test', telegramChatId: '123' },
			{ email: null, telegramChatId: '@private' },
			{ email: null, telegramChatId: '0' }
		])
			expect(() =>
				parseSlaDeliveryContext(
					{ ...context(), channel: 'TELEGRAM', destination },
					{ ...event, eventType: TELEGRAM },
					'TELEGRAM'
				)
			).toThrow();
	});
	it('does not require SLA credentials or transports on existing opt-out consumers', () => {
		expect(() =>
			setupConfig({
				NOTIFICATION_DELIVERY_KINDS: undefined,
				CRM_INTAKE_INTERNAL_BASE_URL: undefined,
				CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN: undefined,
				NOTIFICATION_DELIVERY_CRM_INTAKE_TOKEN: undefined,
				SMTP_PASSWORD: undefined,
				TELEGRAM_INFO_BOT_TOKEN: undefined
			}).service.onModuleInit()
		).not.toThrow();
	});
	it.each([
		{ CRM_INTAKE_INTERNAL_BASE_URL: 'http://example.test' },
		{ CRM_INTAKE_INTERNAL_BASE_URL: 'https://user:password@example.test' },
		{ CRM_INTAKE_INTERNAL_BASE_URL: 'https://example.test/path' },
		{ CRM_INTAKE_INTERNAL_BASE_URL: 'https://example.test?query=1' },
		{ CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN: undefined },
		{
			CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN:
				'replace-this-token-with-a-real-one'
		},
		{ NOTIFICATION_DELIVERY_CRM_INTAKE_TOKEN: fixtureToken },
		{ NOTIFICATION_DELIVERY_OPERATIONS_TOKEN: fixtureToken },
		{ CRM_SALES_NOTIFICATION_DELIVERY_TOKEN: reverseToken },
		{ NOTIFICATION_DELIVERY_CRM_SALES_TOKEN: fixtureToken },
		{ IDENTITY_NOTIFICATION_DELIVERY_TOKEN: reverseToken },
		{ SMTP_PASSWORD: '' },
		{ TELEGRAM_INFO_BOT_TOKEN: '' }
	])('fails enabled SLA configuration closed %j', extra =>
		expect(() => setupConfig(extra).service.onModuleInit()).toThrow()
	);
	it('does not resolve an opted-out channel even when the other transport is configured', async () => {
		const fetchMock = jest.spyOn(globalThis, 'fetch');
		const value = setupConfig({
			NOTIFICATION_DELIVERY_KINDS: 'wincrm-intake-sla-email',
			TELEGRAM_INFO_BOT_TOKEN: undefined
		});
		expect(() => value.service.onModuleInit()).not.toThrow();
		await expect(
			value.service.resolve({ ...event, eventType: TELEGRAM })
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it('makes a bounded reference-only private POST to the Intake owner, not Sales', async () => {
		const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify(context()), {
				headers: { 'content-type': 'application/json' }
			})
		);
		expect(await setupConfig().service.resolve(event)).toMatchObject({
			deliver: true
		});
		expect(fetchMock).toHaveBeenCalledWith(
			`http://127.0.0.1:4702/internal/v1/notification-delivery/intake-sla/${event.eventId}/delivery-context`,
			expect.objectContaining({
				method: 'POST',
				redirect: 'error',
				headers: expect.objectContaining({
					'x-winwidget-service': 'notification-delivery',
					'x-winwidget-internal-token': fixtureToken
				}),
				body: JSON.stringify({
					schemaVersion: 1,
					eventId: event.eventId,
					workspaceId: event.reference.workspaceId,
					channel: 'EMAIL'
				}),
				signal: expect.any(AbortSignal)
			})
		);
	});
	it.each([
		() => new Response('private body', { status: 403 }),
		() => new Response('{}', { headers: { 'content-type': 'text/html' } }),
		() =>
			new Response('x'.repeat(8193), {
				headers: { 'content-type': 'application/json' }
			}),
		() =>
			new Response('{}', {
				headers: {
					'content-type': 'application/json',
					'content-length': '8193'
				}
			}),
		() =>
			new Response(
				JSON.stringify({ ...context(), workspaceId: otherId }),
				{ headers: { 'content-type': 'application/json' } }
			)
	])(
		'sanitizes failed, mismatched and oversized private response bodies',
		async makeResponse => {
			jest.spyOn(globalThis, 'fetch').mockResolvedValue(makeResponse());
			const error = await setupConfig()
				.service.resolve(event)
				.catch(value => value as Error & { code: string });
			expect(error).toMatchObject({ code: 'ETIMEDOUT' });
			expect((error as Error).message).not.toMatch(
				/private body|person@example|Private intake/
			);
		}
	);
	it('aborts timed-out context and never propagates private network details', async () => {
		jest.useFakeTimers();
		try {
			jest
				.spyOn(globalThis, 'fetch')
				.mockImplementation(
					async (_url, init) =>
						new Promise((_resolve, reject) =>
							init?.signal?.addEventListener('abort', () =>
								reject(new Error(`private ${fixtureToken}`))
							)
						)
				);
			const result = setupConfig()
				.service.resolve(event)
				.catch(value => value as Error & { code: string });
			await jest.advanceTimersByTimeAsync(5000);
			const error = await result;
			expect(error).toMatchObject({ code: 'ETIMEDOUT' });
			expect((error as Error).message).not.toContain(fixtureToken);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe('Intake SLA opt-in topology isolation', () => {
	it.each([
		undefined,
		'email',
		'wincrm-task-reminder-email',
		'wincrm-intake-sla-email',
		'wincrm-intake-sla-telegram',
		WINCRM_INTAKE_SLA_KINDS.join(',')
	])(
		'creates only explicit SLA channel queues with independent retry/DLQ %s',
		async configuredKinds => {
			const service = new RabbitMqService(
				setupConfig({ NOTIFICATION_DELIVERY_KINDS: configuredKinds })
					.config
			);
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
			for (const kind of WINCRM_INTAKE_SLA_KINDS) {
				const queue = MESSAGING_QUEUE_NAMES[kind];
				const actual = queues.filter(name => name.startsWith(queue));
				if (!configuredKinds?.split(',').includes(kind)) {
					expect(actual).toEqual([]);
					continue;
				}
				expect(actual).toEqual([
					queue,
					`${queue}.dead-letter`,
					`${queue}.retry-v2.1`,
					`${queue}.retry-v2.2`,
					`${queue}.retry-v2.3`
				]);
				expect(channel.bindQueue).toHaveBeenCalledWith(
					queue,
					MANUAL_RETRY_EXCHANGE,
					kind
				);
				expect(channel.bindQueue).toHaveBeenCalledWith(
					`${queue}.dead-letter`,
					DEAD_LETTER_EXCHANGE,
					getDeadLetterRoutingKey(kind)
				);
				for (let index = 1; index <= 3; index++)
					expect(channel.assertQueue).toHaveBeenCalledWith(
						`${queue}.retry-v2.${index}`,
						expect.objectContaining({
							deadLetterExchange: MANUAL_RETRY_EXCHANGE,
							deadLetterRoutingKey: kind
						})
					);
				for (const reminderKind of WINCRM_TASK_REMINDER_KINDS)
					expect(queue).not.toBe(MESSAGING_QUEUE_NAMES[reminderKind]);
			}
		}
	);
});

describe('Intake SLA adapter requires fresh authority and an active receipt lease', () => {
	function setup() {
		const sendMail = jest.fn().mockResolvedValue({});
		const sendMessage = jest.fn().mockResolvedValue(undefined);
		const resolve = jest.fn().mockResolvedValue(context());
		const findFirst = jest.fn().mockResolvedValue({
			leaseExpiresAt: new Date(Date.now() + 60_000)
		});
		return {
			sendMail,
			sendMessage,
			resolve,
			findFirst,
			adapter: new NotificationDeliveryAdapterService(
				new EmailService({ sendMail } as unknown as Transporter),
				{ sendMessage } as unknown as TelegramInfoTransportService,
				{
					notificationDeliveryReceipt: { findFirst }
				} as unknown as NotificationDeliveryPrismaService,
				{} as WincrmInvitationContextService,
				{} as WincrmTaskReminderContextService,
				{ resolve } as unknown as WincrmIntakeSlaContextService
			)
		};
	}
	it('renders branded escaped email and fixed Intake deep-link only after matching live claim', async () => {
		const value = setup();
		await value.adapter.deliver(
			'wincrm-intake-sla-email',
			event,
			event.eventId,
			'claim'
		);
		expect(value.sendMail).toHaveBeenCalledWith(
			expect.objectContaining({
				to: context().destination.email,
				subject: 'Обращение без ответа в WinCRM',
				messageId: `<${event.eventId}.wincrm-intake-sla@winwidget.ru>`,
				html: expect.stringContaining(
					`href="https://crm.winwidget.ru/inbox?entry=${context().content.entryId}"`
				)
			})
		);
		const html = value.sendMail.mock.calls[0][0].html as string;
		expect(html).toContain('&lt;script&gt;');
		expect(html).not.toContain('<script>');
		expect(html).toContain('cid:winwidget-notification-logo');
		expect(html).not.toContain('/planner?task=');
		expect(value.findFirst.mock.invocationCallOrder[0]).toBeGreaterThan(
			value.resolve.mock.invocationCallOrder[0]
		);
		expect(value.sendMail.mock.invocationCallOrder[0]).toBeGreaterThan(
			value.findFirst.mock.invocationCallOrder[0]
		);
		expect(value.findFirst.mock.calls[0][0].where).toMatchObject({
			eventId: event.eventId,
			consumer: 'wincrm-intake-sla-email',
			status: 'PROCESSING',
			lockToken: 'claim',
			leaseExpiresAt: { gt: expect.any(Date) }
		});
		expect(value.sendMessage).not.toHaveBeenCalled();
	});
	it('sends Telegram as plain text with the fixed Intake URL and its own receipt kind', async () => {
		const value = setup();
		value.resolve.mockResolvedValue({
			...context(),
			channel: 'TELEGRAM',
			destination: { email: null, telegramChatId: '123' }
		});
		await value.adapter.deliver(
			'wincrm-intake-sla-telegram',
			{ ...event, eventType: TELEGRAM },
			event.eventId,
			'claim'
		);
		expect(value.sendMessage).toHaveBeenCalledWith(
			'123',
			expect.stringContaining(context().content.title),
			{ parseMode: null }
		);
		expect(value.sendMessage.mock.calls[0][1]).toContain(
			`https://crm.winwidget.ru/inbox?entry=${context().content.entryId}`
		);
		expect(value.findFirst.mock.calls[0][0].where.consumer).toBe(
			'wincrm-intake-sla-telegram'
		);
		expect(value.sendMail).not.toHaveBeenCalled();
	});
	it.each([
		null,
		{ leaseExpiresAt: new Date(0) },
		{ leaseExpiresAt: null }
	])('never sends when a claim is lost or expired: %j', async claim => {
		const value = setup();
		value.findFirst.mockResolvedValue(claim);
		await expect(
			value.adapter.deliver(
				'wincrm-intake-sla-email',
				event,
				event.eventId,
				'claim'
			)
		).rejects.toThrow('claim is no longer active');
		expect(value.sendMail).not.toHaveBeenCalled();
		expect(value.sendMessage).not.toHaveBeenCalled();
	});
	it('suppresses an obsolete/denied owner context before claim lookup or transport', async () => {
		const value = setup();
		value.resolve.mockResolvedValue(denied());
		expect(
			await value.adapter.deliver(
				'wincrm-intake-sla-email',
				event,
				event.eventId,
				'claim'
			)
		).toEqual({ status: 'SKIPPED', reason: 'INTAKE_SLA_UNAVAILABLE' });
		expect(value.findFirst).not.toHaveBeenCalled();
		expect(value.sendMail).not.toHaveBeenCalled();
		expect(value.sendMessage).not.toHaveBeenCalled();
	});
	it('does not send when fresh authority lookup fails', async () => {
		const value = setup();
		value.resolve.mockRejectedValue(new Error('owner unavailable'));
		await expect(
			value.adapter.deliver(
				'wincrm-intake-sla-email',
				event,
				event.eventId,
				'claim'
			)
		).rejects.toThrow();
		expect(value.findFirst).not.toHaveBeenCalled();
		expect(value.sendMail).not.toHaveBeenCalled();
	});
	it('rejects unclaimed, channel-mismatched, wrong-id and foreign-type payloads before owner lookup', async () => {
		const value = setup();
		for (const [kind, id, claim] of [
			['wincrm-intake-sla-email', event.eventId, undefined],
			['wincrm-intake-sla-telegram', event.eventId, 'claim'],
			['wincrm-intake-sla-email', otherId, 'claim']
		] as const)
			await expect(
				value.adapter.deliver(kind, event, id, claim)
			).rejects.toThrow();
		await expect(
			value.adapter.deliver(
				'wincrm-intake-sla-email',
				{
					...event,
					eventType: WINCRM_TASK_REMINDER_EMAIL_EVENT_TYPE,
					reference: { ...event.reference, type: 'wincrm-task-reminder' }
				},
				event.eventId,
				'claim'
			)
		).rejects.toThrow();
		expect(value.resolve).not.toHaveBeenCalled();
		expect(value.findFirst).not.toHaveBeenCalled();
		expect(value.sendMail).not.toHaveBeenCalled();
	});
});

describe('Private Intake SLA reader readiness', () => {
	const request = (
		remoteAddress = '127.0.0.1',
		caller = 'crm-intake',
		token: unknown = reverseToken
	) =>
		({
			switchToHttp: () => ({
				getRequest: () => ({
					socket: { remoteAddress },
					headers: {
						'x-winwidget-service': caller,
						'x-winwidget-internal-token': token
					}
				})
			})
		}) as ExecutionContext;
	it('uses a private Intake-specific GET readiness route', () => {
		expect(
			Reflect.getMetadata(
				PATH_METADATA,
				WincrmIntakeSlaReadinessController
			)
		).toBe('internal/v1/crm-intake/sla');
		expect(
			Reflect.getMetadata(
				PATH_METADATA,
				WincrmIntakeSlaReadinessController.prototype.readiness
			)
		).toBe('readiness');
		expect(
			Reflect.getMetadata(
				METHOD_METADATA,
				WincrmIntakeSlaReadinessController.prototype.readiness
			)
		).toBe(RequestMethod.GET);
	});
	it('requires actual loopback and exact Intake reverse credentials, never Sales credentials', () => {
		const guard = new WincrmIntakeSlaReadinessGuard(setupConfig().config);
		expect(guard.canActivate(request())).toBe(true);
		for (const req of [
			request('192.0.2.1'),
			request('127.0.0.1', 'crm-sales'),
			request('127.0.0.1', 'operations'),
			request('127.0.0.1', 'crm-intake', fixtureToken),
			request('127.0.0.1', 'crm-intake', [reverseToken])
		])
			expect(() => guard.canActivate(req)).toThrow();
		for (const key of [
			'CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN',
			'CRM_SALES_NOTIFICATION_DELIVERY_TOKEN',
			'NOTIFICATION_DELIVERY_CRM_SALES_TOKEN',
			'NOTIFICATION_DELIVERY_OPERATIONS_TOKEN',
			'IDENTITY_NOTIFICATION_DELIVERY_TOKEN'
		])
			expect(() =>
				new WincrmIntakeSlaReadinessGuard(
					setupConfig({ [key]: reverseToken }).config
				).canActivate(request())
			).toThrow();
	});
	it('requires both configured SLA consumers and fresh worker/broker/outbox readiness', async () => {
		const getReadinessHealth = jest
			.fn()
			.mockResolvedValue({ status: 'ready' });
		const isReadyForKinds = jest.fn().mockReturnValue(true);
		const controller = new WincrmIntakeSlaReadinessController(
			{
				getReadinessHealth
			} as unknown as NotificationDeliveryHealthService,
			setupConfig().service,
			{ isReadyForKinds } as unknown as NotificationDeliveryWorkerService
		);
		expect(await controller.readiness()).toEqual({
			schemaVersion: 1,
			ready: true,
			checkedAt: expect.any(String),
			channels: ['EMAIL', 'TELEGRAM']
		});
		expect(isReadyForKinds).toHaveBeenCalledWith(WINCRM_INTAKE_SLA_KINDS);
		isReadyForKinds.mockReturnValue(false);
		await expect(controller.readiness()).rejects.toMatchObject({
			status: 503
		});
		isReadyForKinds.mockReturnValue(true);
		getReadinessHealth.mockRejectedValue(
			new Error('private health detail')
		);
		await expect(controller.readiness()).rejects.toMatchObject({
			status: 503
		});
		const partial = new WincrmIntakeSlaReadinessController(
			{
				getReadinessHealth
			} as unknown as NotificationDeliveryHealthService,
			setupConfig({
				NOTIFICATION_DELIVERY_KINDS: 'wincrm-intake-sla-email'
			}).service,
			{ isReadyForKinds } as unknown as NotificationDeliveryWorkerService
		);
		await expect(partial.readiness()).rejects.toMatchObject({
			status: 503
		});
	});
});
