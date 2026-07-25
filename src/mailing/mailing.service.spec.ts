import type { AdminEventLogService } from '@/admin-event-log/admin-event-log.service';
import { MailingService } from '@/mailing/mailing.service';
import type { PrismaService } from '@/prisma.service';
import {
	MailingCampaignStatus,
	MailingDeliveryChannel,
	MailingDeliveryStatus
} from '@prisma/client';

describe('MailingService', () => {
	it('atomically creates campaign recipients and outbox messages', async () => {
		const idempotencyKey = '44444444-4444-4444-8444-444444444444';
		const campaign = {
			id: expect.any(String),
			subject: 'Важное обновление',
			message: 'Подробный текст обновления',
			audience: 'ALL',
			requestedChannel: 'BOTH',
			status: MailingCampaignStatus.QUEUED,
			recipientCount: 2,
			sentCount: 0,
			failedCount: 0,
			cancelledCount: 0,
			emailRecipientCount: 1,
			telegramRecipientCount: 1,
			startedAt: null,
			completedAt: null,
			cancelRequestedAt: null,
			createdAt: new Date('2026-07-24T00:00:00.000Z'),
			updatedAt: new Date('2026-07-24T00:00:00.000Z')
		};
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(0),
			mailingCampaign: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockImplementation(({ data }) => {
					campaign.id = data.id;
					return Promise.resolve(data);
				})
			},
			mailingDelivery: {
				createMany: jest.fn().mockResolvedValue({ count: 2 })
			},
			outboxEvent: {
				createMany: jest.fn().mockResolvedValue({ count: 2 })
			}
		};
		const prisma = {
			authIdentity: {
				findMany: jest
					.fn()
					.mockResolvedValue([{ value: 'USER@example.com' }])
			},
			telegramNotificationChannel: {
				findMany: jest.fn().mockResolvedValue([{ chatId: '123' }])
			},
			mailingCampaign: {
				findUnique: jest.fn().mockImplementation(() =>
					Promise.resolve({
						...campaign,
						id:
							typeof campaign.id === 'string'
								? campaign.id
								: '00000000-0000-4000-8000-000000000001'
					})
				)
			},
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const adminEventLog = {
			recordInTransaction: jest.fn().mockResolvedValue({})
		} as unknown as AdminEventLogService;
		const service = new MailingService(prisma, adminEventLog);

		const result = await service.createAdminBroadcast(
			'admin-1',
			{
				subject: ' Важное обновление ',
				message: ' Подробный текст обновления ',
				audience: 'ALL',
				channel: 'BOTH'
			},
			idempotencyKey
		);

		expect(result.recipientCount).toBe(2);
		expect(transaction.mailingCampaign.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				adminId: 'admin-1',
				idempotencyKey
			})
		});
		expect(transaction.mailingDelivery.createMany).toHaveBeenCalledWith({
			data: expect.arrayContaining([
				expect.objectContaining({
					channel: MailingDeliveryChannel.EMAIL,
					recipient: 'user@example.com'
				}),
				expect.objectContaining({
					channel: MailingDeliveryChannel.TELEGRAM,
					recipient: '123'
				})
			])
		});
		const outboxData =
			transaction.outboxEvent.createMany.mock.calls[0][0].data;
		expect(outboxData.map(item => item.routingKey).sort()).toEqual([
			'mailing.delivery.email.v1',
			'mailing.delivery.telegram.v1'
		]);
		expect(outboxData).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: expect.any(String),
					messageId: expect.any(String),
					headers: expect.objectContaining({
						'x-correlation-id': expect.any(String),
						'x-request-id': expect.any(String)
					})
				})
			])
		);
		for (const event of outboxData) {
			expect(event.messageId).toBe(event.id);
		}
		expect(adminEventLog.recordInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				action: 'MAILING_BROADCAST_SEND',
				entityId: expect.any(String),
				adminId: 'admin-1'
			})
		);
	});

	it('returns the existing campaign without duplicating outbox or audit', async () => {
		const idempotencyKey = '44444444-4444-4444-8444-444444444444';
		const campaign = {
			id: '11111111-1111-4111-8111-111111111111',
			adminId: 'admin-1',
			idempotencyKey,
			subject: 'Новости',
			message: 'Подробный текст',
			audience: 'ALL',
			requestedChannel: 'EMAIL',
			status: MailingCampaignStatus.QUEUED,
			recipientCount: 1,
			sentCount: 0,
			failedCount: 0,
			cancelledCount: 0,
			emailRecipientCount: 1,
			telegramRecipientCount: 0,
			startedAt: null,
			completedAt: null,
			cancelRequestedAt: null,
			createdAt: new Date('2026-07-25T00:00:00.000Z'),
			updatedAt: new Date('2026-07-25T00:00:00.000Z')
		};
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(0),
			mailingCampaign: {
				findUnique: jest.fn().mockResolvedValue(campaign),
				create: jest.fn()
			},
			mailingDelivery: { createMany: jest.fn() },
			outboxEvent: { createMany: jest.fn() }
		};
		const prisma = {
			authIdentity: {
				findMany: jest
					.fn()
					.mockResolvedValue([{ value: 'user@example.com' }])
			},
			telegramNotificationChannel: { findMany: jest.fn() },
			mailingCampaign: {
				findUnique: jest.fn().mockResolvedValue(campaign)
			},
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const adminEventLog = {
			recordInTransaction: jest.fn()
		} as unknown as AdminEventLogService;
		const service = new MailingService(prisma, adminEventLog);

		const result = await service.createAdminBroadcast(
			'admin-1',
			{
				subject: 'Новости',
				message: 'Подробный текст',
				audience: 'ALL',
				channel: 'EMAIL'
			},
			idempotencyKey
		);

		expect(result.id).toBe(campaign.id);
		expect(transaction.mailingCampaign.create).not.toHaveBeenCalled();
		expect(transaction.mailingDelivery.createMany).not.toHaveBeenCalled();
		expect(transaction.outboxEvent.createMany).not.toHaveBeenCalled();
		expect(adminEventLog.recordInTransaction).not.toHaveBeenCalled();
	});

	it('cancels a campaign and records audit in the same transaction', async () => {
		const campaign = {
			id: '11111111-1111-4111-8111-111111111111',
			subject: 'Новости',
			message: 'Подробный текст',
			audience: 'ALL',
			requestedChannel: 'EMAIL',
			status: MailingCampaignStatus.RUNNING,
			recipientCount: 2,
			sentCount: 0,
			failedCount: 0,
			cancelledCount: 0,
			emailRecipientCount: 2,
			telegramRecipientCount: 0,
			startedAt: new Date('2026-07-25T00:00:00.000Z'),
			completedAt: null,
			cancelRequestedAt: null,
			createdAt: new Date('2026-07-25T00:00:00.000Z'),
			updatedAt: new Date('2026-07-25T00:00:00.000Z')
		};
		const updatedCampaign = {
			...campaign,
			status: MailingCampaignStatus.CANCELLED,
			cancelledCount: 2,
			cancelRequestedAt: new Date('2026-07-25T00:05:00.000Z'),
			completedAt: new Date('2026-07-25T00:05:00.000Z')
		};
		const transaction = {
			$executeRaw: jest.fn().mockResolvedValue(0),
			mailingCampaign: {
				findUnique: jest.fn().mockResolvedValue(campaign),
				update: jest.fn().mockResolvedValue(updatedCampaign)
			},
			mailingDelivery: {
				updateMany: jest.fn().mockResolvedValue({ count: 2 })
			}
		};
		const prisma = {
			$transaction: jest.fn(async callback => callback(transaction))
		} as unknown as PrismaService;
		const adminEventLog = {
			recordInTransaction: jest.fn().mockResolvedValue({})
		} as unknown as AdminEventLogService;
		const service = new MailingService(prisma, adminEventLog);

		const result = await service.cancelCampaign(campaign.id, 'admin-1');

		expect(transaction.mailingDelivery.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					campaignId: campaign.id,
					status: MailingDeliveryStatus.PENDING
				}
			})
		);
		expect(adminEventLog.recordInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				action: 'MAILING_BROADCAST_CANCEL',
				entityId: campaign.id,
				adminId: 'admin-1'
			})
		);
		expect(result.status).toBe(MailingCampaignStatus.CANCELLED);
	});
});
