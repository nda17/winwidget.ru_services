import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException,
	ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	DatabaseRestoreJobStatus,
	DatabaseRestorePermitStatus,
	DatabaseRestoreRecoveryActionStatus,
	DatabaseRestoreRecoveryActionType,
	Prisma,
	ScheduledJobRunStatus
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { AdminEventLogService } from '../admin-event-log/admin-event-log.service';
import {
	DatabaseBackupProvenanceEnvelope,
	DatabaseBackupProvenanceService,
	SignedDatabaseBackupProvenance
} from '../maintenance/database-backup-provenance.service';
import {
	OPERATIONS_DATABASE_RESTORE_RECOVERY_EVENT_TYPE,
	OPERATIONS_DATABASE_RESTORE_ROUTING_KEY
} from '../messaging/operations-messaging.constants';
import { OperationsOutboxService } from '../messaging/operations-outbox.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { databaseBackupJobType } from '../scheduled-jobs/scheduled-jobs.types';
import {
	DATABASE_RESTORE_PERMIT_TTL_MS,
	DATABASE_RESTORE_RECOVERY_ACTION_TTL_MS,
	DATABASE_RESTORE_SERVICES_SHA_PATTERN,
	DATABASE_RESTORE_SHA256_PATTERN,
	DATABASE_RESTORE_TARGETS,
	DatabaseRestoreTarget
} from './database-restore.contract';
import { DatabaseRestoreMigrationManifestService } from './database-restore-migration-manifest.service';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ActorContext {
	actorId: string;
	ip: string | null;
	userAgent: string | null;
}

interface VerifiedBackupProvenance {
	signed: SignedDatabaseBackupProvenance;
	envelope: DatabaseBackupProvenanceEnvelope;
	serialized: string;
}

@Injectable()
export class DatabaseRestoreAuthorizationService {
	constructor(
		private readonly config: ConfigService,
		private readonly prisma: OperationsPrismaService,
		private readonly audit: AdminEventLogService,
		private readonly manifests: DatabaseRestoreMigrationManifestService,
		private readonly outbox: OperationsOutboxService = new OperationsOutboxService(),
		private readonly provenance: DatabaseBackupProvenanceService = new DatabaseBackupProvenanceService()
	) {}

	async getApprovedPermit() {
		await this.closeExpiredPermits();
		const permit = await this.prisma.databaseRestorePermit.findFirst({
			where: {
				status: DatabaseRestorePermitStatus.APPROVED,
				expiresAt: { gt: new Date() }
			},
			orderBy: { approvedAt: 'asc' }
		});
		return permit ? this.serializePermit(permit) : null;
	}

	async createPermit(
		input: {
			target: string;
			sourceSha256: string;
			expectedServicesSha: string;
			backupProvenance: string;
		},
		context: ActorContext
	) {
		this.ensureEnabled();
		await this.closeExpiredPermits();
		const target = this.target(input.target);
		this.sha256(input.sourceSha256, 'source SHA-256');
		const currentServicesSha = this.currentServicesSha();
		if (input.expectedServicesSha !== currentServicesSha) {
			throw new ConflictException(
				'Expected services SHA does not match the running Operations revision'
			);
		}
		const migrationManifestSha = this.manifests.sha256(target);
		const provenance = await this.verifyProvenance(
			input.backupProvenance,
			target,
			input.sourceSha256,
			migrationManifestSha,
			currentServicesSha
		);
		const now = new Date();
		try {
			const permit = await this.prisma.$transaction(async transaction => {
				await this.assertCompletedBackupJob(transaction, provenance);
				const created = await transaction.databaseRestorePermit.create({
					data: {
						id: randomUUID(),
						jobId: randomUUID(),
						target,
						sourceSha256: input.sourceSha256,
						sourceSize: BigInt(provenance.envelope.evidence.fileSize),
						sourceBackupJobId: provenance.envelope.evidence.backupJobId,
						backupProvenance: provenance.serialized,
						backupProvenanceEnvelopeSha256:
							provenance.signed.envelopeSha256,
						backupProvenanceKeyId: provenance.envelope.keyId,
						expectedServicesSha: currentServicesSha,
						migrationManifestSha,
						requestedById: context.actorId,
						expiresAt: new Date(
							now.getTime() + DATABASE_RESTORE_PERMIT_TTL_MS
						)
					}
				});
				await this.audit.recordInTransaction(transaction, {
					adminId: context.actorId,
					section: 'DEV_TOOLS',
					action: 'DEV_DATABASE_RESTORE_PERMIT_REQUESTED',
					description: `DEV запросил one-shot permit восстановления базы ${target}`,
					entityType: 'database_restore_permit',
					entityId: created.id,
					metadata: {
						jobId: created.jobId,
						target,
						sourceSha256: created.sourceSha256,
						sourceSize: created.sourceSize.toString(),
						sourceBackupJobId: created.sourceBackupJobId,
						backupProvenanceEnvelopeSha256:
							created.backupProvenanceEnvelopeSha256,
						backupProvenanceKeyId: created.backupProvenanceKeyId,
						expectedServicesSha: created.expectedServicesSha,
						migrationManifestSha: created.migrationManifestSha,
						expiresAt: created.expiresAt.toISOString()
					},
					ip: context.ip,
					userAgent: context.userAgent
				});
				return created;
			});
			return this.serializePermit(permit);
		} catch (error) {
			if (this.isUniqueConflict(error)) {
				throw new ConflictException(
					'Уже есть глобальный активный one-shot permit восстановления'
				);
			}
			throw error;
		}
	}

