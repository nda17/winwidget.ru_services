import type { OperationsInternalClient } from '../internal/operations-internal.client';
import type { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import {
	DailySummarySettingsService,
	ensureDailySummaryDestinationChangeAllowed,
	getDailySummarySettingsUpdateKind,
	validateDailySummarySettingsConfig
} from './daily-summary-settings.service';

describe('Daily Summary final configuration validation', () => {
	it('validates the complete merged config atomically', () => {
		expect(() =>
			validateDailySummarySettingsConfig({
				enabled: true,
				destinationChatId: '-100123',
				messageThreadId: 42,
				operationalAlertsThreadId: 43,
				scheduleTime: '01:50',
				timezone: 'Europe/Moscow'
			})
		).not.toThrow();
	});

	it('rejects enabling a partial final destination', () => {
		expect(() =>
			validateDailySummarySettingsConfig({
				enabled: true,
				destinationChatId: '-100123',
				messageThreadId: null,
				operationalAlertsThreadId: 43,
				scheduleTime: '01:50',
				timezone: 'Europe/Moscow'
			})
		).toThrow('requires Daily Summary and operational alerts topics');
	});

	it('rejects a non-IANA timezone', () => {
		expect(() =>
			validateDailySummarySettingsConfig({
				enabled: false,
				destinationChatId: null,
				messageThreadId: null,
				operationalAlertsThreadId: null,
				scheduleTime: '01:50',
				timezone: 'Mars/Olympus'
			})
		).toThrow('valid IANA');
	});

	it('keeps Daily Summary in the same timezone as the backup authority', () => {
		expect(() =>
			validateDailySummarySettingsConfig({
				enabled: false,
				destinationChatId: null,
				messageThreadId: null,
				operationalAlertsThreadId: null,
				scheduleTime: '01:50',
				timezone: 'UTC'
			})
		).toThrow('must remain Europe/Moscow');
	});

	it('rejects sharing one topic with operational alerts', () => {
		expect(() =>
			validateDailySummarySettingsConfig({
				enabled: true,
				destinationChatId: '-100123',
				messageThreadId: 42,
				operationalAlertsThreadId: 42,
				scheduleTime: '01:50',
				timezone: 'Europe/Moscow'
			})
		).toThrow('require separate Telegram topics');
	});
});

describe('Daily Summary PATCH command boundary', () => {
	it('allows initial destination setup and resubmitting the configured group', () => {
		expect(() =>
			ensureDailySummaryDestinationChangeAllowed(null, '-100123')
		).not.toThrow();
		expect(() =>
			ensureDailySummaryDestinationChangeAllowed('-100123', ' -100123 ')
		).not.toThrow();
	});

	it('rejects changing or clearing the configured shared Telegram group', () => {
		expect(() =>
			ensureDailySummaryDestinationChangeAllowed('-100123', '-100999')
		).toThrow('only be changed through the maintenance procedure');
		expect(() =>
			ensureDailySummaryDestinationChangeAllowed('-100123', null)
		).toThrow('only be changed through the maintenance procedure');
	});

	it('rejects an empty update', () => {
		expect(() => getDailySummarySettingsUpdateKind({})).toThrow(
			'cannot be empty'
		);
	});

	it('rejects a schedule update without its expected generation', () => {
		expect(() =>
			getDailySummarySettingsUpdateKind({ scheduleTime: '02:10' })
		).toThrow('required together');
	});

	it('accepts one atomic local settings and schedule command', () => {
		expect(() =>
			getDailySummarySettingsUpdateKind({
				destinationChatId: '-100999',
				messageThreadId: 42,
				scheduleTime: '02:10',
				expectedScheduleGeneration: '7'
			})
		).not.toThrow();
	});

	it('classifies local and CAS schedule commands', () => {
		expect(
			getDailySummarySettingsUpdateKind({ messageThreadId: 42 })
		).toBe('local');
		expect(
			getDailySummarySettingsUpdateKind({
				scheduleTime: '02:10',
				expectedScheduleGeneration: '7'
			})
		).toBe('schedule');
	});
});

describe('Daily Summary destination ownership', () => {
	it('fails before DB mutation or Operations policy calls when an ordinary PATCH changes the group', async () => {
		const settings = {
			id: 'daily-summary',
			enabled: true,
			destinationChatId: '-100123',
			messageThreadId: 42,
			operationalAlertsThreadId: 43,
			operationalAlertsChangedAt: new Date('2026-08-26T08:00:00.000Z'),
			scheduleTime: '01:50',
			scheduleGeneration: 0n,
			schedulePolicyChangeId: null,
			timezone: 'Europe/Moscow',
			lastSuccessfulPeriodStart: null,
			lastSuccessfulAt: null,
			lastFailedPeriodStart: null,
			lastFailedAt: null,
			lastFailureCode: null,
			lastFailureReason: null,
			createdAt: new Date('2026-08-26T08:00:00.000Z'),
			updatedAt: new Date('2026-08-26T08:00:00.000Z')
		};
		const prisma = {
			reportingSettings: {
				upsert: jest.fn().mockResolvedValue(settings)
			},
			$transaction: jest.fn()
		};
		const operations = {
			reserveDailySummarySchedulePolicy: jest.fn(),
			confirmDailySummarySchedulePolicy: jest.fn()
		};
		const service = new DailySummarySettingsService(
			prisma as unknown as ReportingPrismaService,
			operations as unknown as OperationsInternalClient
		);

		await expect(
			service.updateSettings({ destinationChatId: '-100999' }, 'admin-id')
		).rejects.toThrow(
			'Daily Summary Telegram group can only be changed through the maintenance procedure'
		);

		expect(prisma.$transaction).not.toHaveBeenCalled();
		expect(
			operations.reserveDailySummarySchedulePolicy
		).not.toHaveBeenCalled();
		expect(
			operations.confirmDailySummarySchedulePolicy
		).not.toHaveBeenCalled();
	});
});

describe('Daily Summary local schedule generation', () => {
	it('creates a stable idempotency key for a local CAS command', () => {
		const service = new DailySummarySettingsService(
			{} as ReportingPrismaService,
			{} as OperationsInternalClient
		);
		const createPolicyChangeId = (
			service as any
		).createPolicyChangeId.bind(service);
		expect(createPolicyChangeId('02:20', '2')).toBe(
			createPolicyChangeId('02:20', '2')
		);
		expect(createPolicyChangeId('02:20', '2')).not.toBe(
			createPolicyChangeId('02:21', '2')
		);
	});
});
