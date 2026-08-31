import {
	DatabaseRestoreJobPhase,
	DatabaseRestoreJobStatus,
	DatabaseRestoreRecoveryActionPhase,
	DatabaseRestoreRecoveryActionType
} from '@prisma/operations-client';
import type { ConsumeMessage } from 'amqplib';
import { randomUUID } from 'node:crypto';
import {
	OPERATIONS_DATABASE_RESTORE_EVENT_TYPE,
	OPERATIONS_DATABASE_RESTORE_RECOVERY_EVENT_TYPE
} from '../messaging/operations-messaging.constants';
import { DATABASE_RESTORE_PHYSICAL_FENCE_UNCONFIRMED } from './database-restore.contract';
import { DatabaseRestoreRecoveryLease } from './database-restore-recovery-state.service';
import { DatabaseRestoreLease } from './database-restore-state.service';
import { DatabaseRestoreWorkerService } from './database-restore-worker.service';

const compensationEvidence = {
	roles: [
		'winwidget_reporting_runtime',
		'winwidget_reporting_migration',
		'winwidget_reporting_backup'
	] as [string, string, string],
	verifiedAt: new Date('2026-08-30T20:00:00.000Z'),
	evidenceSha256: 'f'.repeat(64)
};

const provenanceEventBinding = () => ({
	sourceBackupJobId: randomUUID(),
	backupProvenanceEnvelopeSha256: 'd'.repeat(64),
	backupProvenanceKeyId: 'backup-key-1'
});

const claimedJob = (
	lease: DatabaseRestoreLease,
	overrides: { sourceSha256?: string; sourceSize?: bigint } = {}
) => {
	const sourceSha256 = overrides.sourceSha256 ?? 'c'.repeat(64);
	const sourceSize = overrides.sourceSize ?? 1024n;
	const sourceFileName = 'winwidget-reporting-db-2026-08-31.dump';
	const envelope = {
		keyId: lease.event.backupProvenanceKeyId,
		evidence: {
			target: lease.event.target,
			backupJobId: lease.event.sourceBackupJobId,
			artifactSha256: sourceSha256,
			fileSize: Number(sourceSize),
			fileName: sourceFileName,
			migrationManifestSha: lease.event.migrationManifestSha,
			servicesSha: lease.event.expectedServicesSha,
			imageRevision: lease.event.expectedServicesSha
		}
	};
	return {
		id: lease.event.jobId,
		sourceSha256,
		sourceSize,
		sourceFileName,
		sourceBackupJobId: lease.event.sourceBackupJobId,
		backupProvenance: JSON.stringify({
			envelope,
			envelopeSha256: lease.event.backupProvenanceEnvelopeSha256
		}),
		backupProvenanceEnvelopeSha256:
			lease.event.backupProvenanceEnvelopeSha256,
		backupProvenanceKeyId: lease.event.backupProvenanceKeyId,
		migrationManifestSha: lease.event.migrationManifestSha
	};
};

const provenanceVerifier = {
	verify: jest.fn(async (value: { envelope: unknown }) => value.envelope)
};