	async approvePermit(id: string, context: ActorContext) {
		this.ensureEnabled();
		this.uuid(id, 'permit id');
		await this.closeExpiredPermits();
		return this.prisma.$transaction(async transaction => {
			const permit = await transaction.databaseRestorePermit.findUnique({
				where: { id }
			});
			if (!permit) {
				throw new NotFoundException('One-shot permit не найден');
			}
			if (permit.requestedById === context.actorId) {
				throw new ConflictException(
					'One-shot permit должен подтвердить другой DEV'
				);
			}
			const approvedAt = new Date();
			const changed = await transaction.databaseRestorePermit.updateMany({
				where: {
					id,
					status: DatabaseRestorePermitStatus.PENDING_APPROVAL,
					requestedById: { not: context.actorId },
					expiresAt: { gt: approvedAt }
				},
				data: {
					status: DatabaseRestorePermitStatus.APPROVED,
					approvedById: context.actorId,
					approvedAt
				}
			});
			if (changed.count !== 1) {
				throw new ConflictException(
					'One-shot permit истёк или уже был обработан'
				);
			}
			await this.audit.recordInTransaction(transaction, {
				adminId: context.actorId,
				section: 'DEV_TOOLS',
				action: 'DEV_DATABASE_RESTORE_PERMIT_APPROVED',
				description: `Второй DEV подтвердил one-shot permit восстановления базы ${permit.target}`,
				entityType: 'database_restore_permit',
				entityId: id,
				metadata: {
					jobId: permit.jobId,
					target: permit.target,
					requestedById: permit.requestedById
				},
				ip: context.ip,
				userAgent: context.userAgent
			});
			const approved =
				await transaction.databaseRestorePermit.findUniqueOrThrow({
					where: { id }
				});
			return this.serializePermit(approved);
		});
	}

	async consumePermit(
		transaction: Prisma.TransactionClient,
		input: {
			jobId: string;
			target: DatabaseRestoreTarget;
			sourceSha256: string;
			sourceSize: bigint;
			actorId: string;
		}
	) {
		const permit = await transaction.databaseRestorePermit.findUnique({
			where: { jobId: input.jobId }
		});
		const now = new Date();
		const currentServicesSha = this.currentServicesSha();
		const currentMigrationManifestSha = this.manifests.sha256(
			input.target
		);
		if (
			!permit ||
			permit.target !== input.target ||
			permit.sourceSha256 !== input.sourceSha256 ||
			permit.sourceSize !== input.sourceSize ||
			permit.expectedServicesSha !== currentServicesSha ||
			permit.migrationManifestSha !== currentMigrationManifestSha ||
			permit.requestedById !== input.actorId
		) {
			throw new ConflictException(
				'One-shot permit не соответствует target, source, actor, services SHA или migration manifest'
			);
		}
		const consumed = await transaction.databaseRestorePermit.updateMany({
			where: {
				id: permit.id,
				jobId: input.jobId,
				target: input.target,
				sourceSha256: input.sourceSha256,
				sourceSize: input.sourceSize,
				expectedServicesSha: currentServicesSha,
				migrationManifestSha: currentMigrationManifestSha,
				requestedById: input.actorId,
				status: DatabaseRestorePermitStatus.APPROVED,
				expiresAt: { gt: now },
				consumedAt: null,
				closedAt: null
			},
			data: {
				status: DatabaseRestorePermitStatus.CONSUMED,
				consumedAt: now
			}
		});
		if (consumed.count !== 1) {
			throw new ConflictException(
				'One-shot permit истёк, не подтверждён или уже использован'
			);
		}
		return permit;
	}

