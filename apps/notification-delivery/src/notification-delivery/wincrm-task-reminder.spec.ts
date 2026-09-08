import type { ConfigService } from '@nestjs/config';
import { RequestMethod, type ExecutionContext } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { Transporter } from 'nodemailer';
import { EmailService } from '../email/email.service';
import { assertMessagingEventContract } from '../messaging/messaging-event-contract';
import {
	WINCRM_TASK_REMINDER_EMAIL_EVENT_TYPE as EMAIL,
	WINCRM_TASK_REMINDER_TELEGRAM_EVENT_TYPE as TELEGRAM,
	WINCRM_TASK_REMINDER_KINDS
} from '../messaging/messaging.constants';
import type { WincrmTaskReminderEventPayload } from '../messaging/delivery-event.types';
import {
	assertWincrmTaskReminderEvent,
	parseReminderDeliveryContext
} from '../messaging/wincrm-task-reminder.contract';
import { parseNotificationDeliveryKinds } from './notification-delivery-worker.service';
import type { NotificationDeliveryWorkerService } from './notification-delivery-worker.service';
import { WincrmTaskReminderContextService } from './wincrm-task-reminder-context.service';
import { TelegramInfoTransportService } from '../telegram/telegram-info-transport.service';
import { NotificationDeliveryAdapterService } from './notification-delivery-adapter.service';
import type { NotificationDeliveryPrismaService } from './prisma/notification-delivery-prisma.service';
import type { WincrmInvitationContextService } from './wincrm-invitation-context.service';
import {
	WincrmTaskReminderReadinessController,
	WincrmTaskReminderReadinessGuard
} from './wincrm-task-reminder-readiness.controller';
import type { NotificationDeliveryHealthService } from './notification-delivery-health.service';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const event: WincrmTaskReminderEventPayload = {
	schemaVersion: 1,
	eventId: '11111111-1111-4111-8111-111111111111',
	eventType: EMAIL,
	occurredAt: '2026-09-07T00:00:00.000Z',
	reference: {
		type: 'wincrm-task-reminder',
		id: '22222222-2222-4222-8222-222222222222',
		workspaceId: '33333333-3333-4333-8333-333333333333'
	}
};
const fixtureToken = 'a'.repeat(48),
	reverseToken = 'b'.repeat(48);
const context = () => ({
	schemaVersion: 1,
	eventId: event.eventId,
	reminderId: event.reference.id,
	workspaceId: event.reference.workspaceId,
	channel: 'EMAIL',
	deliver: true,
	retryAt: null,
	destination: { email: 'person@example.test', telegramChatId: null },
	content: {
		taskId: '44444444-4444-4444-8444-444444444444',
		title: '<script>Private task</script>',
		dueAt: '2026-09-08T10:00:00.000Z',
		timeZone: 'Europe/Moscow'
	}
});
const disabled = (retryAt: string | null = null) => ({
	...context(),
	deliver: false,
	retryAt,
	destination: null,
	content: null
});
function setupConfig(overrides: Record<string, string | undefined> = {}) {
	const values: Record<string, string | undefined> = {
		NOTIFICATION_DELIVERY_KINDS: WINCRM_TASK_REMINDER_KINDS.join(','),
		CRM_SALES_INTERNAL_BASE_URL: 'http://127.0.0.1:4704',
		CRM_SALES_NOTIFICATION_DELIVERY_TOKEN: fixtureToken,
		NOTIFICATION_DELIVERY_CRM_SALES_TOKEN: reverseToken,
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
		service: new WincrmTaskReminderContextService(
			config,
			new TelegramInfoTransportService(config)
		)
	};
}

