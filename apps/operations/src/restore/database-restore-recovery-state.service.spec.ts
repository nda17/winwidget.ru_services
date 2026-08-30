import {
	DatabaseRestoreJobStatus,
	DatabaseRestoreRecoveryActionPhase,
	DatabaseRestoreRecoveryActionStatus,
	DatabaseRestoreRecoveryActionType
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseRestoreRecoveryStateService } from './database-restore-recovery-state.service';

describe('DatabaseRestoreRecoveryStateService expired recovery', () => {
	it('keeps the migration fail-closed on one global permit and exact target role triplets', () => {
		const migration = readFileSync(
			join(
				__dirname,
				'../../prisma/migrations/20260830121000_add_database_restore_recovery_executor_contract/migration.sql'
			),
			'utf8'
		);
		expect(migration).toContain(
			'CREATE UNIQUE INDEX "database_restore_permits_global_active_unique"'
		);
		expect(migration).toContain(
			'ON "operations"."database_restore_permits"((1))'
		);
		expect(migration).toContain(
			'CREATE TRIGGER "database_restore_recovery_actions_immutable_binding"'
		);
		expect(migration).toContain(
			'CREATE TRIGGER "database_restore_permits_immutable_binding"'
		);
		for (const roles of [
			'winwidget_notification_delivery_runtime","winwidget_notification_delivery_migration","winwidget_notification_delivery_backup',
			'winwidget_campaigns_runtime","winwidget_campaigns_migration","winwidget_campaigns_backup',
			'winwidget_reporting_runtime","winwidget_reporting_migration","winwidget_reporting_backup',
			'winwidget_widgets_runtime","winwidget_widgets_migration","winwidget_widgets_backup',
			'winwidget_identity_runtime","winwidget_identity_migration","winwidget_identity_backup',
			'winwidget_platform_runtime","winwidget_platform_migration","winwidget_platform_backup',
			'winwidget_support_runtime","winwidget_support_migration","winwidget_support_backup'
		]) {
			expect(migration.split(roles)).toHaveLength(5);
		}
		expect(migration).toContain(
			'CONSTRAINT "database_restore_recovery_receipts_target"'
		);
		expect(migration).toContain(
			'ADD CONSTRAINT "database_restore_terminal_receipts_writer_fence_exact_roles"'
		);
		expect(migration).toContain(
			'CREATE TRIGGER "database_restore_jobs_immutable_recovery_resolution"'
		);
		expect(migration).toContain(
			'Database restore terminal recovery action is immutable'
		);
	});

	it('atomically expires a stale APPROVED action before any execution lease claim', async () => {
		const actionId = randomUUID();
		const expire = jest.fn(async () => ({ count: 1 }));
		const executionLease = jest.fn();
		const prisma = {
			databaseRestoreRecoveryAction: {
				findUnique: jest.fn(async () => ({
					id: actionId,
					status: DatabaseRestoreRecoveryActionStatus.APPROVED,
					expiresAt: new Date(Date.now() - 1)
				})),
				updateMany: expire
			},
			$transaction: jest.fn(async callback =>
				callback({
					databaseRestoreExecutionLease: { updateMany: executionLease }
				})
			)
		};
		const service = new DatabaseRestoreRecoveryStateService(
			{} as never,
			prisma as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);

		await expect(
			service.claim({
				eventId: randomUUID(),
				actionId,
				jobId: randomUUID(),
				target: 'reporting',
				action: DatabaseRestoreRecoveryActionType.VERIFY_AS_IS,
				receiptPayloadSha: 'a'.repeat(64),
				expectedServicesSha: 'b'.repeat(40),
				migrationManifestSha: 'c'.repeat(64)
			})
		).resolves.toEqual({ state: 'unclaimed' });
		expect(expire).toHaveBeenCalledWith({
			where: {
				id: actionId,
				status: DatabaseRestoreRecoveryActionStatus.APPROVED,
				expiresAt: { lte: expect.any(Date) },
				phase: null,
				leaseToken: null
			},
			data: { status: DatabaseRestoreRecoveryActionStatus.EXPIRED }
		});
		expect(executionLease).not.toHaveBeenCalled();
	});

	it('CAS-reserves the expired global lease, physically re-fences, then persists BLOCKED', async () => {
		const calls: string[] = [];
		const expiredLeaseToken = randomUUID();
		const action = {
			id: randomUUID(),
			jobId: randomUUID(),
			eventId: randomUUID(),
			action: DatabaseRestoreRecoveryActionType.VERIFY_AS_IS,
			status: DatabaseRestoreRecoveryActionStatus.PROCESSING,
			phase: DatabaseRestoreRecoveryActionPhase.UNFENCING,
			receiptPayloadSha: 'a'.repeat(64),
			requestedById: 'requester',
			approvedById: 'approver',
			approvedAt: new Date(),
			expiresAt: new Date(Date.now() + 60_000),
			leaseOwner: 'expired-worker',
			leaseToken: expiredLeaseToken,
			leaseExpiresAt: new Date(Date.now() - 1),
			attempts: 1,
			artifactSha256: null,
			writerFenceRoles: null,
			writerFenceRequestedAt: null,
			writerFenceAppliedAt: null,
			writerFenceReleasedAt: null,
			writerFenceEvidenceSha256: null,
			writerFenceReleaseEvidenceSha256: null,
			result: null,
			lastError: null,
			startedAt: new Date(),
			finishedAt: null,
			createdAt: new Date(),
			updatedAt: new Date(),
			restoreJob: {
				target: 'reporting',
				status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED,
				expectedServicesSha: 'b'.repeat(40),
				migrationManifestSha: 'c'.repeat(64)
			}
		};
		const executionUpdate = jest.fn(async ({ data }) => {
			calls.push(
				data.operationType === null
					? 'release-execution'
					: 'reserve-execution'
			);
			return { count: 1 };
		});
		const actionUpdate = jest.fn(async ({ data }) => {
			calls.push(
				data.status === DatabaseRestoreRecoveryActionStatus.BLOCKED
					? 'block-action'
					: 'reserve-action'
			);
			return { count: 1 };
		});
		const transaction = {
			databaseRestoreExecutionLease: { updateMany: executionUpdate },
			databaseRestoreRecoveryAction: { updateMany: actionUpdate }
		};
		const prisma = {
			databaseRestoreRecoveryAction: {
				updateMany: jest.fn(async () => {
					calls.push('expire-scan');
					return { count: 0 };
				}),
				findMany: jest.fn(async () => [action])
			},
			$transaction: jest.fn(async callback => callback(transaction))
		};
		const alerts = {
			recordInTransaction: jest.fn(async () => calls.push('alert'))
		};
		const audit = {
			recordInTransaction: jest.fn(async () => calls.push('audit'))
		};
		const target = { database: 'winwidget_reporting' };
		const writerFence = {
			apply: jest.fn(async () => {
				calls.push('fence');
				return {
					roles: [
						'winwidget_reporting_runtime',
						'winwidget_reporting_migration',
						'winwidget_reporting_backup'
					] as [string, string, string],
					verifiedAt: new Date('2026-08-30T20:00:00.000Z'),
					evidenceSha256: 'd'.repeat(64)
				};
			})
		};
		const service = new DatabaseRestoreRecoveryStateService(
			{ get: jest.fn() } as never,
			prisma as never,
			alerts as never,
			audit as never,
			{} as never,
			{
				get: jest.fn(() => target),
				connection: jest.fn(async () => ({}))
			} as never,
			writerFence as never,
			undefined,
			{ assertRecovery: jest.fn().mockResolvedValue(null) } as never
		);

		await expect(service.recoverExpired(25)).resolves.toBe(1);
		expect(calls).toEqual([
			'expire-scan',
			'reserve-execution',
			'reserve-action',
			'fence',
			'block-action',
			'release-execution',
			'alert',
			'audit'
		]);
		expect(writerFence.apply).toHaveBeenCalledWith({}, target, action.id);
		expect(actionUpdate.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				where: expect.objectContaining({
					leaseToken: expiredLeaseToken,
					leaseExpiresAt: { lte: expect.any(Date) }
				})
			})
		);
		expect(actionUpdate.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({
				where: expect.objectContaining({
					leaseToken: expect.not.stringMatching(expiredLeaseToken),
					leaseExpiresAt: { gt: expect.any(Date) }
				}),
				data: expect.objectContaining({
					status: DatabaseRestoreRecoveryActionStatus.BLOCKED
				})
			})
		);
	});
});
