import { MailingService } from '@/mailing/mailing.service';
import type { PrismaService } from '@/prisma.service';
import {
	MailingCampaignStatus,
	MailingDeliveryChannel
} from '@prisma/client';

describe('MailingService', () => {
	it('atomically creates campaign recipients and outbox messages', async () => {
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
			mailingCampaign: {
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
		const service = new MailingService(prisma);

		const result = await service.createAdminBroadcast('admin-1', {
			subject: ' Важное обновление ',
			message: ' Подробный текст обновления ',
			audience: 'ALL',
			channel: 'BOTH'
		});

		expect(result.recipientCount).toBe(2);
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
	});
});
