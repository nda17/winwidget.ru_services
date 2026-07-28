import { IntegrationDeliveryService } from '@/messaging/integration-delivery.service';
import type { LeadIntegrationDestinationService } from '@/messaging/lead-integration-destination.service';
import type { LeadIntegrationEventPayloadV2 } from '@/messaging/lead-integration-event';
import type { PrismaService } from '@/prisma.service';
import type { DailySummaryDeliveryService } from '@/reports/daily-summary-delivery.service';
import type { SafeOutboundHttpService } from '@/safe-outbound-http/safe-outbound-http.service';
import type { ScheduledJobsService } from '@/scheduled-jobs/scheduled-jobs.service';
import {
	MailingCampaignStatus,
	MailingDeliveryChannel,
	MailingDeliveryStatus,
	ScheduledJobRunStatus,
	SubscriptionExpiryReminderStatus
} from '@prisma/client';

const createLeadEvent = (): LeadIntegrationEventPayloadV2 => ({
	schemaVersion: 2,
	eventType: 'lead.integration.requested.v2',
	integration: 'webhook',
	source: 'widget',
	entity: { id: 'widget-1', name: 'Колесо' },
	lead: {
		id: 'lead-1',
		contact: '+79990000000',
		createdAt: '2026-07-23T12:00:00.000Z'
	},
	destination: {
		credentialRef: '11111111-1111-4111-8111-111111111111'
	}
});