describe('DatabaseRestoreWorkerService recovery compensation', () => {
	it.each(['servicesSha', 'imageRevision'] as const)(
		'rejects claimed backup provenance whose %s belongs to another services revision',
		async revisionField => {
			const lease: DatabaseRestoreLease = {
				event: {
					eventId: randomUUID(),
					jobId: randomUUID(),
					target: 'reporting',
					...provenanceEventBinding(),
					expectedServicesSha: 'a'.repeat(40),
					migrationManifestSha: 'b'.repeat(64)
				},
				leaseToken: randomUUID(),
				leaseExpiresAt: new Date(Date.now() + 60_000),
				phase: DatabaseRestoreJobPhase.PREPARING
			};
			const job = claimedJob(lease);
			const signed = JSON.parse(job.backupProvenance) as {
				envelope: { evidence: Record<string, string | number> };
			};
			signed.envelope.evidence[revisionField] = 'f'.repeat(40);
			job.backupProvenance = JSON.stringify(signed);
			const service = new DatabaseRestoreWorkerService(
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				provenanceVerifier as never
			);
			const assertClaimedJobProvenance = (
				service as unknown as {
					assertClaimedJobProvenance(
						value: ReturnType<typeof claimedJob>,
						event: DatabaseRestoreLease['event']
					): Promise<void>;
				}
			).assertClaimedJobProvenance.bind(service);

			await expect(
				assertClaimedJobProvenance(job, lease.event)
			).rejects.toThrow('backup provenance binding is invalid');
		}
	);

	it('parks a queued ordinary restore while the worker kill switch is disabled', async () => {
		const event = {
			schemaVersion: 3,
			eventId: randomUUID(),
			jobId: randomUUID(),
			target: 'reporting',
			...provenanceEventBinding(),
			expectedServicesSha: 'a'.repeat(40),
			migrationManifestSha: 'b'.repeat(64)
		};
		const resolveSourcePath = jest.fn();
		const state = {
			observe: jest.fn(async () => ({ state: 'queued' })),
			claim: jest.fn()
		};
		const service = new DatabaseRestoreWorkerService(
			{ restoreWorkerEnabled: false } as never,
			{} as never,
			{
				isExecutionEnabled: jest.fn(() => false),
				resolveSourcePath
			} as never,
			state as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);
		const message = {
			content: Buffer.from(JSON.stringify(event)),
			properties: {
				type: OPERATIONS_DATABASE_RESTORE_EVENT_TYPE,
				messageId: event.eventId
			}
		} as ConsumeMessage;

		await expect(service.handleMessage(message)).resolves.toBe('requeue');
		expect(state.observe).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: event.jobId })
		);
		expect(state.claim).not.toHaveBeenCalled();
		expect(resolveSourcePath).not.toHaveBeenCalled();
	});

	it('keeps signed terminal reconciliation available while new restores are disabled', async () => {
		const event = {
			schemaVersion: 3,
			eventId: randomUUID(),
			jobId: randomUUID(),
			target: 'reporting',
			...provenanceEventBinding(),
			expectedServicesSha: 'a'.repeat(40),
			migrationManifestSha: 'b'.repeat(64)
		};
		const barrier = {
			operationId: event.jobId,
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(Date.now() + 60_000)
		};
		const state = {
			observe: jest.fn(async () => ({
				state: 'terminal',
				status: DatabaseRestoreJobStatus.SUCCEEDED
			})),
			acquireReconciliation: jest.fn(async () => barrier),
			confirmSucceeded: jest.fn(async () => true),
			hasOtherUnresolvedRecovery: jest.fn(async () => false),
			confirmReleaseAuthorized: jest.fn(async () => ({
				writerFenceEvidenceSha256: 'c'.repeat(64)
			})),
			guardReconciliationRelease: jest.fn(async () => true),
			releaseReconciliation: jest.fn(async () => true)
		};
		const reconcileSucceeded = jest.fn(
			async (
				_target: string,
				_manifest: string,
				_marker: string,
				beforeRelease: () => Promise<void>
			) => beforeRelease()
		);
		const service = new DatabaseRestoreWorkerService(
			{ restoreWorkerEnabled: false } as never,
			{} as never,
			{ isExecutionEnabled: jest.fn(() => false) } as never,
			state as never,
			{} as never,
			{ reconcileSucceeded } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);
		const message = {
			content: Buffer.from(JSON.stringify(event)),
			properties: {
				type: OPERATIONS_DATABASE_RESTORE_EVENT_TYPE,
				messageId: event.eventId
			}
		} as ConsumeMessage;

		await expect(service.handleMessage(message)).resolves.toBe('ack');
		expect(reconcileSucceeded).toHaveBeenCalled();
		expect(state.guardReconciliationRelease).toHaveBeenCalledWith(
			barrier,
			'reporting',
			event.jobId
		);
	});

	it('never re-fences an ambiguous post-release recovery without proving auth absence', async () => {
		const previousRevision = process.env.APP_REVISION;
		const expectedServicesSha = 'a'.repeat(40);
		process.env.APP_REVISION = expectedServicesSha;
		const calls: string[] = [];
		const event = {
			schemaVersion: 1,
			eventId: randomUUID(),
			actionId: randomUUID(),
			jobId: randomUUID(),
			target: 'reporting',
			action: DatabaseRestoreRecoveryActionType.VERIFY_AS_IS,
			receiptPayloadSha: 'b'.repeat(64),
			expectedServicesSha,
			migrationManifestSha: 'c'.repeat(64)
		};
		const lease: DatabaseRestoreRecoveryLease = {
			event: {
				eventId: event.eventId,
				actionId: event.actionId,
				jobId: event.jobId,
				target: 'reporting' as const,
				action: event.action,
				receiptPayloadSha: event.receiptPayloadSha,
				expectedServicesSha,
				migrationManifestSha: event.migrationManifestSha
			},
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(Date.now() + 60_000),
			phase: DatabaseRestoreRecoveryActionPhase.PREPARING
		};
		const recoveryState = {
			claim: jest.fn(async () => ({ state: 'claimed', lease })),
			loadClaimedAction: jest.fn(async () => ({
				restoreJob: {
					sourceSha256: 'd'.repeat(64),
					safetyBackupSha256: 'e'.repeat(64)
				}
			})),
			checkpoint: jest.fn(),
			renew: jest.fn(async () => true),
			resolve: jest.fn(async () => {
				calls.push('resolve');
				return false;
			}),
			confirmResolved: jest.fn(async () => false),
			confirmReleaseAuthorized: jest.fn(async () => null),
			block: jest.fn(async () => {
				calls.push('block');
				return true;
			}),
			recoverExpired: jest.fn(async () => 0)
		};
		const recoveryExecutor = {
			execute: jest.fn(async () => {
				calls.push('release');
				lease.phase = DatabaseRestoreRecoveryActionPhase.UNFENCING;
				return {
					result: { verified: true },
					writerFenceReleasedAt: new Date(),
					writerFenceReleaseEvidenceSha256: 'f'.repeat(64)
				};
			}),
			reapplyFence: jest.fn(async () => {
				calls.push('re-fence');
				return compensationEvidence;
			})
		};
		const service = new DatabaseRestoreWorkerService(
			{ restoreWorkerEnabled: false } as never,
			{} as never,
			{
				resolveSealedSourcePath: jest.fn(
					async () => '/restore-sealed/job.dump'
				)
			} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{ assertBinding: jest.fn() } as never,
			recoveryState as never,
			recoveryExecutor as never
		);
		const message = {
			content: Buffer.from(JSON.stringify(event)),
			properties: {
				type: OPERATIONS_DATABASE_RESTORE_RECOVERY_EVENT_TYPE,
				messageId: event.eventId
			}
		} as ConsumeMessage;

		try {
			await expect(service.handleMessage(message)).rejects.toThrow(
				'Database restore recovery resolution could not be persisted'
			);
			expect(calls).toEqual(['release', 'resolve']);
			expect(recoveryExecutor.reapplyFence).not.toHaveBeenCalled();
			expect(recoveryState.block).not.toHaveBeenCalled();
		} finally {
			if (previousRevision === undefined) delete process.env.APP_REVISION;
			else process.env.APP_REVISION = previousRevision;
		}
	});

	it.each([
		['release outcome is unknown', false],
		['the compensation command also fails', true]
	])(
		'requeues an ambiguous UNFENCING recovery without compensation when %s',
		async (_label, compensationFails) => {
			const calls: string[] = [];
			const lease: DatabaseRestoreRecoveryLease = {
				event: {
					eventId: randomUUID(),
					actionId: randomUUID(),
					jobId: randomUUID(),
					target: 'reporting',
					action: DatabaseRestoreRecoveryActionType.VERIFY_AS_IS,
					receiptPayloadSha: 'a'.repeat(64),
					expectedServicesSha: 'b'.repeat(40),
					migrationManifestSha: 'c'.repeat(64)
				},
				leaseToken: randomUUID(),
				leaseExpiresAt: new Date(Date.now() + 60_000),
				phase: DatabaseRestoreRecoveryActionPhase.PREPARING
			};
			const block = jest.fn(async (_lease, error: Error) => {
				calls.push('block');
				if (compensationFails) {
					expect(error.message).toContain(
						DATABASE_RESTORE_PHYSICAL_FENCE_UNCONFIRMED
					);
				} else {
					expect(error.message).toBe('release outcome unknown');
				}
				return true;
			});
			const recoveryState = {
				loadClaimedAction: jest.fn(async () => ({
					restoreJob: {
						sourceSha256: 'd'.repeat(64),
						safetyBackupSha256: 'e'.repeat(64)
					}
				})),
				checkpoint: jest.fn(),
				renew: jest.fn(async () => true),
				confirmReleaseAuthorized: jest.fn(async () => null),
				block
			};
			const recoveryExecutor = {
				execute: jest.fn(async () => {
					calls.push('release-unknown');
					lease.phase = DatabaseRestoreRecoveryActionPhase.UNFENCING;
					throw new Error('release outcome unknown');
				}),
				reapplyFence: jest.fn(async () => {
					calls.push('re-fence');
					if (compensationFails) {
						throw new Error('fence command unavailable');
					}
					return compensationEvidence;
				})
			};
			const service = new DatabaseRestoreWorkerService(
				{ restoreWorkerEnabled: false } as never,
				{} as never,
				{
					resolveSealedSourcePath: jest.fn(
						async () => '/restore-sealed/job.dump'
					)
				} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				{} as never,
				recoveryState as never,
				recoveryExecutor as never
			);
			const executeRecoveryClaim = (
				service as unknown as {
					executeRecoveryClaim(
						value: DatabaseRestoreRecoveryLease
					): Promise<string>;
				}
			).executeRecoveryClaim.bind(service);

			await expect(executeRecoveryClaim(lease)).rejects.toThrow(
				'release outcome unknown'
			);
			expect(calls).toEqual(['release-unknown']);
			expect(recoveryExecutor.reapplyFence).not.toHaveBeenCalled();
			expect(block).not.toHaveBeenCalled();
		}
	);

	it('requeues an ordinary ambiguous LOGIN outcome without compensation', async () => {
		const calls: string[] = [];
		const lease: DatabaseRestoreLease = {
			event: {
				eventId: randomUUID(),
				jobId: randomUUID(),
				target: 'reporting',
				...provenanceEventBinding(),
				expectedServicesSha: 'a'.repeat(40),
				migrationManifestSha: 'b'.repeat(64)
			},
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(Date.now() + 60_000),
			phase: DatabaseRestoreJobPhase.PREPARING
		};
		const state = {
			loadClaimedJob: jest.fn(async () => claimedJob(lease)),
			renew: jest.fn(async () => true),
			confirmReleaseAuthorized: jest.fn(async () => null),
			fail: jest.fn(async (_lease, error: Error) => {
				calls.push('fail');
				expect(error.message).toBe('release outcome unknown');
				return DatabaseRestoreJobStatus.RECOVERY_REQUIRED;
			})
		};
		const executor = {
			restore: jest.fn(async () => {
				calls.push('release-unknown');
				lease.phase = DatabaseRestoreJobPhase.UNFENCING;
				throw new Error('release outcome unknown');
			}),
			reapplyFence: jest.fn(async () => {
				calls.push('re-fence');
				return compensationEvidence;
			})
		};
		const cleanup = {
			cleanup: jest.fn(async () => calls.push('cleanup'))
		};
		const service = new DatabaseRestoreWorkerService(
			{ restoreWorkerEnabled: false } as never,
			{} as never,
			{
				sealSourceArtifact: jest.fn(async () => ({
					stagingPath: '/restore/job.dump',
					sealedPath: '/restore-sealed/job.dump'
				}))
			} as never,
			state as never,
			{} as never,
			executor as never,
			cleanup as never,
			{} as never,
			{} as never,
			{} as never,
			provenanceVerifier as never
		);
		const executeClaim = (
			service as unknown as {
				executeClaim(
					value: DatabaseRestoreLease,
					source: string
				): Promise<string>;
			}
		).executeClaim.bind(service);

		await expect(executeClaim(lease, '/restore/job.dump')).rejects.toThrow(
			'release outcome unknown'
		);
		expect(calls).toEqual(['release-unknown']);
		expect(executor.reapplyFence).not.toHaveBeenCalled();
		expect(state.fail).not.toHaveBeenCalled();
	});

	it('renews the exact ordinary lease immediately before physical re-fencing', async () => {
		const calls: string[] = [];
		const lease: DatabaseRestoreLease = {
			event: {
				eventId: randomUUID(),
				jobId: randomUUID(),
				target: 'reporting',
				...provenanceEventBinding(),
				expectedServicesSha: 'a'.repeat(40),
				migrationManifestSha: 'b'.repeat(64)
			},
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(Date.now() + 60_000),
			phase: DatabaseRestoreJobPhase.FENCED
		};
		const state = {
			loadClaimedJob: jest.fn(async () =>
				claimedJob(lease, { sourceSize: 1024n })
			),
			confirmReleaseAuthorized: jest.fn(async () => null),
			renew: jest.fn(async () => {
				calls.push('lease-renew');
				return true;
			}),
			fail: jest.fn(async () => {
				calls.push('fail');
				return DatabaseRestoreJobStatus.FAILED;
			})
		};
		const executor = {
			restore: jest.fn(async () => {
				calls.push('restore-failed');
				throw new Error('restore mutation failed');
			}),
			reapplyFence: jest.fn(async () => {
				calls.push('re-fence');
				return compensationEvidence;
			})
		};
		const cleanup = {
			cleanup: jest.fn(async () => calls.push('cleanup'))
		};
		const service = new DatabaseRestoreWorkerService(
			{ restoreWorkerEnabled: false } as never,
			{} as never,
			{
				sealSourceArtifact: jest.fn(async () => ({
					stagingPath: '/restore/job.dump',
					sealedPath: '/restore-sealed/job.dump'
				}))
			} as never,
			state as never,
			{} as never,
			executor as never,
			cleanup as never,
			{} as never,
			{} as never,
			{} as never,
			provenanceVerifier as never
		);
		const executeClaim = (
			service as unknown as {
				executeClaim(
					value: DatabaseRestoreLease,
					source: string
				): Promise<string>;
			}
		).executeClaim.bind(service);

		await expect(executeClaim(lease, '/restore/job.dump')).resolves.toBe(
			'ack'
		);
		expect(calls).toEqual([
			'restore-failed',
			'lease-renew',
			're-fence',
			'fail',
			'cleanup'
		]);
		expect(state.renew).toHaveBeenCalledWith(lease);
		expect(executor.reapplyFence).toHaveBeenCalledWith(
			'reporting',
			lease.event.jobId
		);
	});

	it('does not physically re-fence an ordinary restore after its exact lease is lost', async () => {
		const lease: DatabaseRestoreLease = {
			event: {
				eventId: randomUUID(),
				jobId: randomUUID(),
				target: 'reporting',
				...provenanceEventBinding(),
				expectedServicesSha: 'a'.repeat(40),
				migrationManifestSha: 'b'.repeat(64)
			},
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(Date.now() + 60_000),
			phase: DatabaseRestoreJobPhase.FENCED
		};
		const reapplyFence = jest.fn();
		const fail = jest.fn(async (_lease, error: Error) => {
			expect(error.message).toContain(
				DATABASE_RESTORE_PHYSICAL_FENCE_UNCONFIRMED
			);
			expect(error.message).toContain('exact execution lease was lost');
			return null;
		});
		const state = {
			loadClaimedJob: jest.fn(async () =>
				claimedJob(lease, { sourceSize: 1024n })
			),
			confirmReleaseAuthorized: jest.fn(async () => null),
			renew: jest.fn(async () => false),
			fail
		};
		const service = new DatabaseRestoreWorkerService(
			{ restoreWorkerEnabled: false } as never,
			{} as never,
			{
				sealSourceArtifact: jest.fn(async () => ({
					stagingPath: '/restore/job.dump',
					sealedPath: '/restore-sealed/job.dump'
				}))
			} as never,
			state as never,
			{} as never,
			{
				restore: jest.fn(async () => {
					throw new Error('old worker resumed');
				}),
				reapplyFence
			} as never,
			{ cleanup: jest.fn() } as never,
			{} as never,
			{} as never,
			{} as never,
			provenanceVerifier as never
		);
		const executeClaim = (
			service as unknown as {
				executeClaim(
					value: DatabaseRestoreLease,
					source: string
				): Promise<string>;
			}
		).executeClaim.bind(service);

		await expect(executeClaim(lease, '/restore/job.dump')).rejects.toThrow(
			'Database restore failure checkpoint could not be persisted'
		);
		expect(state.renew).toHaveBeenCalledWith(lease);
		expect(reapplyFence).not.toHaveBeenCalled();
		expect(fail).toHaveBeenCalledWith(lease, expect.any(Error), null);
	});

	it('does not physically re-fence a recovery action after its exact lease is lost', async () => {
		const lease: DatabaseRestoreRecoveryLease = {
			event: {
				eventId: randomUUID(),
				actionId: randomUUID(),
				jobId: randomUUID(),
				target: 'reporting',
				action: DatabaseRestoreRecoveryActionType.VERIFY_AS_IS,
				receiptPayloadSha: 'a'.repeat(64),
				expectedServicesSha: 'b'.repeat(40),
				migrationManifestSha: 'c'.repeat(64)
			},
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(Date.now() + 60_000),
			phase: DatabaseRestoreRecoveryActionPhase.FENCED
		};
		const reapplyFence = jest.fn();
		const block = jest.fn(async (_lease, error: Error) => {
			expect(error.message).toContain(
				DATABASE_RESTORE_PHYSICAL_FENCE_UNCONFIRMED
			);
			return false;
		});
		const recoveryState = {
			loadClaimedAction: jest.fn(async () => ({
				restoreJob: {
					sourceSha256: 'd'.repeat(64),
					safetyBackupSha256: 'e'.repeat(64)
				}
			})),
			confirmReleaseAuthorized: jest.fn(async () => null),
			renew: jest.fn(async () => false),
			block
		};
		const service = new DatabaseRestoreWorkerService(
			{ restoreWorkerEnabled: false } as never,
			{} as never,
			{
				resolveSealedSourcePath: jest.fn(
					async () => '/restore-sealed/job.dump'
				)
			} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			recoveryState as never,
			{
				execute: jest.fn(async () => {
					throw new Error('old recovery worker resumed');
				}),
				reapplyFence
			} as never
		);
		const executeRecoveryClaim = (
			service as unknown as {
				executeRecoveryClaim(
					value: DatabaseRestoreRecoveryLease
				): Promise<string>;
			}
		).executeRecoveryClaim.bind(service);

		await expect(executeRecoveryClaim(lease)).rejects.toThrow(
			'Database restore recovery failure could not be persisted'
		);
		expect(recoveryState.renew).toHaveBeenCalledWith(lease);
		expect(reapplyFence).not.toHaveBeenCalled();
		expect(block).toHaveBeenCalledWith(lease, expect.any(Error), null);
	});

	it('does not reconcile a terminal duplicate while another execution owns the singleton', async () => {
		const reconcileSucceeded = jest.fn();
		const state = {
			acquireReconciliation: jest.fn(async () => null)
		};
		const service = new DatabaseRestoreWorkerService(
			{ restoreWorkerEnabled: false } as never,
			{} as never,
			{} as never,
			state as never,
			{} as never,
			{ reconcileSucceeded } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);
		const event: DatabaseRestoreLease['event'] = {
			eventId: randomUUID(),
			jobId: randomUUID(),
			target: 'reporting',
			...provenanceEventBinding(),
			expectedServicesSha: 'a'.repeat(40),
			migrationManifestSha: 'b'.repeat(64)
		};
		const reconcile = (
			service as unknown as {
				reconcileSucceededEvent(value: typeof event): Promise<string>;
			}
		).reconcileSucceededEvent.bind(service);

		await expect(reconcile(event)).resolves.toBe('requeue');
		expect(reconcileSucceeded).not.toHaveBeenCalled();
	});

	it('does not release a terminal duplicate after its exact reconciliation lease is stale', async () => {
		const event: DatabaseRestoreLease['event'] = {
			eventId: randomUUID(),
			jobId: randomUUID(),
			target: 'reporting',
			...provenanceEventBinding(),
			expectedServicesSha: 'a'.repeat(40),
			migrationManifestSha: 'b'.repeat(64)
		};
		const barrier = {
			operationId: event.jobId,
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(Date.now() + 60_000)
		};
		const physicalRelease = jest.fn();
		const state = {
			acquireReconciliation: jest.fn(async () => barrier),
			confirmSucceeded: jest.fn(async () => true),
			hasOtherUnresolvedRecovery: jest.fn(async () => false),
			confirmReleaseAuthorized: jest.fn(async () => ({
				writerFenceEvidenceSha256: 'c'.repeat(64)
			})),
			guardReconciliationRelease: jest.fn(async () => false),
			releaseReconciliation: jest.fn(async () => true)
		};
		const reconcileSucceeded = jest.fn(
			async (
				_target: string,
				_manifest: string,
				_marker: string,
				beforeRelease: () => Promise<void>
			) => {
				await beforeRelease();
				physicalRelease();
			}
		);
		const service = new DatabaseRestoreWorkerService(
			{ restoreWorkerEnabled: false } as never,
			{} as never,
			{} as never,
			state as never,
			{} as never,
			{ reconcileSucceeded } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);
		const reconcile = (
			service as unknown as {
				reconcileSucceededEvent(value: typeof event): Promise<string>;
			}
		).reconcileSucceededEvent.bind(service);

		await expect(reconcile(event)).rejects.toThrow(
			'terminal reconciliation guard rejected LOGIN'
		);
		expect(state.guardReconciliationRelease).toHaveBeenCalledWith(
			barrier,
			'reporting',
			event.jobId
		);
		expect(physicalRelease).not.toHaveBeenCalled();
		expect(state.releaseReconciliation).toHaveBeenCalledWith(barrier);
	});

	it('acks an old terminal duplicate without opening writers when a newer recovery is unresolved', async () => {
		const event: DatabaseRestoreLease['event'] = {
			eventId: randomUUID(),
			jobId: randomUUID(),
			target: 'reporting',
			...provenanceEventBinding(),
			expectedServicesSha: 'a'.repeat(40),
			migrationManifestSha: 'b'.repeat(64)
		};
		const barrier = {
			operationId: event.jobId,
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(Date.now() + 60_000)
		};
		const reconcileSucceeded = jest.fn();
		const state = {
			acquireReconciliation: jest.fn(async () => barrier),
			confirmSucceeded: jest.fn(async () => true),
			hasOtherUnresolvedRecovery: jest.fn(async () => true),
			releaseReconciliation: jest.fn(async () => true)
		};
		const service = new DatabaseRestoreWorkerService(
			{ restoreWorkerEnabled: false } as never,
			{} as never,
			{} as never,
			state as never,
			{} as never,
			{ reconcileSucceeded } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);
		const reconcile = (
			service as unknown as {
				reconcileSucceededEvent(value: typeof event): Promise<string>;
			}
		).reconcileSucceededEvent.bind(service);

		await expect(reconcile(event)).resolves.toBe('ack');
		expect(state.confirmSucceeded).toHaveBeenCalledWith(event);
		expect(state.hasOtherUnresolvedRecovery).toHaveBeenCalledWith(
			'reporting',
			event.jobId
		);
		expect(reconcileSucceeded).not.toHaveBeenCalled();
		expect(state.releaseReconciliation).toHaveBeenCalledWith(barrier);
	});

	it('does not reopen writers for an old resolved action when another job needs recovery', async () => {
		const event: DatabaseRestoreRecoveryLease['event'] = {
			eventId: randomUUID(),
			actionId: randomUUID(),
			jobId: randomUUID(),
			target: 'reporting',
			action: DatabaseRestoreRecoveryActionType.VERIFY_AS_IS,
			receiptPayloadSha: 'a'.repeat(64),
			expectedServicesSha: 'b'.repeat(40),
			migrationManifestSha: 'c'.repeat(64)
		};
		const barrier = {
			operationId: event.actionId,
			leaseToken: randomUUID(),
			leaseExpiresAt: new Date(Date.now() + 60_000)
		};
		const reconcileResolved = jest.fn();
		const state = {
			acquireReconciliation: jest.fn(async () => barrier),
			hasOtherUnresolvedRecovery: jest.fn(async () => true),
			releaseReconciliation: jest.fn(async () => true)
		};
		const recoveryState = {
			confirmResolved: jest.fn(async () => true)
		};
		const service = new DatabaseRestoreWorkerService(
			{ restoreWorkerEnabled: false } as never,
			{} as never,
			{} as never,
			state as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			recoveryState as never,
			{ reconcileResolved } as never
		);
		const reconcile = (
			service as unknown as {
				reconcileResolvedEvent(value: typeof event): Promise<string>;
			}
		).reconcileResolvedEvent.bind(service);

		await expect(reconcile(event)).resolves.toBe('ack');
		expect(recoveryState.confirmResolved).toHaveBeenCalledWith(event);
		expect(reconcileResolved).not.toHaveBeenCalled();
		expect(state.releaseReconciliation).toHaveBeenCalledWith(barrier);
	});
});