describe('Task reminder broker/context contract', () => {
	afterEach(() => jest.restoreAllMocks());
	it('keeps eleven default kinds and opts into independent email/Telegram routes', () => {
		expect(parseNotificationDeliveryKinds(undefined)).toHaveLength(11);
		expect(
			parseNotificationDeliveryKinds(WINCRM_TASK_REMINDER_KINDS.join(','))
		).toEqual(WINCRM_TASK_REMINDER_KINDS);
		for (const [kind, type] of [
			[WINCRM_TASK_REMINDER_KINDS[0], EMAIL],
			[WINCRM_TASK_REMINDER_KINDS[1], TELEGRAM]
		] as const)
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
	});
	it.each([
		{ destination: { email: 'person@example.test' } },
		{ content: { title: 'PII' } },
		{ actorSubject: 'private' },
		{ schemaVersion: 2 },
		{ eventId: '11111111-1111-1111-8111-111111111111' },
		{ occurredAt: '2026-09-07' },
		{ reference: { ...event.reference, type: 'task' } }
	])('rejects extra PII and invalid broker data %j', extra =>
		expect(() =>
			assertWincrmTaskReminderEvent({ ...event, ...extra })
		).toThrow()
	);
	it('binds AMQP message ID, kind and event type', () => {
		for (const extra of [
			{ messageId: event.reference.id },
			{ eventType: TELEGRAM },
			{ kind: 'wincrm-task-reminder-telegram' as const }
		])
			expect(() =>
				assertMessagingEventContract(event, {
					kind: 'wincrm-task-reminder-email',
					eventType: EMAIL,
					routingKey: EMAIL,
					messageId: event.eventId,
					...extra
				})
			).toThrow();
	});
	it('accepts current delivery, terminal no-send and bounded quiet-hours defer', () => {
		expect(
			parseReminderDeliveryContext(context(), event, 'EMAIL')
		).toMatchObject({ deliver: true });
		expect(
			parseReminderDeliveryContext(disabled(), event, 'EMAIL')
		).toMatchObject({ deliver: false });
		expect(
			parseReminderDeliveryContext(
				disabled(new Date(Date.now() + 1000).toISOString()),
				event,
				'EMAIL'
			)
		).toMatchObject({ deliver: false });
	});
	it('accepts strict assignment context v2 while preserving the exact legacy v1 shape', () => {
		const assigned = {
			...context(),
			schemaVersion: 2,
			content: { ...context().content, trigger: 'ASSIGNED' }
		};
		expect(
			parseReminderDeliveryContext(assigned, event, 'EMAIL')
		).toMatchObject({
			schemaVersion: 2,
			content: { trigger: 'ASSIGNED' }
		});
		for (const value of [
			{ ...assigned, schemaVersion: 1 },
			{ ...assigned, schemaVersion: 3 },
			{ ...assigned, content: context().content },
			{ ...assigned, content: { ...assigned.content, trigger: 'AT_DUE' } },
			{
				...assigned,
				content: { ...assigned.content, destination: 'injected' }
			}
		])
			expect(() =>
				parseReminderDeliveryContext(value, event, 'EMAIL')
			).toThrow();
	});
	it.each([
		{ eventId: event.reference.id },
		{ workspaceId: event.eventId },
		{ reminderId: event.eventId },
		{ channel: 'TELEGRAM' },
		{ extra: true },
		{ retryAt: new Date().toISOString() },
		{
			destination: { email: 'Person@example.test', telegramChatId: null }
		},
		{
			destination: { email: 'person@example.test', telegramChatId: '123' }
		},
		{ content: { ...context().content, title: 'a'.repeat(201) } },
		{ content: { ...context().content, timeZone: '+03:00' } },
		{ content: { ...context().content, timeZone: 'Mars/Test' } }
	])('rejects mismatched context %j', extra =>
		expect(() =>
			parseReminderDeliveryContext(
				{ ...context(), ...extra },
				event,
				'EMAIL'
			)
		).toThrow()
	);
	it('requires no PII on no-send and bounds the defer instant', () => {
		for (const response of [
			{ ...disabled(), content: context().content },
			disabled(new Date(Date.now() - 1000).toISOString()),
			disabled(new Date(Date.now() + 73 * 3600_000).toISOString())
		])
			expect(() =>
				parseReminderDeliveryContext(response, event, 'EMAIL')
			).toThrow();
	});
	it('does not require configuration for old default consumers', () => {
		expect(() =>
			setupConfig({
				NOTIFICATION_DELIVERY_KINDS: undefined,
				CRM_SALES_INTERNAL_BASE_URL: undefined,
				CRM_SALES_NOTIFICATION_DELIVERY_TOKEN: undefined,
				NOTIFICATION_DELIVERY_CRM_SALES_TOKEN: undefined
			}).service.onModuleInit()
		).not.toThrow();
	});
	it.each([
		{ CRM_SALES_INTERNAL_BASE_URL: 'http://example.test' },
		{ CRM_SALES_INTERNAL_BASE_URL: 'https://user:password@example.test' },
		{ CRM_SALES_INTERNAL_BASE_URL: 'https://example.test/path' },
		{ CRM_SALES_INTERNAL_BASE_URL: 'https://example.test?query=1' },
		{ CRM_SALES_NOTIFICATION_DELIVERY_TOKEN: undefined },
		{ NOTIFICATION_DELIVERY_CRM_SALES_TOKEN: fixtureToken },
		{ NOTIFICATION_DELIVERY_OPERATIONS_TOKEN: fixtureToken },
		{ IDENTITY_NOTIFICATION_DELIVERY_TOKEN: reverseToken },
		{ SMTP_PASSWORD: '' },
		{ TELEGRAM_INFO_BOT_TOKEN: '' }
	])('fails enabled configuration safely %j', extra =>
		expect(() => setupConfig(extra).service.onModuleInit()).toThrow()
	);
	it('makes one bounded scoped POST with reference-only body', async () => {
		const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify(context()), {
				headers: { 'content-type': 'application/json' }
			})
		);
		expect(await setupConfig().service.resolve(event)).toMatchObject({
			deliver: true
		});
		expect(fetchMock).toHaveBeenCalledWith(
			`http://127.0.0.1:4704/internal/v1/notification-delivery/task-reminders/${event.reference.id}/delivery-context`,
			expect.objectContaining({
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
		new Response('private', { status: 403 }),
		new Response('{}', { headers: { 'content-type': 'text/html' } }),
		new Response('x'.repeat(8193), {
			headers: { 'content-type': 'application/json' }
		}),
		new Response(
			JSON.stringify({ ...context(), eventId: event.reference.id }),
			{ headers: { 'content-type': 'application/json' } }
		)
	])(
		'rejects failed/malformed/bounded context without exposing its body',
		async response => {
			jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);
			await expect(setupConfig().service.resolve(event)).rejects.toThrow(
				'WinCRM task reminder context is unavailable'
			);
		}
	);
	it('sanitizes network errors and aborts timed out reads', async () => {
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
			const result = expect(
				setupConfig().service.resolve(event)
			).rejects.toThrow('WinCRM task reminder context is unavailable');
			await jest.advanceTimersByTimeAsync(5000);
			await result;
		} finally {
			jest.useRealTimers();
		}
	});
});

