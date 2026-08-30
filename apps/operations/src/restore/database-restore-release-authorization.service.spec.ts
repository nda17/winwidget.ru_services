import {
	DatabaseRestoreJobPhase,
	DatabaseRestoreJobStatus,
	DatabaseRestorePermitStatus
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { DatabaseRestoreReleaseAuthorizationService } from './database-restore-release-authorization.service';

describe('DatabaseRestoreReleaseAuthorizationService', () => {
	it('rejects an authorization whose verified target generation differs from the fenced job', async () => {
		const now = new Date('2026-08-31T00:00:00.000Z');
		const transaction = {
			databaseRestoreJob: {
				findUnique: jest.fn().mockResolvedValue({
					id: randomUUID(),
					status: DatabaseRestoreJobStatus.PROCESSING,
					phase: DatabaseRestoreJobPhase.UNFENCING,
					requestedById: 'requester',
					writerFenceRoles: [
						'winwidget_reporting_runtime',
						'winwidget_reporting_migration',
						'winwidget_reporting_backup'
					],
					writerFenceAppliedAt: now,
					writerFenceEvidenceSha256: 'a'.repeat(64),
					safetyBackupSha256: 'b'.repeat(64),
					permit: {
						status: DatabaseRestorePermitStatus.CONSUMED,
						requestedById: 'requester',
						approvedById: 'approver',
						approvedAt: now,
						consumedAt: now
					}
				})
			}
		};
		const service = new DatabaseRestoreReleaseAuthorizationService(
			{} as never,
			{} as never
		);

		await expect(
			service.createRestore(transaction as never, randomUUID(), {
				verifiedAt: now,
				migrationLedgerSha256: 'c'.repeat(64),
				aclEvidenceSha256: 'd'.repeat(64),
				verifiedWriterFenceSha256: 'e'.repeat(64)
			})
		).rejects.toThrow('release generation evidence drifted');
	});
});
