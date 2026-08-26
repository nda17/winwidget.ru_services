import { OperationsDatabasePhase } from '@prisma/operations-client';
import {
	OperationsCutoverError,
	parseOperationsCutoverArgs,
	parseOperationsSnapshot,
	requiresFrozenSnapshotCountCheck
} from './main';

const SHA = 'a'.repeat(64);

describe('Operations cutover contract', () => {
	it('accepts only explicit forward actions', () => {
		expect(parseOperationsCutoverArgs(['status'])).toEqual({
			action: 'status'
		});
		expect(
			parseOperationsCutoverArgs([
				'import',
				'--file',
				'/tmp/operations.json',
				'--sha256',
				SHA
			])
		).toEqual({
			action: 'import',
			file: '/tmp/operations.json',
			sha256: SHA
		});
		expect(
			parseOperationsCutoverArgs(['activate', '--sha256', SHA])
		).toEqual({ action: 'activate', sha256: SHA });
		expect(() => parseOperationsCutoverArgs(['abort'])).toThrow(
			OperationsCutoverError
		);
	});

	it('validates exact Notes and AdminEventLog snapshot rows', () => {
		const createdAt = '2026-08-24T03:00:00.000Z';
		const parsed = parseOperationsSnapshot({
			schemaVersion: 1,
			sourceRevision: 'b'.repeat(40),
			createdAt,
			counts: { notes: 1, adminEventLogs: 1 },
			notes: [
				{
					id: 'note-1',
					text: 'text',
					done: false,
					createdAt,
					updatedAt: createdAt
				}
			],
			adminEventLogs: [
				{
					id: 'event-1',
					adminId: 'admin-1',
					adminName: null,
					adminEmail: null,
					section: 'SUPPORT',
					action: 'SUPPORT_DELIVERY_CLOSE',
					description: 'closed',
					entityType: 'SupportDelivery',
					entityId: 'event-id',
					entityLabel: null,
					targetUserId: null,
					targetUserName: null,
					targetUserEmail: null,
					metadata: { eventId: 'event-id' },
					ip: null,
					userAgent: null,
					createdAt
				}
			]
		});

		expect(parsed.counts).toEqual({ notes: 1, adminEventLogs: 1 });
		expect(parsed.adminEventLogs[0]?.section).toBe('SUPPORT');
	});

	it('rejects count drift and unknown snapshot fields', () => {
		const createdAt = '2026-08-24T03:00:00.000Z';
		expect(() =>
			parseOperationsSnapshot({
				schemaVersion: 1,
				sourceRevision: 'b'.repeat(40),
				createdAt,
				counts: { notes: 1, adminEventLogs: 0 },
				notes: [],
				adminEventLogs: [],
				legacy: true
			})
		).toThrow(OperationsCutoverError);
	});

	it('allows runtime rows to change after the matching snapshot is ACTIVE', () => {
		const revision = 'b'.repeat(40);

		expect(
			requiresFrozenSnapshotCountCheck(
				OperationsDatabasePhase.ACTIVE,
				SHA,
				revision,
				SHA,
				revision
			)
		).toBe(false);
		expect(
			requiresFrozenSnapshotCountCheck(
				OperationsDatabasePhase.IMPORTED,
				SHA,
				revision,
				SHA,
				revision
			)
		).toBe(true);
		expect(() =>
			requiresFrozenSnapshotCountCheck(
				OperationsDatabasePhase.ACTIVE,
				'c'.repeat(64),
				revision,
				SHA,
				revision
			)
		).toThrow(OperationsCutoverError);
	});
});