	async createRecoveryAction(
		jobId: string,
		action: DatabaseRestoreRecoveryActionType,
		context: ActorContext
	) {
		this.uuid(jobId, 'job id');
		await this.expireRecoveryActions();
		const now = new Date();
		try {
			const recoveryAction = await this.prisma.$transaction(
				async transaction => {
					const job = await transaction.databaseRestoreJob.findUnique({
						where: { id: jobId },
						include: { terminalReceipt: true }
					});
					if (!job) {
						throw new NotFoundException(
							'Задание восстановления не найдено'
						);
					}
					if (
						job.status !== DatabaseRestoreJobStatus.RECOVERY_REQUIRED ||
						!job.terminalReceipt ||
						job.recoveryResolvedAt
					) {
						throw new ConflictException(
							'Recovery action допустим только для RECOVERY_REQUIRED с terminal receipt'
						);
					}
					if (
						action ===
							DatabaseRestoreRecoveryActionType.ROLL_BACK_SAFETY &&
						!job.terminalReceipt.safetyBackupSha256
					) {
						throw new ConflictException(
							'Recovery safety backup не имеет подтверждённого SHA-256'
						);
					}
					const created =
						await transaction.databaseRestoreRecoveryAction.create({
							data: {
								id: randomUUID(),
								jobId,
								action,
								receiptPayloadSha: job.terminalReceipt.payloadSha256,
								requestedById: context.actorId,
								expiresAt: new Date(
									now.getTime() + DATABASE_RESTORE_RECOVERY_ACTION_TTL_MS
								)
							}
						});
					await this.audit.recordInTransaction(transaction, {
						adminId: context.actorId,
						section: 'DEV_TOOLS',
						action: 'DEV_DATABASE_RESTORE_RECOVERY_REQUESTED',
						description: `DEV запросил recovery action ${action} для базы ${job.target}`,
						entityType: 'database_restore_recovery_action',
						entityId: created.id,
						metadata: {
							jobId,
							action,
							receiptPayloadSha: created.receiptPayloadSha,
							expiresAt: created.expiresAt.toISOString()
						},
						ip: context.ip,
						userAgent: context.userAgent
					});
					return created;
				}
			);
			return this.serializeRecoveryAction(recoveryAction);
		} catch (error) {
			if (this.isUniqueConflict(error)) {
				throw new ConflictException(
					'Для задания уже есть активный recovery action'
				);
			}
			throw error;
		}
	}