describe('IntegrationDeliveryService', () => {
	const campaignId = '11111111-1111-4111-8111-111111111111';
	const deliveryId = '22222222-2222-4222-8222-222222222222';
	const eventId = '33333333-3333-4333-8333-333333333333';

	const createService = (
		options: {
			deliveryStatus?: MailingDeliveryStatus;
			campaignStatus?: MailingCampaignStatus;
			channel?: MailingDeliveryChannel;
			failedCount?: number;
		} = {}
	) => {
		const channel = options.channel ?? MailingDeliveryChannel.EMAIL;
		const deliveryRecord = {
			id: deliveryId,
			campaignId,
			channel,
			recipient:
				channel === MailingDeliveryChannel.EMAIL
					? 'owner@example.com'
					: '123456789',
			status: options.deliveryStatus ?? MailingDeliveryStatus.PENDING,
			campaign: {
				id: campaignId,
				status: options.campaignStatus ?? MailingCampaignStatus.QUEUED,
				cancelRequestedAt:
					options.campaignStatus === MailingCampaignStatus.CANCELLED
						? new Date()
						: null,
				subject: 'Новости',
				message: 'Текст рассылки'
			}
		};
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([
				{
					id: deliveryId,
					campaignId,
					status:
						options.deliveryStatus ?? MailingDeliveryStatus.PROCESSING
				}
			]),
			mailingDelivery: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
				update: jest.fn().mockResolvedValue({}),
				count: jest.fn().mockResolvedValue(0)
			},
			mailingCampaign: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 }),
				update: jest.fn().mockResolvedValue({
					failedCount: options.failedCount ?? 0
				})
			},
			outboxEvent: {
				createMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			telegramBotSettings: {
				update: jest.fn().mockResolvedValue({})
			}
		};
		const prisma = {
			mailingDelivery: {
				findUnique: jest.fn().mockResolvedValue(deliveryRecord)
			},
			telegramNotificationChannel: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			subscriptionExpiryReminder: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			},
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const safeOutboundHttpService = {
			postJson: jest.fn().mockResolvedValue(undefined),
			getAmoCrmApiUrl: jest.fn()
		} as unknown as SafeOutboundHttpService;
		const dailySummary = {
			deliver: jest.fn().mockResolvedValue(undefined)
		} as unknown as DailySummaryDeliveryService;
		const leadDestination = {
			resolve: jest.fn(async (_sourceEventId, event) => ({
				...event,
				destination: {
					webhookUrl: 'https://example.com/webhook'
				}
			}))
		} as unknown as LeadIntegrationDestinationService;
		const scheduledJobs = {
			completeExternalDeliveryInTransaction: jest.fn().mockResolvedValue({
				id: eventId,
				jobType: 'DAILY_TELEGRAM_SUMMARY',
				status: ScheduledJobRunStatus.SUCCEEDED,
				periodStart: '2026-07-22T21:00:00.000Z'
			}),
			failExternalDeliveryInTransaction: jest.fn().mockResolvedValue({})
		} as unknown as ScheduledJobsService;
		const service = new IntegrationDeliveryService(
			safeOutboundHttpService,
			prisma,
			dailySummary,
			leadDestination,
			scheduledJobs
		);

		return {
			service,
			prisma,
			transaction,
			safeOutboundHttpService,
			scheduledJobs
		};
	};

	it('sends a versioned webhook with a stable event id', async () => {
		const { service, safeOutboundHttpService } = createService();

		await service.deliver('webhook', createLeadEvent(), eventId);

		expect(safeOutboundHttpService.postJson).toHaveBeenCalledWith(
			'https://example.com/webhook',
			expect.objectContaining({
				eventId,
				eventType: 'lead.created.v1',
				lead: expect.objectContaining({ id: 'lead-1' })
			}),
			{
				policy: 'webhook',
				headers: { 'X-WinWidget-Event-Id': eventId }
			}
		);
	});

	it('applies a destination-unavailable outcome with a stale-safe CAS', async () => {
		const { service, prisma } = createService();
		const occurredAt = '2026-07-23T12:00:00.000Z';

		await service.deliver(
			'telegram-destination-unavailable',
			{
				schemaVersion: 1,
				eventType: 'notification.telegram.destination-unavailable.v1',
				sourceEventId: eventId,
				sourceKind: 'campaign-telegram',
				destination: { telegramChatId: '123456789' },
				normalizedCode: 'TELEGRAM_CHAT_NOT_FOUND',
				occurredAt
			},
			'outcome-1'
		);

		expect(
			prisma.telegramNotificationChannel.updateMany
		).toHaveBeenCalledWith({
			where: {
				chatId: '123456789',
				isActive: true,
				updatedAt: { lte: new Date(occurredAt) }
			},
			data: {
				isActive: false,
				disabledAt: new Date(occurredAt)
			}
		});
	});

	it.each([
		[
			MailingDeliveryChannel.EMAIL,
			'mailing-email' as const,
			'notification.campaign.email.requested.v1'
		],
		[
			MailingDeliveryChannel.TELEGRAM,
			'mailing-telegram' as const,
			'notification.campaign.telegram.requested.v1'
		]
	])(
		'atomically dispatches %s mailing delivery through Notification Delivery',
		async (channel, monolithKind, eventType) => {
			const { service, transaction } = createService({ channel });
			const event = {
				schemaVersion: 1 as const,
				eventType: 'mailing.delivery.requested.v1' as const,
				campaignId,
				deliveryId,
				channel
			};

			await service.deliver(monolithKind, event, eventId);

			expect(transaction.mailingDelivery.updateMany).toHaveBeenCalledWith({
				where: {
					id: deliveryId,
					campaignId,
					status: MailingDeliveryStatus.PENDING
				},
				data: {
					status: MailingDeliveryStatus.PROCESSING,
					attempts: { increment: 1 },
					lastError: null
				}
			});
			const outbox =
				transaction.outboxEvent.createMany.mock.calls[0][0].data[0];
			expect(outbox).toEqual(
				expect.objectContaining({
					messageId: eventId,
					eventType,
					routingKey: eventType
				})
			);
			expect(outbox.payload).toEqual(
				expect.objectContaining({
					schemaVersion: 1,
					eventType,
					reference: {
						type: 'mailing-delivery',
						id: deliveryId,
						aggregateId: campaignId
					}
				})
			);
		}
	);

	it('cancels a pending mailing delivery before dispatch', async () => {
		const { service, transaction } = createService({
			campaignStatus: MailingCampaignStatus.CANCELLED
		});

		await service.deliver(
			'mailing-email',
			{
				schemaVersion: 1,
				eventType: 'mailing.delivery.requested.v1',
				campaignId,
				deliveryId,
				channel: MailingDeliveryChannel.EMAIL
			},
			eventId
		);

		expect(transaction.outboxEvent.createMany).not.toHaveBeenCalled();
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
	});

	it('applies a successful mailing outcome exactly once', async () => {
		const { service, transaction } = createService({
			deliveryStatus: MailingDeliveryStatus.PROCESSING
		});
		const occurredAt = '2026-07-28T08:00:00.000Z';

		await service.deliver(
			'notification-delivery-outcome',
			{
				schemaVersion: 1,
				eventType: 'notification.delivery.outcome.v1',
				sourceEventId: eventId,
				sourceKind: 'campaign-email',
				reference: {
					type: 'mailing-delivery',
					id: deliveryId,
					aggregateId: campaignId
				},
				status: 'DELIVERED',
				failure: null,
				occurredAt
			},
			'outcome-1'
		);

		expect(transaction.mailingDelivery.update).toHaveBeenCalledWith({
			where: { id: deliveryId },
			data: {
				status: MailingDeliveryStatus.SENT,
				sentAt: new Date(occurredAt),
				lastError: null
			}
		});
		expect(transaction.mailingCampaign.update).toHaveBeenCalledWith({
			where: { id: campaignId },
			data: { sentCount: { increment: 1 } }
		});
		expect(transaction.mailingCampaign.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: MailingCampaignStatus.COMPLETED
				})
			})
		);
	});

	it('applies a terminal mailing failure and completes the campaign as partial', async () => {
		const { service, transaction } = createService({
			deliveryStatus: MailingDeliveryStatus.PROCESSING,
			failedCount: 1
		});

		await service.deliver(
			'notification-delivery-outcome',
			{
				schemaVersion: 1,
				eventType: 'notification.delivery.outcome.v1',
				sourceEventId: eventId,
				sourceKind: 'campaign-telegram',
				reference: {
					type: 'mailing-delivery',
					id: deliveryId,
					aggregateId: campaignId
				},
				status: 'FAILED',
				failure: {
					normalizedCode: 'TELEGRAM_CHAT_NOT_FOUND',
					safeReason: 'Telegram destination is unavailable'
				},
				occurredAt: '2026-07-28T08:00:00.000Z'
			},
			'outcome-2'
		);

		expect(transaction.mailingDelivery.update).toHaveBeenCalledWith({
			where: { id: deliveryId },
			data: {
				status: MailingDeliveryStatus.FAILED,
				lastError:
					'TELEGRAM_CHAT_NOT_FOUND: Telegram destination is unavailable',
				sentAt: null
			}
		});
		expect(transaction.mailingCampaign.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: MailingCampaignStatus.PARTIAL_FAILED
				})
			})
		);
	});

	it('completes the durable daily-summary job only after delivery outcome', async () => {
		const { service, scheduledJobs, transaction } = createService();
		const occurredAt = '2026-07-28T08:00:00.000Z';

		await service.deliver(
			'notification-delivery-outcome',
			{
				schemaVersion: 1,
				eventType: 'notification.delivery.outcome.v1',
				sourceEventId: eventId,
				sourceKind: 'daily-summary-delivery-telegram',
				reference: { type: 'daily-summary-job', id: eventId },
				status: 'DELIVERED',
				failure: null,
				occurredAt
			},
			'outcome-3'
		);

		expect(
			scheduledJobs.completeExternalDeliveryInTransaction
		).toHaveBeenCalledWith(
			transaction,
			eventId,
			eventId,
			expect.objectContaining({ telegramSent: true })
		);
		expect(transaction.telegramBotSettings.update).toHaveBeenCalledWith({
			where: { id: 'singleton' },
			data: {
				dailySummaryLastSentPeriodStart: new Date(
					'2026-07-22T21:00:00.000Z'
				),
				dailySummaryLastSentAt: new Date(occurredAt)
			}
		});
	});

	it('marks a subscription reminder from a terminal delivery outcome', async () => {
		const { service, prisma } = createService();

		await service.deliver(
			'notification-delivery-outcome',
			{
				schemaVersion: 1,
				eventType: 'notification.delivery.outcome.v1',
				sourceEventId: eventId,
				sourceKind: 'subscription-expiry-email',
				reference: {
					type: 'subscription-expiry-reminder',
					id: 'reminder-1'
				},
				status: 'FAILED',
				failure: {
					normalizedCode: 'SMTP_REJECTED',
					safeReason: 'Mailbox rejected the message'
				},
				occurredAt: '2026-07-28T08:00:00.000Z'
			},
			'outcome-4'
		);

		expect(
			prisma.subscriptionExpiryReminder.updateMany
		).toHaveBeenCalledWith({
			where: {
				id: 'reminder-1',
				status: SubscriptionExpiryReminderStatus.PROCESSING
			},
			data: {
				status: SubscriptionExpiryReminderStatus.FAILED,
				lockedAt: null,
				lockedBy: null,
				lastError: 'SMTP_REJECTED: Mailbox rejected the message'
			}
		});
	});
});
