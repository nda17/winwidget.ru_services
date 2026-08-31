import {
	DatabaseRestoreJobPhase,
	DatabaseRestoreJobStatus,
	DatabaseRestorePermitStatus
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseRestoreReleaseAuthorizationService } from './database-restore-release-authorization.service';

describe('DatabaseRestoreReleaseAuthorizationService', () => {
	it('keeps the provenance migration transactional with exact receipt and release bindings', () => {
		const migration = readFileSync(
			join(
				__dirname,
				'../../prisma/migrations/20260831100000_add_database_backup_provenance/migration.sql'
			),
			'utf8'
		).trim();

		expect(migration.startsWith('BEGIN;')).toBe(true);
		expect(migration.endsWith('COMMIT;')).toBe(true);
		for (const constraint of [
			'database_restore_jobs_permit_fkey',
			'database_restore_permits_source_backup_job_fkey',
			'database_restore_terminal_receipts_job_fkey',
			'database_restore_release_authorizations_job_fkey',
			'database_restore_release_authorizations_permit_fkey',
			'database_restore_release_authorizations_action_fkey'
		]) {
			expect(migration).toContain(`ADD CONSTRAINT "${constraint}"`);
		}
	});

	it('signs the exact backup provenance generation into release authorization v2', async () => {
		const now = new Date('2026-08-31T00:00:00.000Z');
		const jobId = randomUUID();
		const permitId = randomUUID();
		const sourceBackupJobId = randomUUID();
		const sourceSize = 1024n;
		const provenanceSha = '9'.repeat(64);
		const provenanceKeyId = 'operations-backup-ed25519-2026-08-31';
		const create = jest.fn().mockResolvedValue({});
		const transaction = {
			databaseRestoreJob: {
				findUnique: jest.fn().mockResolvedValue({
					id: jobId,
					permitId,
					eventId: randomUUID(),
					target: 'reporting',
					status: DatabaseRestoreJobStatus.PROCESSING,
					phase: DatabaseRestoreJobPhase.UNFENCING,
					requestedById: 'requester',
					sourceSha256: '1'.repeat(64),
					sourceSize,
					sourceBackupJobId,
					backupProvenanceEnvelopeSha256: provenanceSha,
					backupProvenanceKeyId: provenanceKeyId,
					expectedServicesSha: '2'.repeat(40),
					migrationManifestSha: '3'.repeat(64),
					writerFenceRoles: [
						'winwidget_reporting_runtime',
						'winwidget_reporting_migration',
						'winwidget_reporting_backup'
					],
					writerFenceAppliedAt: now,
					writerFenceEvidenceSha256: '4'.repeat(64),
					safetyBackupSha256: '5'.repeat(64),
					permit: {
						id: permitId,
						status: DatabaseRestorePermitStatus.CONSUMED,
						requestedById: 'requester',
						approvedById: 'approver',
						createdAt: now,
						approvedAt: now,
						expiresAt: new Date('2026-08-31T00:10:00.000Z'),
						consumedAt: now,
						sourceSize,
						sourceBackupJobId,
						backupProvenanceEnvelopeSha256: provenanceSha,
						backupProvenanceKeyId: provenanceKeyId
					}
				})
			},
			databaseRestoreReleaseAuthorization: { create }
		};
		const receipts = {
			canonicalize: jest.fn(value => JSON.stringify(value)),
			sha256: jest.fn().mockReturnValue('6'.repeat(64)),
			sign: jest.fn((payload: string) => {
				expect(payload).toBeTruthy();
				return {
					payloadSha256: '7'.repeat(64),
					signatureHmacSha256: '8'.repeat(64),
					signatureKeyId: 'restore-key-v1'
				};
			})
		};
		const service = new DatabaseRestoreReleaseAuthorizationService(
			{} as never,
			receipts as never
		);

		await service.createRestore(transaction as never, jobId, {
			verifiedAt: now,
			migrationLedgerSha256: 'a'.repeat(64),
			aclEvidenceSha256: 'b'.repeat(64),
			verifiedWriterFenceSha256: '4'.repeat(64)
		});

		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				jobId,
				sourceSize,
				sourceBackupJobId,
				backupProvenanceEnvelopeSha256: provenanceSha,
				backupProvenanceKeyId: provenanceKeyId
			})
		});
		const signedPayload = JSON.parse(receipts.sign.mock.calls[0][0]);
		expect(signedPayload).toEqual(
			expect.objectContaining({
				releaseAuthorizationVersion: 2,
				sourceSize: sourceSize.toString(),
				sourceBackupJobId,
				backupProvenanceEnvelopeSha256: provenanceSha,
				backupProvenanceKeyId: provenanceKeyId
			})
		);
	});

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