	async approveRecoveryAction(
		jobId: string,
		actionId: string,
		context: ActorContext
	) {
		this.uuid(jobId, 'job id');
		this.uuid(actionId, 'recovery action id');
		await this.expireRecoveryActions();
		return this.prisma.$transaction(async transaction => {
			const recoveryAction =
				await transaction.databaseRestoreRecoveryAction.findUnique({
					where: { id: actionId },
					include: {
						restoreJob: { include: { terminalReceipt: true } }
					}
				});
			if (!recoveryAction || recoveryAction.jobId !== jobId) {
				throw new NotFoundException('Recovery action не найден');
			}
			if (recoveryAction.requestedById === context.actorId) {
				throw new ConflictException(
					'Recovery action должен подтвердить другой DEV'
				);
			}
			if (
				recoveryAction.restoreJob.status !==
					DatabaseRestoreJobStatus.RECOVERY_REQUIRED ||
				recoveryAction.restoreJob.recoveryResolvedAt ||
				recoveryAction.restoreJob.terminalReceipt?.payloadSha256 !==
					recoveryAction.receiptPayloadSha
			) {
				throw new ConflictException(
					'Recovery evidence изменился или задание больше не требует recovery'
				);
			}
			const currentServicesSha = this.currentServicesSha();
			if (
				recoveryAction.restoreJob.expectedServicesSha !==
				currentServicesSha
			) {
				throw new ConflictException(
					'Recovery action requires the exact Operations services SHA'
				);
			}
			const target = this.target(recoveryAction.restoreJob.target);
			const migrationManifestSha = this.manifests.sha256(target);
			if (
				recoveryAction.restoreJob.migrationManifestSha !==
				migrationManifestSha
			) {
				throw new ConflictException(
					'Recovery action requires the exact trusted migration manifest'
				);
			}
			const approvedAt = new Date();
			const eventId = randomUUID();
			const changed =
				await transaction.databaseRestoreRecoveryAction.updateMany({
					where: {
						id: actionId,
						jobId,
						status: DatabaseRestoreRecoveryActionStatus.PENDING_APPROVAL,
						requestedById: { not: context.actorId },
						expiresAt: { gt: approvedAt }
					},
					data: {
						status: DatabaseRestoreRecoveryActionStatus.APPROVED,
						approvedById: context.actorId,
						approvedAt,
						eventId
					}
				});
			if (changed.count !== 1) {
				throw new ConflictException(
					'Recovery action истёк или уже был обработан'
				);
			}
			await this.outbox.enqueue(transaction, {
				eventId,
				deduplicationKey: `database-restore-recovery:${actionId}:requested`,
				eventType: OPERATIONS_DATABASE_RESTORE_RECOVERY_EVENT_TYPE,
				aggregateType: 'database-restore-recovery',
				aggregateId: actionId,
				correlationId: jobId,
				routingKey: OPERATIONS_DATABASE_RESTORE_ROUTING_KEY,
				payload: {
					schemaVersion: 1,
					eventId,
					actionId,
					jobId,
					target,
					action: recoveryAction.action,
					receiptPayloadSha: recoveryAction.receiptPayloadSha,
					expectedServicesSha: currentServicesSha,
					migrationManifestSha
				}
			});
			await this.audit.recordInTransaction(transaction, {
				adminId: context.actorId,
				section: 'DEV_TOOLS',
				action: 'DEV_DATABASE_RESTORE_RECOVERY_APPROVED',
				description: `Второй DEV подтвердил recovery action ${recoveryAction.action} для базы ${recoveryAction.restoreJob.target}`,
				entityType: 'database_restore_recovery_action',
				entityId: actionId,
				metadata: {
					jobId,
					action: recoveryAction.action,
					requestedById: recoveryAction.requestedById,
					executionAllowed: true,
					executorStatus: DatabaseRestoreRecoveryActionStatus.APPROVED
				},
				ip: context.ip,
				userAgent: context.userAgent
			});
			const approved =
				await transaction.databaseRestoreRecoveryAction.findUniqueOrThrow({
					where: { id: actionId }
				});
			return this.serializeRecoveryAction(approved);
		});
	}

	async closeExpiredPermits(): Promise<void> {
		const now = new Date();
		await this.prisma.databaseRestorePermit.updateMany({
			where: {
				status: {
					in: [
						DatabaseRestorePermitStatus.PENDING_APPROVAL,
						DatabaseRestorePermitStatus.APPROVED
					]
				},
				expiresAt: { lte: now }
			},
			data: {
				status: DatabaseRestorePermitStatus.CLOSED,
				closedAt: now,
				closeReason: 'EXPIRED'
			}
		});
	}

	private async expireRecoveryActions(): Promise<void> {
		await this.prisma.databaseRestoreRecoveryAction.updateMany({
			where: {
				status: {
					in: [
						DatabaseRestoreRecoveryActionStatus.PENDING_APPROVAL,
						DatabaseRestoreRecoveryActionStatus.APPROVED
					]
				},
				expiresAt: { lte: new Date() }
			},
			data: { status: DatabaseRestoreRecoveryActionStatus.EXPIRED }
		});
	}

