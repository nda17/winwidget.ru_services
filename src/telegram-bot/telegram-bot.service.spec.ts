import type { PrismaService } from '@/prisma.service';
import { TelegramBotService } from '@/telegram-bot/telegram-bot.service';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const createTelegramBotService = (prisma: PrismaService) =>
	new TelegramBotService(prisma, new ConfigService({ MODE: 'test' }));
const createAuditWriter = () => jest.fn().mockResolvedValue(undefined);

const telegramSettings = {
	id: 'singleton',
	dailySummaryChatId: '-100123',
	databaseBackupThreadId: 2,
	paymentsThreadId: 3,
	operationalAlertsThreadId: 5,
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
		: '04:15',
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

describe('TelegramBotService backup settings', () => {
	it('derives the Notification Delivery backup time across midnight', () => {
		const service = createTelegramBotService({} as PrismaService);

		expect((service as any).addMinutesToTime('23:55', 15)).toBe('00:10');
		expect((service as any).addMinutesToTime('23:55', 45)).toBe('00:40');
		expect((service as any).addMinutesToTime('23:55', 60)).toBe('00:55');
		expect((service as any).addMinutesToTime('23:55', 75)).toBe('01:10');
		expect((service as any).addMinutesToTime('23:55', 90)).toBe('01:25');
		expect((service as any).addMinutesToTime('23:55', 105)).toBe('01:40');
		expect((service as any).addMinutesToTime('23:55', 120)).toBe('01:55');
	});

	it('exposes all delayed service backup schedules in settings', () => {
		const service = createTelegramBotService({} as PrismaService);

		expect(
			(service as any).serializeSettings(telegramSettings)
		).toMatchObject({
			widgetsDatabaseBackupDelayMinutes: 60,
			widgetsDatabaseBackupTime: '02:45',
			widgetsDatabaseBackupTimeLabel: '02:45 МСК',
			billingDatabaseBackupDelayMinutes: 75,
			billingDatabaseBackupTime: '03:00',
			billingDatabaseBackupTimeLabel: '03:00 МСК',
			identityDatabaseBackupDelayMinutes: 90,
			identityDatabaseBackupTime: '03:15',
			identityDatabaseBackupTimeLabel: '03:15 МСК',
			platformDatabaseBackupDelayMinutes: 105,
			platformDatabaseBackupTime: '03:30',
			platformDatabaseBackupTimeLabel: '03:30 МСК',
			operationsDatabaseBackupDelayMinutes: 135,
			operationsDatabaseBackupTime: '04:00',
			operationsDatabaseBackupTimeLabel: '04:00 МСК'
		});
	});

	it('keeps the summary away from every backup time across midnight', () => {
		const service = createTelegramBotService({} as PrismaService);

		expect(() =>
			(service as any).ensureScheduleTimesSeparated('00:08', '23:55')
		).toThrow(BadRequestException);
		expect(() =>
			(service as any).ensureScheduleTimesSeparated('00:20', '23:55')
		).not.toThrow();
		expect(() =>
			(service as any).ensureScheduleTimesSeparated('00:38', '23:55')
		).toThrow(BadRequestException);
		expect(() =>
			(service as any).ensureScheduleTimesSeparated('00:53', '23:55')
		).toThrow(BadRequestException);
		expect(() =>
			(service as any).ensureScheduleTimesSeparated('01:38', '23:55')
		).toThrow(BadRequestException);
	});

	it('lets Core-owned backup time change use the Reporting schedule reservation', async () => {
		const { prisma, upsert } = createSettingsPrisma('REPORTING');
		const service = createTelegramBotService(prisma);

		const result = await service.updateSettings(
			{ databaseBackupTime: '01:48' },
			createAuditWriter()
		);

		expect(result.databaseBackupTime).toBe('01:48');
		expect(upsert).toHaveBeenLastCalledWith(
			expect.objectContaining({ update: { databaseBackupTime: '01:48' } })
		);
	});

	it('validates a Core backup change against the committed Reporting policy fence', async () => {
		const { prisma, upsert } = createSettingsPrisma('REPORTING', '02:32');
		const service = createTelegramBotService(prisma);

		await expect(
			service.updateSettings(
				{ databaseBackupTime: '01:48' },
				createAuditWriter()
			)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(upsert).toHaveBeenCalledTimes(1);
	});

	it('also blocks a backup change against an unconfirmed durable reservation', async () => {
		const { prisma, upsert } = createSettingsPrisma(
			'REPORTING',
			'03:00',
			'02:32'
		);
		const service = createTelegramBotService(prisma);

		await expect(
			service.updateSettings(
				{ databaseBackupTime: '01:48' },
				createAuditWriter()
			)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(upsert).toHaveBeenCalledTimes(1);
	});

	it('still enforces the schedule gap while the authority row is transitional', async () => {
		const { prisma, upsert } = createSettingsPrisma('CORE');
		const service = createTelegramBotService(prisma);

		await expect(
			service.updateSettings(
				{ databaseBackupTime: '01:48' },
				createAuditWriter()
			)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(upsert).toHaveBeenCalledTimes(1);
	});

	it('lets Core edit its own chat and operational topic after the split', async () => {
		const { prisma, upsert } = createSettingsPrisma('REPORTING');
		const service = createTelegramBotService(prisma);

		await expect(
			service.updateSettings(
				{ operationalAlertsThreadId: 6 },
				createAuditWriter()
			)
		).resolves.toEqual(
			expect.objectContaining({ operationalAlertsThreadId: 6 })
		);
		await expect(
			service.updateSettings(
				{ dailySummaryChatId: '-100999' },
				createAuditWriter()
			)
		).resolves.toEqual(
			expect.objectContaining({ dailySummaryChatId: '-100999' })
		);
		expect(upsert).toHaveBeenCalledTimes(4);
	});

	it('fails the settings transaction when its audit Outbox write fails', async () => {
		const { prisma, transaction } = createSettingsPrisma('REPORTING');
		const service = createTelegramBotService(prisma);
		const writeAudit = jest
			.fn()
			.mockRejectedValue(new Error('audit outbox unavailable'));

		await expect(
			service.updateSettings({ operationalAlertsThreadId: 6 }, writeAudit)
		).rejects.toThrow('audit outbox unavailable');
		expect(writeAudit).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({ operationalAlertsThreadId: 6 })
		);
	});
});

describe('TelegramBotService operational alert routing', () => {
	it('uses the dedicated Core topic instead of the Daily Summary topic', async () => {
		const prisma = {
			telegramBotSettings: {
				upsert: jest.fn().mockResolvedValue(telegramSettings)
			}
		} as unknown as PrismaService;
		const service = createTelegramBotService(prisma);
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
