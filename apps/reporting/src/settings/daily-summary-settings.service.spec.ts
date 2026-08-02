import type { CoreInternalClient } from '../internal/core-internal.client';
import type { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import {
	DailySummarySettingsService,
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
				coreOperationalAlertsDestinationChatId: '-100123',
				coreOperationalAlertsThreadId: 43,
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
				coreOperationalAlertsDestinationChatId: '-100123',
				coreOperationalAlertsThreadId: 43,
				scheduleTime: '01:50',
				timezone: 'Europe/Moscow'
			})
		).toThrow(
			'requires complete Daily Summary and Core operational alerts routes'
		);
	});

	it('rejects a non-IANA timezone', () => {
		expect(() =>
			validateDailySummarySettingsConfig({
				enabled: false,
				destinationChatId: null,
				messageThreadId: null,
				coreOperationalAlertsDestinationChatId: null,
				coreOperationalAlertsThreadId: null,
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
				coreOperationalAlertsDestinationChatId: null,
				coreOperationalAlertsThreadId: null,
				scheduleTime: '01:50',
				timezone: 'UTC'
			})
		).toThrow('must remain Europe/Moscow');
	});

	it('rejects sharing one topic with Core operational alerts', () => {
		expect(() =>
			validateDailySummarySettingsConfig({
				enabled: true,
				destinationChatId: '-100123',
				messageThreadId: 42,
				coreOperationalAlertsDestinationChatId: '-100123',
				coreOperationalAlertsThreadId: 42,
				scheduleTime: '01:50',
				timezone: 'Europe/Moscow'
			})
		).toThrow('require separate Telegram topics');
	});
});

describe('Daily Summary PATCH command boundary', () => {
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

describe('Daily Summary local schedule generation', () => {
	it('creates a stable idempotency key for a local CAS command', () => {
		const service = new DailySummarySettingsService(
			{} as ReportingPrismaService,
			{} as CoreInternalClient
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
