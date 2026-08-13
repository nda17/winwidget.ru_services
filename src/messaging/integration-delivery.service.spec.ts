import type { PrismaService } from '@/prisma.service';
import { IntegrationDeliveryService } from './integration-delivery.service';

describe('IntegrationDeliveryService', () => {
	it('applies a destination-unavailable outcome with a stale-safe CAS', async () => {
		const prisma = {
			telegramNotificationChannel: {
				updateMany: jest.fn().mockResolvedValue({ count: 1 })
			}
		} as unknown as PrismaService;
		const service = new IntegrationDeliveryService(prisma);
		const occurredAt = '2026-07-23T12:00:00.000Z';

		await service.deliver('telegram-destination-unavailable', {
			schemaVersion: 1,
			eventType: 'notification.telegram.destination-unavailable.v1',
			sourceEventId: '33333333-3333-4333-8333-333333333333',
			sourceKind: 'campaign-telegram',
			destination: { telegramChatId: '123456789' },
			normalizedCode: 'TELEGRAM_CHAT_NOT_FOUND',
			occurredAt
		});

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
});
