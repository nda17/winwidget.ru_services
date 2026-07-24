import { IntegrationDeliveryService } from '@/messaging/integration-delivery.service';
import type { LeadIntegrationEventPayload } from '@/messaging/lead-integration-event';
import type { EmailService } from '@/email/email.service';
import type { SafeOutboundHttpService } from '@/safe-outbound-http/safe-outbound-http.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '@/prisma.service';
import type { DailySummaryDeliveryService } from '@/reports/daily-summary-delivery.service';
import {
	MailingCampaignStatus,
	MailingDeliveryChannel,
	MailingDeliveryStatus
} from '@prisma/client';

const createEvent = (
	overrides: Partial<LeadIntegrationEventPayload> = {}
): LeadIntegrationEventPayload => ({
	schemaVersion: 1,
	integration: 'webhook',
	source: 'widget',
	entity: { id: 'widget-1', name: 'Колесо' },
	lead: {
		id: 'lead-1',
		contact: '+79990000000',
		phone: '+79990000000',
		createdAt: '2026-07-23T12:00:00.000Z'
	},
	destination: {
		webhookUrl: 'https://example.com/webhook'
	},
	...overrides
});

describe('IntegrationDeliveryService', () => {
	const createService = () => {
		const emailService = {
			sendLeadNotification: jest.fn().mockResolvedValue(undefined),
			sendPaymentSucceededNotification: jest
				.fn()
				.mockResolvedValue(undefined)
		} as unknown as EmailService;
		const safeOutboundHttpService = {
			postJson: jest.fn().mockResolvedValue(undefined),
			getAmoCrmApiUrl: jest.fn()
		} as unknown as SafeOutboundHttpService;
		const configService = {
			get: jest.fn()
		} as unknown as ConfigService;
		const prisma = {
			telegramBotSettings: {
				findUnique: jest.fn()
			}
		} as unknown as PrismaService;

		return {
			service: new IntegrationDeliveryService(
				emailService,
				safeOutboundHttpService,
				configService,
				prisma,
				{
					deliver: jest.fn().mockResolvedValue(undefined)
				} as unknown as DailySummaryDeliveryService
			),
			safeOutboundHttpService,
			emailService
		};
	};

	it('sends a versioned webhook with a stable event id', async () => {
		const { service, safeOutboundHttpService } = createService();

		await service.deliver('webhook', createEvent(), 'event-1');

		expect(safeOutboundHttpService.postJson).toHaveBeenCalledWith(
			'https://example.com/webhook',
			expect.objectContaining({
				eventId: 'event-1',
				eventType: 'lead.created.v1',
				source: 'widget',
				lead: expect.objectContaining({ id: 'lead-1' })
			}),
			{
				policy: 'webhook',
				headers: { 'X-WinWidget-Event-Id': 'event-1' }
			}
		);
	});

	it('sends a payment email from the payment consumer', async () => {
		const { service, emailService } = createService();

		await service.deliver(
			'payment-email',
			{
				schemaVersion: 1,
				eventType: 'payment.succeeded.v1',
				payment: {
					id: 'payment-1',
					yookassaId: 'yookassa-1',
					amount: '990.00',
					plan: 'EASY',
					billingPeriod: 'MONTHLY',
					succeededAt: '2026-07-23T12:00:00.000Z'
				},
				user: {
					id: 'user-1',
					name: 'Иван',
					email: 'user@example.com',
					phone: null
				},
				subscription: {
					expiresAt: '2026-08-23T12:00:00.000Z'
				}
			},
			'event-1'
		);

		expect(
			emailService.sendPaymentSucceededNotification
		).toHaveBeenCalledWith(
			'user@example.com',
			expect.objectContaining({
				amount: '990.00',
				planLabel: 'Easy',
				billingPeriodLabel: 'месяц'
			}),
			'event-1'
		);
	});

	it('rejects a message routed to the wrong integration consumer', async () => {
		const { service } = createService();

		await expect(
			service.deliver('email', createEvent(), 'event-1')
		).rejects.toThrow(
			'Integration mismatch: queue=email, payload=webhook'
		);
	});
});

