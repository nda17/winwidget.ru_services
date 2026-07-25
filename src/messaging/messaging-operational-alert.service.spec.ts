import { MessagingOperationalAlertService } from '@/messaging/messaging-operational-alert.service';
import type { RabbitMqManagementService } from '@/messaging/rabbitmq-management.service';
import type { PrismaService } from '@/prisma.service';
import type { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import type { ConfigService } from '@nestjs/config';

describe('MessagingOperationalAlertService', () => {
	const createService = (acquired = true) => {
		const state = {
			id: '11111111-1111-4111-8111-111111111111',
			status: 'SUCCEEDED',
			availableAt: new Date(0),
			checkpoint: {},
			result: { signature: 'healthy' }
		};
		const transaction = {
			$queryRaw: jest.fn().mockResolvedValue([{ acquired }]),
			scheduledJobRun: {
				findUnique: jest.fn().mockResolvedValue(null),
				create: jest.fn().mockResolvedValue(state),
				update: jest.fn().mockResolvedValue(state)
			}
		};
		const prisma = {
			$transaction: jest.fn(callback => callback(transaction)),
			$executeRaw: jest.fn().mockResolvedValue(1)
		} as unknown as PrismaService;
		const telegramBot = {
			sendMessagingOperationalAlert: jest.fn().mockResolvedValue(undefined)
		} as unknown as TelegramBotService;
		const service = new MessagingOperationalAlertService(
			prisma,
			telegramBot,
			{ get: jest.fn() } as unknown as ConfigService,
			{} as RabbitMqManagementService
		);
		return { service, prisma, telegramBot, transaction };
	};

	it('claims durable alert state before sending a changed alert', async () => {
		const { service, prisma, telegramBot, transaction } = createService();

		await (service as any).sendAlertIfChanged(
			'outbox-failed=1',
			'problem'
		);

		expect(transaction.scheduledJobRun.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: 'SUCCEEDED',
					checkpoint: expect.objectContaining({
						pendingSignature: expect.stringMatching(/^[a-f0-9]{64}$/),
						claimToken: expect.any(String),
						claimExpiresAt: expect.any(String)
					})
				})
			})
		);
		expect(telegramBot.sendMessagingOperationalAlert).toHaveBeenCalledWith(
			'problem'
		);
		expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
	});

	it('does not send when another replica owns the advisory lock', async () => {
		const { service, telegramBot, transaction } = createService(false);

		await (service as any).sendAlertIfChanged(
			'outbox-failed=1',
			'problem'
		);

		expect(transaction.scheduledJobRun.create).not.toHaveBeenCalled();
		expect(
			telegramBot.sendMessagingOperationalAlert
		).not.toHaveBeenCalled();
	});

	it('initializes healthy state without a recovery notification', async () => {
		const { service, telegramBot } = createService();

		await (service as any).sendAlertIfChanged('', 'recovered');

		expect(
			telegramBot.sendMessagingOperationalAlert
		).not.toHaveBeenCalled();
	});
});