	private serializePermit(permit: {
		id: string;
		jobId: string;
		target: string;
		sourceSha256: string;
		sourceSize: bigint;
		sourceBackupJobId: string;
		backupProvenanceEnvelopeSha256: string;
		backupProvenanceKeyId: string;
		expectedServicesSha: string;
		migrationManifestSha: string;
		status: DatabaseRestorePermitStatus;
		requestedById: string;
		approvedById: string | null;
		expiresAt: Date;
		consumedAt: Date | null;
		closedAt: Date | null;
	}) {
		return {
			permitId: permit.id,
			jobId: permit.jobId,
			target: permit.target,
			sourceSha256: permit.sourceSha256,
			sourceSize: Number(permit.sourceSize),
			sourceBackupJobId: permit.sourceBackupJobId,
			backupProvenanceEnvelopeSha256:
				permit.backupProvenanceEnvelopeSha256,
			backupProvenanceKeyId: permit.backupProvenanceKeyId,
			expectedServicesSha: permit.expectedServicesSha,
			migrationManifestSha: permit.migrationManifestSha,
			status: permit.status,
			requestedById: permit.requestedById,
			approvedById: permit.approvedById,
			expiresAt: permit.expiresAt.toISOString(),
			consumedAt: permit.consumedAt?.toISOString() ?? null,
			closedAt: permit.closedAt?.toISOString() ?? null
		};
	}

	async verifyStoredProvenance(input: {
		backupProvenance: string;
		target: DatabaseRestoreTarget;
		sourceSha256: string;
		sourceSize: bigint;
		sourceFileName: string;
		migrationManifestSha: string;
		expectedServicesSha: string;
		sourceBackupJobId: string;
		backupProvenanceEnvelopeSha256: string;
		backupProvenanceKeyId: string;
	}): Promise<DatabaseBackupProvenanceEnvelope> {
		const verified = await this.verifyProvenance(
			input.backupProvenance,
			input.target,
			input.sourceSha256,
			input.migrationManifestSha,
			input.expectedServicesSha
		);
		const evidence = verified.envelope.evidence;
		if (
			BigInt(evidence.fileSize) !== input.sourceSize ||
			evidence.fileName !== input.sourceFileName ||
			evidence.backupJobId !== input.sourceBackupJobId ||
			verified.signed.envelopeSha256 !==
				input.backupProvenanceEnvelopeSha256 ||
			verified.envelope.keyId !== input.backupProvenanceKeyId
		) {
			throw new ConflictException(
				'Backup provenance does not match the exact restore artifact'
			);
		}
		return verified.envelope;
	}

	private async verifyProvenance(
		raw: string,
		target: DatabaseRestoreTarget,
		sourceSha256: string,
		migrationManifestSha: string,
		expectedServicesSha: string
	): Promise<VerifiedBackupProvenance> {
		let value: unknown;
		try {
			value = JSON.parse(raw) as unknown;
		} catch {
			throw new BadRequestException('Backup provenance JSON is invalid');
		}
		let envelope: DatabaseBackupProvenanceEnvelope;
		try {
			envelope = await this.provenance.verify(value);
		} catch (error) {
			throw new BadRequestException(
				error instanceof Error
					? error.message
					: 'Backup provenance is invalid'
			);
		}
		if (
			envelope.evidence.target !== target ||
			envelope.evidence.artifactSha256 !== sourceSha256 ||
			envelope.evidence.migrationManifestSha !== migrationManifestSha ||
			envelope.evidence.servicesSha !== expectedServicesSha ||
			envelope.evidence.imageRevision !== expectedServicesSha
		) {
			throw new ConflictException(
				'Backup provenance does not match target, source SHA-256, migration manifest or services revision'
			);
		}
		const signed = value as SignedDatabaseBackupProvenance;
		return { signed, envelope, serialized: JSON.stringify(signed) };
	}