describe('IntegrationDeliveryService mailing delivery', () => {
	const campaignId = '11111111-1111-4111-8111-111111111111';
	const deliveryId = '22222222-2222-4222-8222-222222222222';
	const eventId = '33333333-3333-4333-8333-333333333333';
	const event = {
		schemaVersion: 1 as const,
		eventType: 'mailing.delivery.requested.v1' as const,
		campaignId,
		deliveryId,
		channel: MailingDeliveryChannel.EMAIL
	};
	const telegramEvent = {
		...event,
		channel: MailingDeliveryChannel.TELEGRAM
	};

	afterEach(() => {
		jest.restoreAllMocks();
	});

	const mockTelegramFetchBody = (status: number, responseBody: string) =>
		jest.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: status >= 200 && status < 300,
			status,
			text: jest.fn().mockResolvedValue(responseBody)
		} as unknown as Response);

	const mockTelegramFetch = (status = 200, description = 'OK') =>
		mockTelegramFetchBody(
			status,
			JSON.stringify({
				ok: status >= 200 && status < 300,
				error_code: status,
				description
			})
		);

	const createService = (
		status: MailingDeliveryStatus = MailingDeliveryStatus.PENDING,
		campaignStatus: MailingCampaignStatus = MailingCampaignStatus.QUEUED,
		channel: MailingDeliveryChannel = MailingDeliveryChannel.EMAIL
	) => {
		const deliveryRecord = {
			id: deliveryId,
			campaignId,
			channel,
			recipient:
				channel === MailingDeliveryChannel.TELEGRAM
					? '123456789'
					: 'user@example.com',
			status,
			updatedAt: new Date(),
			campaign: {
				id: campaignId,
				status: campaignStatus,
				cancelRequestedAt:
					campaignStatus === MailingCampaignStatus.CANCELLED
						? new Date()
						: null,
				subject: 'Новости',
				message: 'Текст рассылки'
			}
		};
		const emailService = {
			sendAdminBroadcast: jest.fn().mockResolvedValue(undefined)
		} as unknown as EmailService;
		const transaction = {
			mailingDelivery: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
				count: jest.fn().mockResolvedValue(0)
			},
			mailingCampaign: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
				update: jest.fn().mockResolvedValue({ failedCount: 0 })
			}
		};
		const notificationChannelUpdateMany = jest
			.fn()
			.mockResolvedValue({ count: 1 });
		const prisma = {
			mailingDelivery: {
				findUnique: jest.fn().mockResolvedValue(deliveryRecord),
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			telegramNotificationChannel: {
				updateMany: notificationChannelUpdateMany
			},
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const service = new IntegrationDeliveryService(
			emailService,
			{} as SafeOutboundHttpService,
			{
				get: jest.fn().mockReturnValue('telegram-token')
			} as unknown as ConfigService,
			prisma,
			{
				deliver: jest.fn().mockResolvedValue(undefined)
			} as unknown as DailySummaryDeliveryService
		);

		return {
			service,
			emailService,
			prisma,
			transaction,
			deliveryRecord,
			notificationChannelUpdateMany
		};
	};

	it('sends only after an atomic PENDING to PROCESSING claim', async () => {
		const { service, emailService, transaction } = createService();

		await service.deliver('mailing-email', event, eventId);

		expect(transaction.mailingDelivery.updateMany).toHaveBeenNthCalledWith(
			1,
			{
				where: {
					id: deliveryId,
					campaignId,
					status: MailingDeliveryStatus.PENDING
				},
				data: {
					status: MailingDeliveryStatus.PROCESSING,
					attempts: { increment: 1 }
				}
			}
		);
		expect(emailService.sendAdminBroadcast).toHaveBeenCalledTimes(1);
	});

	it('omits parse_mode from a plain-text Telegram mailing request', async () => {
		const fetchMock = mockTelegramFetch();
		const { service } = createService(
			MailingDeliveryStatus.PENDING,
			MailingCampaignStatus.QUEUED,
			MailingDeliveryChannel.TELEGRAM
		);

		await service.deliver('mailing-telegram', telegramEvent, eventId);

		const request = fetchMock.mock.calls[0][1] as RequestInit;
		const body = JSON.parse(request.body as string) as Record<
			string,
			unknown
		>;
		expect(body).toEqual({
			chat_id: '123456789',
			text: 'Новости\n\nТекст рассылки'
		});
		expect(body).not.toHaveProperty('parse_mode');
	});

	it('keeps HTML parse_mode for Telegram messages that require formatting', async () => {
		const fetchMock = mockTelegramFetch();
		const { service } = createService();

		await service.deliver(
			'limit-telegram',
			{
				schemaVersion: 1,
				eventType: 'lead.limit.reached.v1',
				entity: {
					id: 'widget-1',
					name: 'Колесо',
					type: 'WIDGET'
				},
				limit: 10,
				destinations: {
					emails: [],
					telegramChatId: '123456789'
				}
			},
			eventId
		);

		const request = fetchMock.mock.calls[0][1] as RequestInit;
		const body = JSON.parse(request.body as string) as Record<
			string,
			unknown
		>;
		expect(body.parse_mode).toBe('HTML');
	});

	it('does not deactivate a Telegram channel for a formatting-related 400', async () => {
		mockTelegramFetch(400, 'Bad Request: unsupported parse_mode');
		const { service, notificationChannelUpdateMany } = createService(
			MailingDeliveryStatus.PENDING,
			MailingCampaignStatus.QUEUED,
			MailingDeliveryChannel.TELEGRAM
		);

		await expect(
			service.deliver('mailing-telegram', telegramEvent, eventId)
		).rejects.toThrow('Bad Request: unsupported parse_mode');

		expect(notificationChannelUpdateMany).not.toHaveBeenCalled();
	});

	it.each([
		[400, 'Bad Request'],
		[
			429,
			JSON.stringify({
				ok: false,
				error_code: 429,
				description: 'Too Many Requests: retry later'
			})
		],
		[
			502,
			JSON.stringify({
				ok: false,
				error_code: 502,
				description: 'Bad Gateway'
			})
		]
	])(
		'does not deactivate a Telegram channel for transient or unclassified error %i',
		async (status, responseBody) => {
			mockTelegramFetchBody(status, responseBody);
			const { service, notificationChannelUpdateMany } = createService(
				MailingDeliveryStatus.PENDING,
				MailingCampaignStatus.QUEUED,
				MailingDeliveryChannel.TELEGRAM
			);

			await expect(
				service.deliver('mailing-telegram', telegramEvent, eventId)
			).rejects.toThrow(`Telegram API returned ${status}`);

			expect(notificationChannelUpdateMany).not.toHaveBeenCalled();
		}
	);

	it.each([
		[400, 'Bad Request: chat not found'],
		[400, 'Bad Request: user is deactivated'],
		[403, 'Forbidden: bot was blocked by the user']
	])(
		'deactivates a Telegram channel for permanent error %i %s',
		async (status, description) => {
			mockTelegramFetch(status, description);
			const { service, notificationChannelUpdateMany } = createService(
				MailingDeliveryStatus.PENDING,
				MailingCampaignStatus.QUEUED,
				MailingDeliveryChannel.TELEGRAM
			);

			await expect(
				service.deliver('mailing-telegram', telegramEvent, eventId)
			).rejects.toThrow(description);

			expect(notificationChannelUpdateMany).toHaveBeenCalledWith({
				where: { chatId: '123456789' },
				data: {
					isActive: false,
					disabledAt: expect.any(Date)
				}
			});
		}
	);

	it('does not send when cancellation wins the claim race', async () => {
		const { service, emailService, prisma, transaction, deliveryRecord } =
			createService();
		(
			transaction.mailingDelivery.updateMany as jest.Mock
		).mockResolvedValueOnce({ count: 0 });
		(prisma.mailingDelivery.findUnique as jest.Mock)
			.mockResolvedValueOnce(deliveryRecord)
			.mockResolvedValueOnce({
				status: MailingDeliveryStatus.CANCELLED
			});

		await service.deliver('mailing-email', event, eventId);

		expect(emailService.sendAdminBroadcast).not.toHaveBeenCalled();
	});

	it('does not treat a FAILED delivery as successful', async () => {
		const { service, emailService } = createService(
			MailingDeliveryStatus.FAILED
		);

		await expect(
			service.deliver('mailing-email', event, eventId)
		).rejects.toThrow('Mailing delivery is in FAILED state');
		expect(emailService.sendAdminBroadcast).not.toHaveBeenCalled();
	});

	it('cancels a pending delivery and increments the campaign atomically', async () => {
		const { service, emailService, prisma, transaction } = createService(
			MailingDeliveryStatus.PENDING,
			MailingCampaignStatus.CANCELLED
		);

		await service.deliver('mailing-email', event, eventId);

		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(transaction.mailingDelivery.updateMany).toHaveBeenCalledWith({
			where: {
				id: deliveryId,
				campaignId,
				status: {
					in: [
						MailingDeliveryStatus.PENDING,
						MailingDeliveryStatus.PROCESSING
					]
				}
			},
			data: {
				status: MailingDeliveryStatus.CANCELLED,
				cancelledAt: expect.any(Date)
			}
		});
		expect(transaction.mailingCampaign.update).toHaveBeenCalledWith({
			where: { id: campaignId },
			data: { cancelledCount: { increment: 1 } }
		});
		expect(emailService.sendAdminBroadcast).not.toHaveBeenCalled();
	});

	it('does not leave a stale PROCESSING delivery behind after campaign cancellation', async () => {
		const { service, emailService, transaction, deliveryRecord } =
			createService(
				MailingDeliveryStatus.PROCESSING,
				MailingCampaignStatus.CANCELLED
			);
		deliveryRecord.updatedAt = new Date(Date.now() - 11 * 60 * 1000);

		await service.deliver('mailing-email', event, eventId);

		expect(transaction.mailingDelivery.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: deliveryId,
					campaignId,
					status: {
						in: [
							MailingDeliveryStatus.PENDING,
							MailingDeliveryStatus.PROCESSING
						]
					}
				},
				data: {
					status: MailingDeliveryStatus.CANCELLED,
					cancelledAt: expect.any(Date)
				}
			})
		);
		expect(transaction.mailingCampaign.update).toHaveBeenCalledWith({
			where: { id: campaignId },
			data: { cancelledCount: { increment: 1 } }
		});
		expect(emailService.sendAdminBroadcast).not.toHaveBeenCalled();
	});

	it('returns a failed send to PENDING for the scheduled retry', async () => {
		const { service, emailService, prisma } = createService();
		(emailService.sendAdminBroadcast as jest.Mock).mockRejectedValue(
			new Error('SMTP unavailable')
		);

		await expect(
			service.deliver('mailing-email', event, eventId)
		).rejects.toThrow('SMTP unavailable');
		expect(prisma.mailingDelivery.updateMany).toHaveBeenCalledWith({
			where: {
				id: deliveryId,
				campaignId,
				status: MailingDeliveryStatus.PROCESSING
			},
			data: {
				status: MailingDeliveryStatus.PENDING,
				lastError: 'SMTP unavailable'
			}
		});
	});
});
