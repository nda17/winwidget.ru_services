import { ConfigService } from '@nestjs/config';
import { TelegramSettingsService } from './telegram-settings.service';

describe('TelegramSettingsService', () => {
	it('publishes the initial Operations routing event transactionally', async () => {
		const updatedAt = new Date('2026-08-26T08:00:00.000Z');
		const current = {
			id: 'singleton',
			dailySummaryChatId: '',
			databaseBackupThreadId: null,
			paymentsThreadId: null,
			operationalAlertsThreadId: null,
			databaseBackupEnabled: true,
			databaseBackupTime: '01:45',
			databaseBackupLastSentPeriodStart: null,
			databaseBackupLastSentAt: null,
			updatedAt
		};
		const transaction = {
			telegramBotSettings: {
				upsert: jest.fn(),
				findUniqueOrThrow: jest.fn().mockResolvedValue(current),
				update: jest.fn().mockResolvedValue({
					...current,
					dailySummaryChatId: '-100123',
					databaseBackupThreadId: 10,
					paymentsThreadId: 11,
					operationalAlertsThreadId: 99
				})
			},
			reportingSchedulePolicy: {
				upsert: jest.fn().mockResolvedValue({
					reservationTime: '05:00',
					pendingTime: null
				})
			},
			$queryRaw: jest.fn()
		};
		const prisma = {
			$transaction: jest.fn((callback: (value: unknown) => unknown) =>
				callback(transaction)
			)
		};
		const outbox = { enqueue: jest.fn().mockResolvedValue({}) };
		const service = new TelegramSettingsService(
			prisma as never,
			new ConfigService({ TELEGRAM_INFO_BOT_CONFIGURED: 'true' }),
			outbox as never
		);
		const audit = jest.fn().mockResolvedValue({});

		await service.updateSettings(
			{
				dailySummaryChatId: '-100123',
				databaseBackupThreadId: 10,
				paymentsThreadId: 11,
				operationalAlertsThreadId: 99
			},
			audit
		);

		expect(audit).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({ operationalAlertsThreadId: 99 })
		);
		expect(outbox.enqueue).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				eventType: 'operations.notification-routing.changed.v1',
				routingKey: 'operations.notification-routing.changed.v1',
				aggregateType: 'telegram-bot-settings',
				aggregateId: 'singleton',
				payload: expect.objectContaining({
					schemaVersion: 1,
					operationalAlertsThreadId: 99,
					changedAt: updatedAt.toISOString()
				})
			})
		);
		const payload = outbox.enqueue.mock.calls[0][1].payload;
		expect(payload.eventId).toEqual(expect.any(String));
	});

	it('rejects changing shared Telegram routing through the ordinary settings PATCH', async () => {
		const current = {
			id: 'singleton',
			dailySummaryChatId: '-100123',
			databaseBackupThreadId: 10,
			paymentsThreadId: 11,
			operationalAlertsThreadId: 12,
			databaseBackupEnabled: true,
			databaseBackupTime: '01:45',
			databaseBackupLastSentPeriodStart: null,
			databaseBackupLastSentAt: null,
			updatedAt: new Date('2026-08-26T08:00:00.000Z')
		};
		const transaction = {
			telegramBotSettings: {
				upsert: jest.fn(),
				findUniqueOrThrow: jest.fn().mockResolvedValue(current),
				update: jest.fn()
			},
			reportingSchedulePolicy: {
				upsert: jest.fn().mockResolvedValue({
					reservationTime: '05:00',
					pendingTime: null
				})
			},
			$queryRaw: jest.fn()
		};
		const prisma = {
			$transaction: jest.fn((callback: (value: unknown) => unknown) =>
				callback(transaction)
			)
		};
		const outbox = { enqueue: jest.fn() };
		const service = new TelegramSettingsService(
			prisma as never,
			new ConfigService(),
			outbox as never
		);
		const audit = jest.fn();

		await expect(
			service.updateSettings({ dailySummaryChatId: '-100999' }, audit)
		).rejects.toThrow('только через отдельную maintenance-процедуру');
		await expect(
			service.updateSettings({ operationalAlertsThreadId: 99 }, audit)
		).rejects.toThrow('только через отдельную maintenance-процедуру');

		expect(transaction.telegramBotSettings.update).not.toHaveBeenCalled();
		expect(outbox.enqueue).not.toHaveBeenCalled();
		expect(audit).not.toHaveBeenCalled();
	});

	it('keeps the frontend backup schedule fields while adding Operations', () => {
		const service = new TelegramSettingsService(
			{} as never,
			new ConfigService(),
			{} as never
		);
		const settings = service.serialize({
			id: 'singleton',
			dailySummaryChatId: '-100123',
			databaseBackupThreadId: 10,
			paymentsThreadId: 11,
			operationalAlertsThreadId: 12,
			databaseBackupEnabled: true,
			databaseBackupTime: '01:45',
			databaseBackupLastSentPeriodStart: null,
			databaseBackupLastSentAt: null,
			updatedAt: new Date('2026-08-26T08:00:00.000Z')
		});

		expect(settings).toEqual(
			expect.objectContaining({
				notificationDeliveryDatabaseBackupDelayMinutes: 15,
				notificationDeliveryDatabaseBackupTime: '02:00',
				supportDatabaseBackupDelayMinutes: 120,
				supportDatabaseBackupTime: '03:45',
				operationsDatabaseBackupDelayMinutes: 135,
				operationsDatabaseBackupTime: '04:00'
			})
		);
	});
});