	private async assertCompletedBackupJob(
		transaction: Prisma.TransactionClient,
		verified: VerifiedBackupProvenance
	): Promise<void> {
		const evidence = verified.envelope.evidence;
		const job = await transaction.scheduledJobRun.findUnique({
			where: { id: evidence.backupJobId }
		});
		if (
			!job ||
			job.status !== ScheduledJobRunStatus.SUCCEEDED ||
			job.jobType !== databaseBackupJobType(evidence.target) ||
			!job.finishedAt ||
			job.createdAt.toISOString() !== evidence.backupJobCreatedAt
		) {
			throw new ConflictException(
				'Backup provenance does not reference a completed exact backup job'
			);
		}
		const input = this.exactJsonObject(
			job.input,
			job.trigger === 'MANUAL'
				? [
						'chatId',
						'messageThreadId',
						'requestedByAdminId',
						'schemaVersion',
						'target',
						'trigger'
					]
				: [
						'chatId',
						'messageThreadId',
						'periodStart',
						'schemaVersion',
						'target',
						'trigger'
					],
			'backup job input'
		);
		const result = this.exactJsonObject(
			job.result,
			[
				'backupProvenance',
				'createdAt',
				'databaseName',
				'fileName',
				'fileSha256',
				'fileSize',
				'provenanceTelegramReceipt',
				'schema',
				'target',
				'telegramReceipt',
				'telegramSent'
			],
			'backup job result'
		);
		let storedEnvelope: DatabaseBackupProvenanceEnvelope;
		try {
			storedEnvelope = await this.provenance.verify(
				result.backupProvenance
			);
		} catch {
			throw new ConflictException(
				'Completed backup job contains invalid provenance evidence'
			);
		}
		const storedSigned =
			result.backupProvenance as SignedDatabaseBackupProvenance;
		const artifactTelegramReceipt = result.telegramReceipt as Record<
			string,
			unknown
		>;
		const provenanceTelegramReceipt =
			result.provenanceTelegramReceipt as Record<string, unknown>;
		const artifactCreatedAt = Date.parse(evidence.artifactCreatedAt);
		const resultCreatedAt =
			typeof result.createdAt === 'string'
				? Date.parse(result.createdAt)
				: Number.NaN;
		if (
			input.schemaVersion !== 1 ||
			input.target !== evidence.target ||
			input.trigger !== job.trigger ||
			(job.trigger === 'MANUAL' &&
				(typeof input.requestedByAdminId !== 'string' ||
					!input.requestedByAdminId.trim() ||
					input.requestedByAdminId.length > 255)) ||
			(input.periodStart ?? null) !==
				(job.periodStart?.toISOString() ?? null) ||
			typeof input.chatId !== 'string' ||
			!input.chatId ||
			!Number.isInteger(input.messageThreadId) ||
			Number(input.messageThreadId) < 1 ||
			result.target !== evidence.target ||
			result.databaseName !== evidence.databaseName ||
			result.schema !== evidence.schema ||
			result.fileName !== evidence.fileName ||
			result.fileSize !== evidence.fileSize ||
			result.fileSha256 !== evidence.artifactSha256 ||
			result.telegramSent !== true ||
			!Number.isFinite(resultCreatedAt) ||
			resultCreatedAt > artifactCreatedAt ||
			job.finishedAt.getTime() < artifactCreatedAt ||
			storedEnvelope.keyId !== verified.envelope.keyId ||
			storedSigned.envelopeSha256 !== verified.signed.envelopeSha256 ||
			storedSigned.signatureEd25519Base64 !==
				verified.signed.signatureEd25519Base64 ||
			!this.validTelegramReceipt(
				result.telegramReceipt,
				input.chatId,
				Number(input.messageThreadId)
			) ||
			!this.validTelegramReceipt(
				result.provenanceTelegramReceipt,
				input.chatId,
				Number(input.messageThreadId)
			) ||
			artifactTelegramReceipt.messageId ===
				provenanceTelegramReceipt.messageId ||
			artifactTelegramReceipt.fileId ===
				provenanceTelegramReceipt.fileId ||
			artifactTelegramReceipt.fileUniqueId ===
				provenanceTelegramReceipt.fileUniqueId
		) {
			throw new ConflictException(
				'Completed backup job result does not match signed provenance'
			);
		}
	}