describe('Task reminder adapter uses fresh context and current lease (fake transports)', () => {
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
				{ resolve } as unknown as WincrmTaskReminderContextService
			)
		};
	}
	it('renders escaped branded email with fixed task deep-link and stable message ID only after live claim', async () => {
		const value = setup();
		await value.adapter.deliver(
			'wincrm-task-reminder-email',
			event,
			event.eventId,
			'claim'
		);
		expect(value.sendMail).toHaveBeenCalledWith(
			expect.objectContaining({
				to: context().destination.email,
				subject: 'Напоминание о задаче WinCRM',
				messageId: `<${event.eventId}.wincrm-task-reminder@winwidget.ru>`,
				html: expect.stringContaining(
					`href="https://crm.winwidget.ru/planner?task=${context().content.taskId}"`
				)
			})
		);
		expect(value.sendMail.mock.calls[0][0].html).toContain(
			'&lt;script&gt;'
		);
		expect(value.findFirst.mock.invocationCallOrder[0]).toBeGreaterThan(
			value.resolve.mock.invocationCallOrder[0]
		);
		expect(value.sendMail.mock.invocationCallOrder[0]).toBeGreaterThan(
			value.findFirst.mock.invocationCallOrder[0]
		);
		expect(value.findFirst.mock.calls[0][0].where).toMatchObject({
			eventId: event.eventId,
			consumer: 'wincrm-task-reminder-email',
			status: 'PROCESSING',
			lockToken: 'claim',
			leaseExpiresAt: { gt: expect.any(Date) }
		});
	});
	it('sends plain Telegram text without parse-mode or provider URL in the broker', async () => {
		const value = setup();
		value.resolve.mockResolvedValue({
			...context(),
			channel: 'TELEGRAM',
			destination: { email: null, telegramChatId: '123' }
		});
		await value.adapter.deliver(
			'wincrm-task-reminder-telegram',
			{ ...event, eventType: TELEGRAM },
			event.eventId,
			'claim'
		);
		expect(value.sendMessage).toHaveBeenCalledWith(
			'123',
			expect.stringContaining(context().content.title),
			{ parseMode: null }
		);
		expect(value.sendMail).not.toHaveBeenCalled();
		expect(value.sendMessage.mock.calls[0][1]).toContain(
			`https://crm.winwidget.ru/planner?task=${context().content.taskId}`
		);
	});
	it('renders assignment wording through the same branded email and leased Telegram adapters', async () => {
		const value = setup();
		value.resolve.mockResolvedValue({
			...context(),
			schemaVersion: 2,
			content: { ...context().content, trigger: 'ASSIGNED' }
		});
		await value.adapter.deliver(
			'wincrm-task-reminder-email',
			event,
			event.eventId,
			'claim'
		);
		expect(value.sendMail.mock.calls[0][0].subject).toBe(
			'Назначение задачи WinCRM'
		);
		expect(value.sendMail.mock.calls[0][0].html).toContain(
			'Назначение задачи'
		);
		expect(value.sendMail.mock.calls[0][0].html).toContain(
			'&lt;script&gt;'
		);
		value.resolve.mockResolvedValue({
			...context(),
			schemaVersion: 2,
			channel: 'TELEGRAM',
			destination: { email: null, telegramChatId: '123' },
			content: { ...context().content, trigger: 'ASSIGNED' }
		});
		await value.adapter.deliver(
			'wincrm-task-reminder-telegram',
			{ ...event, eventType: TELEGRAM },
			event.eventId,
			'claim'
		);
		expect(value.sendMessage.mock.calls[0][1]).toMatch(
			/^Назначение задачи WinCRM\n/
		);
		expect(value.sendMessage.mock.calls[0][2]).toEqual({
			parseMode: null
		});
	});
	it.each([null, { leaseExpiresAt: new Date(0) }])(
		'never sends after the claim is lost/expired',
		async claim => {
			const value = setup();
			value.findFirst.mockResolvedValue(claim);
			await expect(
				value.adapter.deliver(
					'wincrm-task-reminder-email',
					event,
					event.eventId,
					'claim'
				)
			).rejects.toThrow('claim is no longer active');
			expect(value.sendMail).not.toHaveBeenCalled();
		}
	);
	it('does not send obsolete reminders or quiet-hours deferrals', async () => {
		const value = setup();
		value.resolve.mockResolvedValue(disabled());
		expect(
			await value.adapter.deliver(
				'wincrm-task-reminder-email',
				event,
				event.eventId,
				'claim'
			)
		).toEqual({ status: 'SKIPPED', reason: 'TASK_REMINDER_UNAVAILABLE' });
		const retryAt = new Date(Date.now() + 60_000).toISOString();
		value.resolve.mockResolvedValue(disabled(retryAt));
		expect(
			await value.adapter.deliver(
				'wincrm-task-reminder-email',
				event,
				event.eventId,
				'claim'
			)
		).toEqual({ status: 'DEFERRED', retryAt });
		expect(value.sendMail).not.toHaveBeenCalled();
		expect(value.findFirst).not.toHaveBeenCalled();
	});
	it('rejects channel/id/unclaimed commands before context lookup', async () => {
		const value = setup();
		for (const [kind, id, claim] of [
			['wincrm-task-reminder-email', event.eventId, undefined],
			['wincrm-task-reminder-telegram', event.eventId, 'claim'],
			['wincrm-task-reminder-email', event.reference.id, 'claim']
		] as const)
			await expect(
				value.adapter.deliver(kind, event, id, claim)
			).rejects.toThrow();
		expect(value.resolve).not.toHaveBeenCalled();
	});
});

