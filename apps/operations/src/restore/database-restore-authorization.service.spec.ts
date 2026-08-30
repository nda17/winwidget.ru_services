import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import {
	DatabaseRestoreJobStatus,
	DatabaseRestorePermitStatus,
	DatabaseRestoreRecoveryActionStatus,
	DatabaseRestoreRecoveryActionType
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { DatabaseRestoreAuthorizationService } from './database-restore-authorization.service';

const SERVICES_SHA = 'a'.repeat(40);
const SOURCE_SHA = 'b'.repeat(64);
const MANIFEST_SHA = 'c'.repeat(64);
const config = (values: Record<string, string>) =>
	({ get: (key: string) => values[key] }) as ConfigService;
const context = (actorId: string) => ({
	actorId,
	ip: null,
	userAgent: null
});
const manifests = () => ({
	sha256: jest.fn().mockReturnValue(MANIFEST_SHA)
});

describe('DatabaseRestoreAuthorizationService', () => {
	it('creates a short-lived exact permit bound to a preallocated job', async () => {
		const create = jest.fn().mockImplementation(({ data }) => ({
			...data,
			status: DatabaseRestorePermitStatus.PENDING_APPROVAL,
			approvedById: null,
			consumedAt: null,
			closedAt: null,
			createdAt: new Date(),
			updatedAt: new Date()
		}));
		const transaction = { databaseRestorePermit: { create } };
		const audit = { recordInTransaction: jest.fn().mockResolvedValue({}) };
		const prisma = {
			databaseRestorePermit: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			$transaction: jest.fn(callback => callback(transaction))
		};
		const service = new DatabaseRestoreAuthorizationService(
			config({
				DATABASE_RESTORE_ENABLED: 'true',
				APP_REVISION: SERVICES_SHA
			}),
			prisma as never,
			audit as never,
			manifests() as never
		);

		await expect(
			service.createPermit(
				{
					target: 'reporting',
					sourceSha256: SOURCE_SHA,
					expectedServicesSha: SERVICES_SHA
				},
				context('dev-one')
			)
		).resolves.toEqual(
			expect.objectContaining({
				permitId: expect.any(String),
				jobId: expect.any(String),
				target: 'reporting',
				sourceSha256: SOURCE_SHA,
				expectedServicesSha: SERVICES_SHA,
				migrationManifestSha: MANIFEST_SHA,
				status: DatabaseRestorePermitStatus.PENDING_APPROVAL
			})
		);
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				id: expect.any(String),
				jobId: expect.any(String),
				requestedById: 'dev-one',
				expiresAt: expect.any(Date)
			})
		});
		expect(audit.recordInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				action: 'DEV_DATABASE_RESTORE_PERMIT_REQUESTED'
			})
		);
	});

	it('reports the database global-active-permit conflict without exposing a target-local contract', async () => {
		const conflict = Object.assign(new Error('unique'), { code: 'P2002' });
		const service = new DatabaseRestoreAuthorizationService(
			config({
				DATABASE_RESTORE_ENABLED: 'true',
				APP_REVISION: SERVICES_SHA
			}),
			{
				databaseRestorePermit: {
					updateMany: jest.fn().mockResolvedValue({ count: 0 })
				},
				$transaction: jest.fn().mockRejectedValue(conflict)
			} as never,
			{} as never,
			manifests() as never
		);

		await expect(
			service.createPermit(
				{
					target: 'reporting',
					sourceSha256: SOURCE_SHA,
					expectedServicesSha: SERVICES_SHA
				},
				context('dev-one')
			)
		).rejects.toThrow(
			'Уже есть глобальный активный one-shot permit восстановления'
		);
	});

	it('consumes an approved exact permit once with a single CAS', async () => {
		const jobId = randomUUID();
		const permit = {
			id: randomUUID(),
			jobId,
			target: 'reporting',
			sourceSha256: SOURCE_SHA,
			expectedServicesSha: SERVICES_SHA,
			migrationManifestSha: MANIFEST_SHA,
			requestedById: 'dev-one'
		};
		const consume = jest
			.fn()
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 });
		const transaction = {
			databaseRestorePermit: {
				findUnique: jest.fn().mockResolvedValue(permit),
				updateMany: consume
			}
		};
		const service = new DatabaseRestoreAuthorizationService(
			config({ APP_REVISION: SERVICES_SHA }),
			{} as never,
			{} as never,
			manifests() as never
		);
		const input = {
			jobId,
			target: 'reporting' as const,
			sourceSha256: SOURCE_SHA,
			actorId: 'dev-one'
		};

		await expect(
			service.consumePermit(transaction as never, input)
		).resolves.toBe(permit);
		expect(consume).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: permit.id,
				jobId,
				status: DatabaseRestorePermitStatus.APPROVED,
				consumedAt: null,
				closedAt: null
			}),
			data: {
				status: DatabaseRestorePermitStatus.CONSUMED,
				consumedAt: expect.any(Date)
			}
		});
		await expect(
			service.consumePermit(transaction as never, input)
		).rejects.toBeInstanceOf(ConflictException);
	});

	it('rejects a permit created for a stale migration manifest', async () => {
		const jobId = randomUUID();
		const transaction = {
			databaseRestorePermit: {
				findUnique: jest.fn().mockResolvedValue({
					id: randomUUID(),
					jobId,
					target: 'reporting',
					sourceSha256: SOURCE_SHA,
					expectedServicesSha: SERVICES_SHA,
					migrationManifestSha: 'd'.repeat(64),
					requestedById: 'dev-one'
				}),
				updateMany: jest.fn()
			}
		};
		const service = new DatabaseRestoreAuthorizationService(
			config({ APP_REVISION: SERVICES_SHA }),
			{} as never,
			{} as never,
			manifests() as never
		);

		await expect(
			service.consumePermit(transaction as never, {
				jobId,
				target: 'reporting',
				sourceSha256: SOURCE_SHA,
				actorId: 'dev-one'
			})
		).rejects.toBeInstanceOf(ConflictException);
		expect(
			transaction.databaseRestorePermit.updateMany
		).not.toHaveBeenCalled();
	});

	it('requires a second actor and atomically dispatches the recovery executor', async () => {
		const jobId = randomUUID();
		const actionId = randomUUID();
		const receiptPayloadSha = 'd'.repeat(64);
		const recoveryAction = {
			id: actionId,
			jobId,
			action: DatabaseRestoreRecoveryActionType.ROLL_BACK_SAFETY,
			status: DatabaseRestoreRecoveryActionStatus.PENDING_APPROVAL,
			receiptPayloadSha,
			requestedById: 'dev-one',
			approvedById: null,
			expiresAt: new Date(Date.now() + 60_000),
			restoreJob: {
				target: 'reporting',
				status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED,
				recoveryResolvedAt: null,
				expectedServicesSha: SERVICES_SHA,
				migrationManifestSha: MANIFEST_SHA,
				terminalReceipt: { payloadSha256: receiptPayloadSha }
			}
		};
		const approve = jest.fn().mockResolvedValue({ count: 1 });
		const transaction = {
			databaseRestoreRecoveryAction: {
				findUnique: jest.fn().mockResolvedValue(recoveryAction),
				updateMany: approve,
				findUniqueOrThrow: jest.fn().mockResolvedValue({
					...recoveryAction,
					status: DatabaseRestoreRecoveryActionStatus.APPROVED,
					approvedById: 'dev-two'
				})
			}
		};
		const audit = { recordInTransaction: jest.fn().mockResolvedValue({}) };
		const outbox = { enqueue: jest.fn().mockResolvedValue({}) };
		const prisma = {
			databaseRestoreRecoveryAction: {
				updateMany: jest.fn().mockResolvedValue({ count: 0 })
			},
			$transaction: jest.fn(callback => callback(transaction))
		};
		const service = new DatabaseRestoreAuthorizationService(
			config({
				DATABASE_RESTORE_ENABLED: 'false',
				APP_REVISION: SERVICES_SHA
			}),
			prisma as never,
			audit as never,
			manifests() as never,
			outbox as never
		);

		await expect(
			service.approveRecoveryAction(jobId, actionId, context('dev-one'))
		).rejects.toBeInstanceOf(ConflictException);
		await expect(
			service.approveRecoveryAction(jobId, actionId, context('dev-two'))
		).resolves.toEqual(
			expect.objectContaining({
				status: DatabaseRestoreRecoveryActionStatus.APPROVED,
				executionAllowed: true,
				executorStatus: DatabaseRestoreRecoveryActionStatus.APPROVED
			})
		);
		expect(approve).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					requestedById: { not: 'dev-two' }
				})
			})
		);
		expect(audit.recordInTransaction).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				action: 'DEV_DATABASE_RESTORE_RECOVERY_APPROVED',
				metadata: expect.objectContaining({
					executionAllowed: true,
					executorStatus: DatabaseRestoreRecoveryActionStatus.APPROVED
				})
			})
		);
		expect(outbox.enqueue).toHaveBeenCalledWith(
			transaction,
			expect.objectContaining({
				eventType:
					'operations.database-restore.recovery-action.requested.v1',
				routingKey: 'operations.database-restore.requested.v1',
				payload: expect.objectContaining({
					actionId,
					jobId,
					expectedServicesSha: SERVICES_SHA,
					migrationManifestSha: MANIFEST_SHA
				})
			})
		);
	});
});