	private exactJsonObject(
		value: unknown,
		expectedKeys: string[],
		label: string,
		optionalKeys: string[] = []
	): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new ConflictException(`${label} is invalid`);
		}
		const actual = Object.keys(value).sort();
		const allowed = new Set([...expectedKeys, ...optionalKeys]);
		if (
			expectedKeys.some(key => !Object.hasOwn(value, key)) ||
			actual.some(key => !allowed.has(key))
		) {
			throw new ConflictException(`${label} contract is invalid`);
		}
		return value as Record<string, unknown>;
	}

	private validTelegramReceipt(
		value: unknown,
		chatId: string,
		messageThreadId: number
	): boolean {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			return false;
		const record = value as Record<string, unknown>;
		if (
			Object.keys(record).sort().join(',') !==
			'chatId,fileId,fileUniqueId,messageId,messageThreadId'
		) {
			return false;
		}
		return (
			Number.isInteger(record.messageId) &&
			Number(record.messageId) > 0 &&
			record.chatId === chatId &&
			record.messageThreadId === messageThreadId &&
			typeof record.fileId === 'string' &&
			record.fileId.length > 0 &&
			record.fileId.length <= 512 &&
			typeof record.fileUniqueId === 'string' &&
			record.fileUniqueId.length > 0 &&
			record.fileUniqueId.length <= 512
		);
	}

	private serializeRecoveryAction(action: {
		id: string;
		jobId: string;
		action: DatabaseRestoreRecoveryActionType;
		status: DatabaseRestoreRecoveryActionStatus;
		receiptPayloadSha: string;
		requestedById: string;
		approvedById: string | null;
		expiresAt: Date;
		phase?: string | null;
		attempts?: number;
		artifactSha256?: string | null;
		lastError?: string | null;
		result?: Prisma.JsonValue | null;
		startedAt?: Date | null;
		finishedAt?: Date | null;
		writerFenceAppliedAt?: Date | null;
		writerFenceReleasedAt?: Date | null;
	}) {
		return {
			actionId: action.id,
			jobId: action.jobId,
			action: action.action,
			status: action.status,
			receiptPayloadSha: action.receiptPayloadSha,
			requestedById: action.requestedById,
			approvedById: action.approvedById,
			expiresAt: action.expiresAt.toISOString(),
			phase: action.phase ?? null,
			attempts: action.attempts ?? 0,
			artifactSha256: action.artifactSha256 ?? null,
			error: action.lastError ?? null,
			result: action.result ?? null,
			startedAt: action.startedAt?.toISOString() ?? null,
			finishedAt: action.finishedAt?.toISOString() ?? null,
			writerFenceAppliedAt:
				action.writerFenceAppliedAt?.toISOString() ?? null,
			writerFenceReleasedAt:
				action.writerFenceReleasedAt?.toISOString() ?? null,
			executionAllowed:
				action.status === DatabaseRestoreRecoveryActionStatus.APPROVED ||
				action.status === DatabaseRestoreRecoveryActionStatus.PROCESSING,
			executorStatus: action.status
		};
	}

	private ensureEnabled(): void {
		if (
			this.config.get<string>('DATABASE_RESTORE_ENABLED')?.trim() !==
			'true'
		) {
			throw new ServiceUnavailableException(
				'Database restore temporarily disabled'
			);
		}
	}

	private currentServicesSha(): string {
		const value = this.config.get<string>('APP_REVISION')?.trim();
		if (!value || !DATABASE_RESTORE_SERVICES_SHA_PATTERN.test(value)) {
			throw new ServiceUnavailableException(
				'Operations must run from an exact 40-character services SHA'
			);
		}
		return value;
	}

	private target(value: string): DatabaseRestoreTarget {
		if (
			!DATABASE_RESTORE_TARGETS.includes(value as DatabaseRestoreTarget)
		) {
			throw new BadRequestException('Некорректная цель восстановления');
		}
		return value as DatabaseRestoreTarget;
	}

	private sha256(value: string, label: string): void {
		if (!DATABASE_RESTORE_SHA256_PATTERN.test(value)) {
			throw new BadRequestException(`Invalid ${label}`);
		}
	}

	private uuid(value: string, label: string): void {
		if (!UUID_PATTERN.test(value)) {
			throw new BadRequestException(`Invalid ${label}`);
		}
	}

	private isUniqueConflict(error: unknown): boolean {
		return (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			(error as { code?: unknown }).code === 'P2002'
		);
	}
}
