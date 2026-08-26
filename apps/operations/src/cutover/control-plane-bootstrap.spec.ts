import { randomUUID } from 'node:crypto';
import { parseControlPlaneSnapshot } from './control-plane-bootstrap';

const snapshot = () => ({
	schemaVersion: 1,
	sourceRevision: 'a'.repeat(40),
	createdAt: '2026-08-26T08:00:00.000Z',
	telegramBotSettings: {
		dailySummaryChatId: '-1001234567890',
		databaseBackupThreadId: 10,
		paymentsThreadId: 11,
		operationalAlertsThreadId: 12,
		databaseBackupEnabled: true,
		databaseBackupTime: '01:45',
		databaseBackupLastSentPeriodStart: '2026-08-25T21:00:00.000Z',
		databaseBackupLastSentAt: '2026-08-25T23:15:00.000Z'
	},
	reportingSchedulePolicy: {
		reservationTime: '04:30',
		reservationGeneration: '7',
		confirmedChangeId: randomUUID(),
		pendingChangeId: null,
		pendingTime: null,
		pendingGeneration: null
	}
});

describe('parseControlPlaneSnapshot', () => {
	it('accepts only the current singleton and schedule-policy anchor contract', () => {
		const value = snapshot();
		expect(parseControlPlaneSnapshot(value)).toEqual(value);
	});

	it('rejects historical jobs and any unexpected compatibility fields', () => {
		expect(() =>
			parseControlPlaneSnapshot({
				...snapshot(),
				scheduledJobs: []
			})
		).toThrow('unexpected fields');
	});

	it('requires a complete pending schedule-policy tuple', () => {
		const current = snapshot();
		const value = {
			...current,
			reportingSchedulePolicy: {
				...current.reportingSchedulePolicy,
				pendingChangeId: randomUUID()
			}
		};
		expect(() => parseControlPlaneSnapshot(value)).toThrow(
			'Reporting schedule policy snapshot is invalid'
		);
	});

	it('rejects a schedule anchor that collides with a backup slot', () => {
		const current = snapshot();
		expect(() =>
			parseControlPlaneSnapshot({
				...current,
				reportingSchedulePolicy: {
					...current.reportingSchedulePolicy,
					reservationTime: '03:00'
				}
			})
		).toThrow('Разнесите отправку сводки');
	});
});
