import { NotificationDeliveryAdapterService } from './notification-delivery-adapter.service';
import type { EmailService } from '../email/email.service';
import type { TelegramInfoTransportService } from '../telegram/telegram-info-transport.service';

describe('NotificationDeliveryAdapterService', () => {
	const email = {
		sendLeadNotification: jest.fn().mockResolvedValue(undefined),
		sendPaymentSucceededNotification: jest
			.fn()
			.mockResolvedValue(undefined),
		sendLimitReachedNotification: jest.fn().mockResolvedValue(undefined)
	} as unknown as EmailService;
	const telegram = {
		sendMessage: jest.fn().mockResolvedValue(undefined)
	} as unknown as TelegramInfoTransportService;
	const service = new NotificationDeliveryAdapterService(email, telegram);

	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('delivers a lead email using only the event destination', async () => {
		await service.deliver(
			'email',
			{
				schemaVersion: 2,
				eventType: 'lead.integration.requested.v2',
				integration: 'email',
				source: 'widget',
				entity: { id: 'widget-1', name: 'Колесо' },
				lead: {
					id: 'lead-1',
					name: 'Анна',
					phone: '+79990000000',
					createdAt: '2026-07-27T10:00:00.000Z'
				},
				destination: { email: 'owner@example.com' }
			},
			'11111111-1111-4111-8111-111111111111'
		);

		expect(email.sendLeadNotification).toHaveBeenCalledWith(
			'owner@example.com',
			expect.objectContaining({
				widgetName: 'Колесо',
				name: 'Анна',
				phone: '+79990000000'
			}),
			{
				messageId: '<11111111-1111-4111-8111-111111111111@winwidget.ru>'
			}
		);
	});

	it('delivers a lead Telegram notification using the inline chat id', async () => {
		await service.deliver(
			'telegram',
			{
				schemaVersion: 2,
				eventType: 'lead.integration.requested.v2',
				integration: 'telegram',
				source: 'calculator',
				entity: { id: 'calculator-1', name: 'Расчёт <стоимости>' },
				lead: {
					id: 'lead-1',
					calculatedPrice: '5000',
					currency: '₽',
					createdAt: '2026-07-27T10:00:00.000Z'
				},
				destination: { telegramChatId: '12345' }
			},
			'11111111-1111-4111-8111-111111111111'
		);

		expect(telegram.sendMessage).toHaveBeenCalledWith(
			'12345',
			expect.stringContaining('Расчёт &lt;стоимости&gt;'),
			{ parseMode: 'HTML' }
		);
	});

	it('does not repeat a normalized phone as the generic contact', async () => {
		await service.deliver(
			'telegram',
			{
				schemaVersion: 2,
				eventType: 'lead.integration.requested.v2',
				integration: 'telegram',
				source: 'widget',
				entity: { id: 'widget-1', name: 'Колесо фортуны' },
				lead: {
					id: 'lead-1',
					phone: '+7 995 151-01-01',
					contact: '+79951510101',
					createdAt: '2026-07-27T10:00:00.000Z'
				},
				destination: { telegramChatId: '12345' }
			},
			'11111111-1111-4111-8111-111111111111'
		);

		const message = (telegram.sendMessage as jest.Mock).mock.calls[0][1];

		expect(message).toContain('Телефон: +7 995 151-01-01');
		expect(message).not.toContain('Контакт:');
	});

	it('keeps a distinct generic contact in the Telegram notification', async () => {
		await service.deliver(
			'telegram',
			{
				schemaVersion: 2,
				eventType: 'lead.integration.requested.v2',
				integration: 'telegram',
				source: 'widget',
				entity: { id: 'widget-1', name: 'Колесо фортуны' },
				lead: {
					id: 'lead-1',
					phone: '+79951510101',
					contact: '@winwidget_client',
					createdAt: '2026-07-27T10:00:00.000Z'
				},
				destination: { telegramChatId: '12345' }
			},
			'11111111-1111-4111-8111-111111111111'
		);

		const message = (telegram.sendMessage as jest.Mock).mock.calls[0][1];

		expect(message).toContain('Контакт: @winwidget_client');
	});

	it('delivers a payment email and skips it when email is null', async () => {
		const payload = {
			schemaVersion: 1 as const,
			eventType: 'payment.succeeded.v1' as const,
			payment: {
				id: 'payment-1',
				yookassaId: 'yookassa-1',
				amount: '1000',
				plan: 'EASY' as any,
				billingPeriod: 'MONTHLY' as any,
				succeededAt: '2026-07-27T10:00:00.000Z'
			},
			user: {
				id: 'user-1',
				name: 'Анна',
				email: 'owner@example.com',
				phone: null
			},
			subscription: { expiresAt: '2026-08-27T10:00:00.000Z' }
		};

		await service.deliver(
			'payment-email',
			payload,
			'11111111-1111-4111-8111-111111111111'
		);
		await service.deliver(
			'payment-email',
			{
				...payload,
				user: { ...payload.user, email: null }
			},
			'22222222-2222-4222-8222-222222222222'
		);

		expect(email.sendPaymentSucceededNotification).toHaveBeenCalledTimes(
			1
		);
		expect(email.sendPaymentSucceededNotification).toHaveBeenCalledWith(
			'owner@example.com',
			expect.objectContaining({
				amount: '1000',
				planLabel: 'Easy',
				billingPeriodLabel: 'месяц'
			}),
			'11111111-1111-4111-8111-111111111111'
		);
	});

	it('delivers a limit email with a stable provider message id', async () => {
		await service.deliver(
			'limit-email',
			{
				schemaVersion: 2,
				eventType: 'lead.limit.reached.email.v2',
				entity: { id: 'widget-1', name: 'Колесо', type: 'widget' },
				limit: 10,
				destination: { email: 'owner@example.com' }
			},
			'11111111-1111-4111-8111-111111111111'
		);

		expect(email.sendLimitReachedNotification).toHaveBeenCalledWith(
			'owner@example.com',
			'Колесо',
			10,
			{
				messageId:
					'<11111111-1111-4111-8111-111111111111.limit@winwidget.ru>'
			}
		);
	});

	it('delivers a prepared payment Telegram notification to its snapshotted topic', async () => {
		await service.deliver(
			'payment-telegram',
			{
				schemaVersion: 1,
				eventType: 'payment.notification.telegram.requested.v1',
				payment: {
					id: 'payment-<1>',
					yookassaId: 'yookassa-&1',
					amount: '1000',
					plan: 'EASY',
					billingPeriod: 'MONTHLY',
					succeededAt: '2026-07-27T10:00:00.000Z'
				},
				user: {
					id: 'user-<1>',
					name: 'Анна & Иван',
					email: 'owner@example.com',
					phone: null
				},
				destination: {
					telegramChatId: '-1001234567890',
					messageThreadId: 42
				}
			},
			'11111111-1111-4111-8111-111111111111'
		);

		expect(telegram.sendMessage).toHaveBeenCalledWith(
			'-1001234567890',
			expect.stringContaining(
				'<b>ID платежа:</b> <code>payment-&lt;1&gt;</code>'
			),
			{ messageThreadId: 42, parseMode: 'HTML' }
		);
		const text = (telegram.sendMessage as jest.Mock).mock.calls[0][1];
		expect(text).toContain('<b>Пользователь:</b> Анна &amp; Иван');
		expect(text).toContain(
			'<b>ID YooKassa:</b> <code>yookassa-&amp;1</code>'
		);
	});

	it('rejects a payment Telegram event without a complete destination snapshot', async () => {
		const promise = service.deliver(
			'payment-telegram',
			{
				schemaVersion: 1,
				eventType: 'payment.notification.telegram.requested.v1',
				payment: {
					id: 'payment-1',
					yookassaId: 'yookassa-1',
					amount: '1000',
					plan: 'EASY',
					billingPeriod: 'MONTHLY',
					succeededAt: '2026-07-27T10:00:00.000Z'
				},
				user: {
					id: 'user-1',
					name: null,
					email: null,
					phone: null
				},
				destination: {
					telegramChatId: null,
					messageThreadId: null
				}
			},
			'11111111-1111-4111-8111-111111111111'
		);

		await expect(promise).rejects.toMatchObject({
			code: 'DESTINATION_CONFIGURATION_MISSING'
		});
		expect(telegram.sendMessage).not.toHaveBeenCalled();
	});

	it('delivers the limit Telegram notification with escaped entity name', async () => {
		await service.deliver(
			'limit-telegram',
			{
				schemaVersion: 2,
				eventType: 'lead.limit.reached.telegram.v2',
				entity: {
					id: 'widget-1',
					name: 'Колесо <продаж>',
					type: 'widget'
				},
				limit: 10,
				destination: { telegramChatId: '12345' }
			},
			'11111111-1111-4111-8111-111111111111'
		);

		expect(telegram.sendMessage).toHaveBeenCalledWith(
			'12345',
			[
				'⚠️ <b>Лимит заявок исчерпан</b>',
				'Колесо &lt;продаж&gt; принял последнюю заявку (10 из 10).',
				'',
				'Новые заявки больше не принимаются.',
				'Для продолжения работы перейдите на платный тариф:',
				'👉 https://winwidget.ru/#pricing'
			].join('\n'),
			{ parseMode: 'HTML' }
		);
	});
});
