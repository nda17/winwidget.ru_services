import { NotificationDeliveryAdapterService } from './notification-delivery-adapter.service';
import LeadNotificationEmail from '../../emails/lead-notification.email';
import type { EmailService } from '../email/email.service';
import type { NotificationDeliveryPrismaService } from './prisma/notification-delivery-prisma.service';
import type { TelegramInfoTransportService } from '../telegram/telegram-info-transport.service';
import { render } from '@react-email/render';

describe('NotificationDeliveryAdapterService', () => {
	const email = {
		sendLeadNotification: jest.fn().mockResolvedValue(undefined),
		sendPaymentSucceededNotification: jest
			.fn()
			.mockResolvedValue(undefined),
		sendLimitReachedNotification: jest.fn().mockResolvedValue(undefined),
		sendAdminBroadcast: jest.fn().mockResolvedValue(undefined),
		sendSubscriptionExpiryReminder: jest.fn().mockResolvedValue(undefined)
	} as unknown as EmailService;
	const telegram = {
		sendMessage: jest.fn().mockResolvedValue(undefined)
	} as unknown as TelegramInfoTransportService;
	const prisma = {} as NotificationDeliveryPrismaService;
	const service = new NotificationDeliveryAdapterService(
		email,
		telegram,
		prisma
	);

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
					bonus: 'Скидку 10%',
					url: 'https://example.com/catalog?utm_source=widget',
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
				phone: '+79990000000',
				bonus: 'Скидку 10%',
				bonusLabel: 'Клиент выиграл',
				url: 'https://example.com/catalog?utm_source=widget'
			}),
			{
				messageId: '<11111111-1111-4111-8111-111111111111@winwidget.ru>'
			}
		);
	});

	it('labels the calculator price as cost in email', async () => {
		await service.deliver(
			'email',
			{
				schemaVersion: 2,
				eventType: 'lead.integration.requested.v2',
				integration: 'email',
				source: 'calculator',
				entity: { id: 'calculator-1', name: 'Калькулятор' },
				lead: {
					id: 'lead-1',
					calculatedPrice: '5000',
					currency: '₽',
					createdAt: '2026-07-27T10:00:00.000Z'
				},
				destination: { email: 'owner@example.com' }
			},
			'11111111-1111-4111-8111-111111111111'
		);

		expect(email.sendLeadNotification).toHaveBeenCalledWith(
			'owner@example.com',
			expect.objectContaining({
				widgetName: 'Калькулятор',
				bonus: '5000 ₽',
				bonusLabel: 'Стоимость'
			}),
			{
				messageId: '<11111111-1111-4111-8111-111111111111@winwidget.ru>'
			}
		);
	});

	it('renders the custom wheel prize label and keeps the email fallback', () => {
		const wheelHtml = render(
			LeadNotificationEmail({
				widgetName: 'Колесо',
				bonus: 'Скидку 10%',
				bonusLabel: 'Клиент выиграл',
				dateLabel: '29.07.2026, 21:37:46'
			})
		);
		const fallbackHtml = render(
			LeadNotificationEmail({
				widgetName: 'Квиз',
				bonus: 'Промокод',
				dateLabel: '29.07.2026, 21:37:46'
			})
		);

		expect(wheelHtml).toContain('Клиент выиграл');
		expect(wheelHtml).toContain('Скидку 10%');
		expect(wheelHtml).not.toContain('Выигранный приз');
		expect(fallbackHtml).toContain('Выигранный приз');
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

		const message = (telegram.sendMessage as jest.Mock).mock.calls[0][1];

		expect(telegram.sendMessage).toHaveBeenCalledWith(
			'12345',
			expect.stringContaining('Расчёт &lt;стоимости&gt;'),
			{ parseMode: 'HTML' }
		);
		expect(message).toContain('Расчёт &lt;стоимости&gt;');
		expect(message).toContain('Стоимость: 5000 ₽');
		expect(message.match(/Стоимость: 5000 ₽/g)).toHaveLength(1);
		expect(message).not.toContain('Результат:');
		expect(message).not.toContain('Клиент выиграл:');
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

	it('delivers a prepared campaign email with a stable provider id', async () => {
		await service.deliver(
			'campaign-email',
			{
				schemaVersion: 1,
				eventType: 'notification.campaign.email.requested.v1',
				reference: {
					type: 'mailing-delivery',
					id: '22222222-2222-4222-8222-222222222222',
					aggregateId: '33333333-3333-4333-8333-333333333333'
				},
				destination: { email: 'owner@example.com' },
				content: {
					subject: 'Новости',
					message: 'Текст рассылки'
				}
			},
			'11111111-1111-4111-8111-111111111111'
		);

		expect(email.sendAdminBroadcast).toHaveBeenCalledWith(
			'owner@example.com',
			{
				subject: 'Новости',
				message: 'Текст рассылки'
			},
			{
				messageId:
					'<11111111-1111-4111-8111-111111111111.mailing@winwidget.ru>'
			}
		);
	});

	it('resumes a chunked campaign Telegram delivery from its service checkpoint', async () => {
		const checkpointPrisma = {
			notificationDeliveryReceipt: {
				findFirst: jest.fn().mockResolvedValue({
					checkpoint: { nextChunkIndex: 1 }
				}),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		} as unknown as NotificationDeliveryPrismaService;
		const checkpointService = new NotificationDeliveryAdapterService(
			email,
			telegram,
			checkpointPrisma
		);

		await checkpointService.deliver(
			'campaign-telegram',
			{
				schemaVersion: 1,
				eventType: 'notification.campaign.telegram.requested.v1',
				reference: {
					type: 'mailing-delivery',
					id: '22222222-2222-4222-8222-222222222222',
					aggregateId: '33333333-3333-4333-8333-333333333333'
				},
				destination: { telegramChatId: '12345' },
				content: {
					subject: 'Новости',
					message: 'a'.repeat(3601)
				}
			},
			'11111111-1111-4111-8111-111111111111',
			'44444444-4444-4444-8444-444444444444'
		);

		expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
		expect(telegram.sendMessage).toHaveBeenCalledWith(
			'12345',
			'a'.repeat(101),
			{ parseMode: null }
		);
		expect(
			checkpointPrisma.notificationDeliveryReceipt.updateMany
		).toHaveBeenCalledWith({
			where: {
				eventId: '11111111-1111-4111-8111-111111111111',
				consumer: 'campaign-telegram',
				status: 'PROCESSING',
				lockToken: '44444444-4444-4444-8444-444444444444'
			},
			data: {
				checkpoint: { nextChunkIndex: 2 }
			}
		});
	});

	it('shows the wheel prize and full page URL in Telegram', async () => {
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
					bonus: 'Скидку 10%',
					url: 'https://example.com/catalog?utm_source=widget',
					createdAt: '2026-07-27T10:00:00.000Z'
				},
				destination: { telegramChatId: '12345' }
			},
			'11111111-1111-4111-8111-111111111111'
		);

		const message = (telegram.sendMessage as jest.Mock).mock.calls[0][1];

		expect(message).toContain('Клиент выиграл: Скидку 10%');
		expect(message).toContain(
			'Страница: https://example.com/catalog?utm_source=widget'
		);
		expect(message).not.toContain('Результат:');
	});

	it('delivers daily summary and subscription expiry Telegram events', async () => {
		await service.deliver(
			'daily-summary-delivery-telegram',
			{
				schemaVersion: 1,
				eventType: 'notification.daily-summary.telegram.requested.v1',
				reference: {
					type: 'daily-summary-job',
					id: '22222222-2222-4222-8222-222222222222'
				},
				destination: {
					telegramChatId: '-100123',
					messageThreadId: 42
				},
				content: { text: '<b>Итоги дня</b>' }
			},
			'11111111-1111-4111-8111-111111111111'
		);
		await service.deliver(
			'subscription-expiry-telegram',
			{
				schemaVersion: 1,
				eventType:
					'notification.subscription-expiry.telegram.requested.v1',
				reference: {
					type: 'subscription-expiry-reminder',
					id: '33333333-3333-4333-8333-333333333333'
				},
				destination: { telegramChatId: '12345' },
				content: {
					daysBeforeExpiry: 3,
					planLabel: 'Easy <test>',
					expiresAtLabel: '31.07.2026, 12:00'
				}
			},
			'55555555-5555-4555-8555-555555555555'
		);

		expect(telegram.sendMessage).toHaveBeenNthCalledWith(
			1,
			'-100123',
			'<b>Итоги дня</b>',
			{ messageThreadId: 42, parseMode: 'HTML' }
		);
		expect(telegram.sendMessage).toHaveBeenNthCalledWith(
			2,
			'12345',
			expect.stringContaining('Easy &lt;test&gt;'),
			{ parseMode: 'HTML' }
		);
	});

	it('delivers a subscription expiry email through the service template', async () => {
		await service.deliver(
			'subscription-expiry-email',
			{
				schemaVersion: 1,
				eventType: 'notification.subscription-expiry.email.requested.v1',
				reference: {
					type: 'subscription-expiry-reminder',
					id: '33333333-3333-4333-8333-333333333333'
				},
				destination: { email: 'owner@example.com' },
				content: {
					daysBeforeExpiry: 3,
					planLabel: 'Easy',
					expiresAtLabel: '31.07.2026, 12:00'
				}
			},
			'11111111-1111-4111-8111-111111111111'
		);

		expect(email.sendSubscriptionExpiryReminder).toHaveBeenCalledWith(
			'owner@example.com',
			{
				daysBeforeExpiry: 3,
				planLabel: 'Easy',
				expiresAtLabel: '31.07.2026, 12:00'
			},
			{
				messageId:
					'<11111111-1111-4111-8111-111111111111.subscription-expiry@winwidget.ru>'
			}
		);
	});
});