describe('Private Sales reminder readiness', () => {
	it('uses the exact agreed GET endpoint (delivery-context uses POST separately)', () => {
		expect(
			Reflect.getMetadata(
				PATH_METADATA,
				WincrmTaskReminderReadinessController
			)
		).toBe('internal/v1/crm-sales/task-reminders');
		expect(
			Reflect.getMetadata(
				PATH_METADATA,
				WincrmTaskReminderReadinessController.prototype.readiness
			)
		).toBe('readiness');
		expect(
			Reflect.getMetadata(
				METHOD_METADATA,
				WincrmTaskReminderReadinessController.prototype.readiness
			)
		).toBe(RequestMethod.GET);
	});
	const request = (
		remoteAddress = '127.0.0.1',
		caller = 'crm-sales',
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
	it('requires exact private pair credentials and actual socket loopback', () => {
		const guard = new WincrmTaskReminderReadinessGuard(
			setupConfig().config
		);
		expect(guard.canActivate(request())).toBe(true);
		for (const req of [
			request('192.0.2.1'),
			request('127.0.0.1', 'operations'),
			request('127.0.0.1', 'crm-sales', fixtureToken),
			request('127.0.0.1', 'crm-sales', [reverseToken])
		])
			expect(() => guard.canActivate(req)).toThrow();
		expect(() =>
			new WincrmTaskReminderReadinessGuard(
				setupConfig({
					NOTIFICATION_DELIVERY_CRM_SALES_TOKEN: fixtureToken
				}).config
			).canActivate(request())
		).toThrow();
	});
	it('never claims readiness without both running consumers, worker/broker/outbox and transport configuration', async () => {
		const getReadinessHealth = jest
			.fn()
			.mockResolvedValue({ status: 'ready' });
		const isReadyForKinds = jest.fn().mockReturnValue(true);
		const controller = new WincrmTaskReminderReadinessController(
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
		isReadyForKinds.mockReturnValue(false);
		await expect(controller.readiness()).rejects.toMatchObject({
			status: 503
		});
		isReadyForKinds.mockReturnValue(true);
		getReadinessHealth.mockRejectedValue(new Error('private detail'));
		await expect(controller.readiness()).rejects.toThrow(
			'CRM reminder delivery is not ready'
		);
	});
	it('SQL migration only appends the two kinds/routes to the previous CHECK contracts', () => {
		const root = join(__dirname, '../../prisma/migrations');
		const prior = readFileSync(
			join(
				root,
				'20260907000000_add_wincrm_invitation_email/migration.sql'
			),
			'utf8'
		);
		let added = readFileSync(
			join(root, '20260907230000_add_wincrm_task_reminders/migration.sql'),
			'utf8'
		);
		added = added
			.replace(
				/,\n\s*'wincrm-task-reminder-email',\n\s*'wincrm-task-reminder-telegram'/g,
				''
			)
			.replace(
				/,\n\s*'manual.wincrm-task-reminder-email',\n\s*'manual.wincrm-task-reminder-telegram'/g,
				''
			)
			.replace(
				/,\n\s*'wincrm-task-reminder-email.dead-letter',\n\s*'wincrm-task-reminder-telegram.dead-letter'/g,
				''
			)
			.replace(
				/\n\t\tAND \(\n\t\t\t"routing_key" NOT IN \('manual.wincrm-task-reminder-(?:email|telegram)'[^]*?\n\t\t\)/g,
				''
			);
		expect(added).toBe(prior);
	});
});
