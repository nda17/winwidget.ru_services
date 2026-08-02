import type { PrismaService } from '@/prisma.service';
import { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import { BadRequestException, ConflictException } from '@nestjs/common';

const telegramSettings = {
	id: 'singleton',
	dailySummaryEnabled: true,
	dailySummaryChatId: '-100123',
	supportThreadId: 1,
	databaseBackupThreadId: 2,
	paymentsThreadId: 3,
	operationalAlertsThreadId: 5,
	reportsThreadId: 4,
	dailySummaryTime: '01:50',
	dailySummaryLastSentPeriodStart: null,
	dailySummaryLastSentAt: null,
	databaseBackupEnabled: true,
	databaseBackupTime: '01:45',
	databaseBackupLastSentPeriodStart: null,
	databaseBackupLastSentAt: null,
	updatedAt: new Date('2026-07-31T00:00:00.000Z')
};

const createSettingsPrisma = (
	dailySummaryOwner: 'CORE' | 'REPORTING',
	dailySummaryPolicyReservationTime = dailySummaryOwner === 'CORE'
		? '01:50'
		: '03:00',
	dailySummaryPolicyPendingTime: string | null = null
) => {
	const upsert = jest
		.fn()
		.mockResolvedValueOnce(telegramSettings)
		.mockImplementation(({ update }) =>
			Promise.resolve({ ...telegramSettings, ...update })
		);
	const queryRaw = jest.fn().mockImplementation(() =>
		Promise.resolve(
			queryRaw.mock.calls.length % 2 === 1
				? [{ id: 'singleton' }]
				: [
						{
							dailySummaryOwner,
							dailySummaryPolicyReservationTime,
							dailySummaryPolicyReservationGeneration: 1n,
							dailySummaryPolicyPendingTime,
							dailySummaryPolicyPendingGeneration:
								dailySummaryPolicyPendingTime === null ? null : 2n
						}
					]
		)
	);
	const transaction = {
		$queryRaw: queryRaw,
		telegramBotSettings: {
			upsert,
			findUniqueOrThrow: jest.fn().mockResolvedValue(telegramSettings)
		},
		reportingProducerState: { update: jest.fn() }
	};
	const prisma = {
		$transaction: jest.fn(
			(callback: (value: typeof transaction) => unknown) =>
				callback(transaction)
		)
	} as unknown as PrismaService;
	return { prisma, transaction, upsert };
};

describe('TelegramBotService webhook URLs', () => {
	const originalMode = process.env.MODE;
	const originalWebhookHost = process.env.TELEGRAM_WEBHOOK_HOST;

	afterEach(() => {
		if (originalMode === undefined) delete process.env.MODE;
		else process.env.MODE = originalMode;

		if (originalWebhookHost === undefined)
			delete process.env.TELEGRAM_WEBHOOK_HOST;
		else process.env.TELEGRAM_WEBHOOK_HOST = originalWebhookHost;
	});

	it('uses the v1 API prefix for every generated webhook URL', () => {
		process.env.MODE = 'production';
		process.env.TELEGRAM_WEBHOOK_HOST = 'https://hooks.example.test/';
		const service = new TelegramBotService({} as PrismaService);

		expect(service.getWebhookHealth().expectedWebhooks).toEqual({
			info: 'https://hooks.example.test/api/v1/telegram-bot/webhook',
			auth: 'https://hooks.example.test/api/v1/telegram-auth/webhook',
			support:
				'https://hooks.example.test/api/v1/telegram-bot/support-webhook'
		});
	});

	it('derives the Notification Delivery backup time across midnight', () => {
		const service = new TelegramBotService({} as PrismaService);

		expect((service as any).addMinutesToTime('23:55', 15)).toBe('00:10');
		expect((service as any).addMinutesToTime('23:55', 45)).toBe('00:40');
	});

	it('keeps the summary away from both backup times across midnight', () => {
		const service = new TelegramBotService({} as PrismaService);

		expect(() =>
			(service as any).ensureScheduleTimesSeparated('00:08', '23:55')
		).toThrow(BadRequestException);
		expect(() =>
			(service as any).ensureScheduleTimesSeparated('00:20', '23:55')
		).not.toThrow();
		expect(() =>
			(service as any).ensureScheduleTimesSeparated('00:38', '23:55')
		).toThrow(BadRequestException);
	});

	it('fences legacy Daily Summary writes after Reporting claims ownership', async () => {
		const { prisma, transaction, upsert } =
			createSettingsPrisma('REPORTING');
		const service = new TelegramBotService(prisma);

		await expect(
			service.updateSettings({ dailySummaryTime: '02:00' })
		).rejects.toBeInstanceOf(ConflictException);
		expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
		expect(upsert).toHaveBeenCalledTimes(1);
	});

	it('lets Core-owned backup time change ignore the stale legacy summary after cutover', async () => {
		const { prisma, upsert } = createSettingsPrisma('REPORTING');
		const service = new TelegramBotService(prisma);

		const result = await service.updateSettings({
			databaseBackupTime: '01:48'
		});

		expect(result.databaseBackupTime).toBe('01:48');
		expect(upsert).toHaveBeenLastCalledWith(
			expect.objectContaining({ update: { databaseBackupTime: '01:48' } })
		);
	});

	it('validates a Core backup change against the committed Reporting policy fence', async () => {
		const { prisma, upsert } = createSettingsPrisma('REPORTING', '02:32');
		const service = new TelegramBotService(prisma);

		await expect(
			service.updateSettings({ databaseBackupTime: '01:48' })
		).rejects.toBeInstanceOf(BadRequestException);
		expect(upsert).toHaveBeenCalledTimes(1);
	});

	it('also blocks a backup change against an unconfirmed durable reservation', async () => {
		const { prisma, upsert } = createSettingsPrisma(
			'REPORTING',
			'03:00',
			'02:32'
		);
		const service = new TelegramBotService(prisma);

		await expect(
			service.updateSettings({ databaseBackupTime: '01:48' })
		).rejects.toBeInstanceOf(BadRequestException);
		expect(upsert).toHaveBeenCalledTimes(1);
	});

	it('still enforces the schedule gap while Core owns Daily Summary', async () => {
		const { prisma, upsert } = createSettingsPrisma('CORE');
		const service = new TelegramBotService(prisma);

		await expect(
			service.updateSettings({ databaseBackupTime: '01:48' })
		).rejects.toBeInstanceOf(BadRequestException);
		expect(upsert).toHaveBeenCalledTimes(1);
	});

	it('updates the pre-cutover policy baseline in the same Core transaction', async () => {
		const { prisma, transaction } = createSettingsPrisma('CORE');
		const service = new TelegramBotService(prisma);

		await service.updateSettings({ dailySummaryTime: '02:20' });

		expect(transaction.reportingProducerState.update).toHaveBeenCalledWith(
			{
				where: { id: 'singleton' },
				data: {
					dailySummaryPolicyReservationTime: '02:20',
					dailySummaryPolicyReservationGeneration: { increment: 1 }
				}
			}
		);
		expect(
			transaction.telegramBotSettings.upsert.mock.invocationCallOrder[0]
		).toBeLessThan(transaction.$queryRaw.mock.invocationCallOrder[0]);
	});

	it('rejects one shared topic while Core owns both routes', async () => {
		const { prisma, upsert } = createSettingsPrisma('CORE');
		const service = new TelegramBotService(prisma);

		await expect(
			service.updateSettings({ operationalAlertsThreadId: 4 })
		).rejects.toThrow('должны использовать разные топики');
		expect(upsert).toHaveBeenCalledTimes(1);
	});

	it('lets Core edit its own chat and operational topic after the split', async () => {
		const { prisma, upsert } = createSettingsPrisma('REPORTING');
		const service = new TelegramBotService(prisma);

		await expect(
			service.updateSettings({ operationalAlertsThreadId: 6 })
		).resolves.toEqual(
			expect.objectContaining({ operationalAlertsThreadId: 6 })
		);
		await expect(
			service.updateSettings({ dailySummaryChatId: '-100999' })
		).resolves.toEqual(
			expect.objectContaining({ dailySummaryChatId: '-100999' })
		);
		expect(upsert).toHaveBeenCalledTimes(4);
	});
});

describe('TelegramBotService operational alert routing', () => {
	it('uses the dedicated Core topic instead of the Daily Summary topic', async () => {
		const prisma = {
			telegramBotSettings: {
				upsert: jest.fn().mockResolvedValue(telegramSettings)
			}
		} as unknown as PrismaService;
		const service = new TelegramBotService(prisma);
		const send = jest
			.spyOn(service, 'sendInfoBotMessage')
			.mockResolvedValue(undefined);

		await expect(
			service.sendMessagingOperationalAlert('alert')
		).resolves.toBe(true);
		expect(send).toHaveBeenCalledWith('-100123', 'alert', {
			parseMode: 'HTML',
			messageThreadId: 5
		});
	});
});
