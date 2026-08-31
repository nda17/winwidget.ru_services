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
	DatabaseRestoreRecoveryActionStatus,
	OutboxStatus,
	Prisma
} from '@prisma/operations-client';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
	chmod,
	mkdir,
	open,
	realpath,
	rename,
	rm,
	stat
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { AdminEventLogService } from '../admin-event-log/admin-event-log.service';
import {
	OPERATIONS_DATABASE_RESTORE_EVENT_TYPE,
	OPERATIONS_DATABASE_RESTORE_ROUTING_KEY
} from '../messaging/operations-messaging.constants';
import { OperationsOutboxService } from '../messaging/operations-outbox.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import {
	DATABASE_RESTORE_MAX_FILE_SIZE_BYTES,
	DATABASE_RESTORE_SERVICES_SHA_PATTERN,
	DATABASE_RESTORE_SETTINGS,
	DATABASE_RESTORE_TARGETS,
	DatabaseRestoreTarget,
	UploadedRestoreFile
} from './database-restore.contract';
import { DatabaseRestoreCleanupService } from './database-restore-cleanup.service';
import { DatabaseRestoreAuthorizationService } from './database-restore-authorization.service';
import { DatabaseRestoreMigrationManifestService } from './database-restore-migration-manifest.service';
import { DatabaseRestoreStateService } from './database-restore-state.service';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class DatabaseRestoreService {
	constructor(
		private readonly config: ConfigService,
		private readonly prisma: OperationsPrismaService,
		private readonly outbox: OperationsOutboxService,
		private readonly audit: AdminEventLogService,
		private readonly cleanup: DatabaseRestoreCleanupService,
		private readonly authorization: DatabaseRestoreAuthorizationService,
		private readonly state: DatabaseRestoreStateService,
		private readonly manifests: DatabaseRestoreMigrationManifestService
	) {}

	async getSettings() {
		const currentServicesSha = this.currentServicesSha();
		return {
			enabled: this.enabled(),
			currentServicesSha,
			approved: await this.authorization.getApprovedPermit(),
			permitRequired: true,
			maxFileSizeBytes: DATABASE_RESTORE_MAX_FILE_SIZE_BYTES,
			allowedFileExtension: '.dump',
			targets: DATABASE_RESTORE_SETTINGS.map(target => ({
				...target,
				migrationManifestSha: this.manifests.sha256(target.id)
			}))
		};
	}

	isExecutionEnabled(): boolean {
		return this.enabled();
	}

	async getJob(id: string) {
		this.uuid(id, 'job id');
		const job = await this.prisma.databaseRestoreJob.findUnique({
			where: { id },
			include: {
				terminalReceipt: true,
				recoveryResolutionReceipt: true,
				recoveryActions: { orderBy: { createdAt: 'desc' } }
			}
		});
		if (!job)
			throw new NotFoundException('Задание восстановления не найдено');
		return this.serialize(job, await this.publicationStatus(job.eventId));
	}

	async enqueue(input: {
		target: string;
		file: UploadedRestoreFile | undefined;
		confirmation: string;
		requestId: string;
		actorId: string;
		ip: string | null;
		userAgent: string | null;
	}) {
		if (!this.enabled()) {
			throw new ServiceUnavailableException(
				'Database restore temporarily disabled'
			);
		}
		await this.authorization.closeExpiredPermits();
		const target = this.target(input.target);
		const setting = DATABASE_RESTORE_SETTINGS.find(
			item => item.id === target
		)!;
		if (input.confirmation !== setting.confirmation) {
			throw new BadRequestException('Некорректная фраза подтверждения');
		}
		const file = input.file;
		if (
			!file ||
			!Buffer.isBuffer(file.buffer) ||
			file.size !== file.buffer.length ||
			file.size < 5 ||
			file.size > DATABASE_RESTORE_MAX_FILE_SIZE_BYTES ||
			file.buffer.subarray(0, 5).toString('ascii') !== 'PGDMP'
		) {
			throw new BadRequestException(
				'Требуется корректный PostgreSQL custom dump'
			);
		}
		const idempotencyKey = input.requestId;
		this.uuid(idempotencyKey, 'request id');
		const sha256 = createHash('sha256').update(file.buffer).digest('hex');
		const existing = await this.prisma.databaseRestoreJob.findUnique({
			where: { id: idempotencyKey },
			include: {
				terminalReceipt: true,
				recoveryResolutionReceipt: true,
				recoveryActions: { orderBy: { createdAt: 'desc' } }
			}
		});
		if (existing) {
			if (
				existing.target !== target ||
				existing.sourceSha256 !== sha256 ||
				existing.requestedById !== input.actorId
			) {
				throw new ConflictException(
					'Restore request id уже привязан к другому exact restore'
				);
			}
			return this.serialize(
				existing,
				await this.publicationStatus(existing.eventId)
			);
		}
		const jobId = idempotencyKey;
		const path = await this.resolveSourcePath(jobId);
		await this.persistStagingArtifact(path, file.buffer, sha256);
		const eventId = randomUUID();
		try {
			const job = await this.prisma.$transaction(async transaction => {
				const permit = await this.authorization.consumePermit(
					transaction,
					{
						jobId,
						target,
						sourceSha256: sha256,
						sourceSize: BigInt(file.size),
						actorId: input.actorId
					}
				);
				const sourceFileName = this.safeFileName(file.originalname);
				await this.authorization.verifyStoredProvenance({
					backupProvenance: permit.backupProvenance,
					target,
					sourceSha256: sha256,
					sourceSize: BigInt(file.size),
					sourceFileName,
					migrationManifestSha: permit.migrationManifestSha,
					expectedServicesSha: permit.expectedServicesSha,
					sourceBackupJobId: permit.sourceBackupJobId,
					backupProvenanceEnvelopeSha256:
						permit.backupProvenanceEnvelopeSha256,
					backupProvenanceKeyId: permit.backupProvenanceKeyId
				});
				const created = await transaction.databaseRestoreJob.create({
					data: {
						id: jobId,
						target,
						eventId,
						sourceFileName,
						sourceSha256: sha256,
						sourceSize: BigInt(file.size),
						sourceBackupJobId: permit.sourceBackupJobId,
						backupProvenance: permit.backupProvenance,
						backupProvenanceEnvelopeSha256:
							permit.backupProvenanceEnvelopeSha256,
						backupProvenanceKeyId: permit.backupProvenanceKeyId,
						requestedById: input.actorId,
						idempotencyKey,
						permitId: permit.id,
						expectedServicesSha: permit.expectedServicesSha,
						migrationManifestSha: permit.migrationManifestSha
					}
				});
				await this.outbox.enqueue(transaction, {
					eventId,
					deduplicationKey: `database-restore:${jobId}:requested`,
					eventType: OPERATIONS_DATABASE_RESTORE_EVENT_TYPE,
					aggregateType: 'database-restore',
					aggregateId: jobId,
					routingKey: OPERATIONS_DATABASE_RESTORE_ROUTING_KEY,
					payload: {
						schemaVersion: 3,
						eventId,
						jobId,
						target,
						sourceBackupJobId: permit.sourceBackupJobId,
						backupProvenanceEnvelopeSha256:
							permit.backupProvenanceEnvelopeSha256,
						backupProvenanceKeyId: permit.backupProvenanceKeyId,
						expectedServicesSha: permit.expectedServicesSha,
						migrationManifestSha: permit.migrationManifestSha
					}
				});
				await this.audit.recordInTransaction(transaction, {
					adminId: input.actorId,
					section: 'DEV_TOOLS',
					action: 'DEV_DATABASE_RESTORE',
					description: `DEV запросил восстановление базы ${target}`,
					entityType: 'database_restore_job',
					entityId: jobId,
					entityLabel: created.sourceFileName,
					metadata: {
						target,
						fileSize: file.size,
						sha256,
						sourceBackupJobId: permit.sourceBackupJobId,
						backupProvenanceEnvelopeSha256:
							permit.backupProvenanceEnvelopeSha256,
						backupProvenanceKeyId: permit.backupProvenanceKeyId
					},
					ip: input.ip,
					userAgent: input.userAgent
				});
				return created;
			});
			return this.serialize(job, OutboxStatus.PENDING);
		} catch (error) {
			let committed: Awaited<
				ReturnType<typeof this.prisma.databaseRestoreJob.findUnique>
			> | null = null;
			try {
				committed = await this.prisma.databaseRestoreJob.findUnique({
					where: { id: jobId },
					include: {
						terminalReceipt: true,
						recoveryResolutionReceipt: true,
						recoveryActions: { orderBy: { createdAt: 'desc' } }
					}
				});
			} catch {
				// The transaction outcome is unknown. Keep the exact source artifact:
				// deleting it could strand an already committed durable job.
			}
			if (committed) {
				if (
					committed.target === target &&
					committed.sourceSha256 === sha256 &&
					committed.requestedById === input.actorId
				) {
					return this.serialize(committed, OutboxStatus.PENDING);
				}
				throw new ConflictException(
					'Restore request id уже привязан к другому exact restore'
				);
			}
			// Once the PostgreSQL transaction was entered, a negative read-back
			// cannot prove rollback: the original backend may still commit. Keep the
			// UUID artifact for the DB-aware aged orphan sweep.
			if (this.isUniqueConflict(error)) {
				throw new ConflictException(
					'Для этой базы уже есть активное или требующее восстановления задание'
				);
			}
			throw error;
		}
	}

	async cancel(
		id: string,
		actorId: string,
		context: { ip: string | null; userAgent: string | null }
	) {
		this.uuid(id, 'job id');
		const job = await this.prisma.$transaction(async transaction => {
			const current = await transaction.databaseRestoreJob.findUnique({
				where: { id }
			});
			if (!current)
				throw new NotFoundException('Задание восстановления не найдено');
			if (current.status !== DatabaseRestoreJobStatus.QUEUED) {
				throw new ConflictException('Задание уже нельзя отменить');
			}
			const changed = await transaction.databaseRestoreJob.updateMany({
				where: { id, status: DatabaseRestoreJobStatus.QUEUED },
				data: {
					status: DatabaseRestoreJobStatus.CANCELLED,
					finishedAt: new Date()
				}
			});
			if (changed.count !== 1)
				throw new ConflictException('Задание уже запущено');
			await this.state.createTerminalReceiptInTransaction(transaction, id);
			await this.audit.recordInTransaction(transaction, {
				adminId: actorId,
				section: 'DEV_TOOLS',
				action: 'DEV_DATABASE_RESTORE',
				description: `DEV отменил восстановление базы ${current.target}`,
				entityType: 'database_restore_job',
				entityId: id,
				metadata: { cancellationRequested: true },
				ip: context.ip,
				userAgent: context.userAgent
			});
			return transaction.databaseRestoreJob.findUniqueOrThrow({
				where: { id }
			});
		});
		try {
			await this.cleanup.cleanup({
				id,
				status: DatabaseRestoreJobStatus.CANCELLED,
				phase: job.phase,
				source: await this.resolveSourcePath(id)
			});
		} catch (error) {
			await this.cleanup.recordError(
				id,
				DatabaseRestoreJobStatus.CANCELLED,
				error
			);
		}
		return this.serialize(job, await this.publicationStatus(job.eventId));
	}

	async resolveSourcePath(id: string): Promise<string> {
		this.uuid(id, 'job id');
		return join(await this.stagingDirectory(), `${id}.dump`);
	}

	async resolveSealedSourcePath(id: string): Promise<string> {
		this.uuid(id, 'job id');
		return join(await this.sealedDirectory(), `${id}.dump`);
	}

	async sealSourceArtifact(
		id: string,
		expectedSha256: string,
		expectedSize: bigint
	): Promise<{ stagingPath: string; sealedPath: string }> {
		this.uuid(id, 'job id');
		const stagingPath = await this.resolveSourcePath(id);
		const sealedPath = await this.resolveSealedSourcePath(id);
		const stagingDirectory = await realpath(dirname(stagingPath));
		const sealedDirectory = await realpath(dirname(sealedPath));
		const [stagingDirectoryState, sealedDirectoryState] =
			await Promise.all([
				stat(dirname(stagingPath)),
				stat(dirname(sealedPath))
			]);
		if (
			stagingDirectoryState.dev === sealedDirectoryState.dev &&
			stagingDirectoryState.ino === sealedDirectoryState.ino
		) {
			throw new Error(
				'Restore staging and sealed paths must not share filesystem directory identity'
			);
		}
		if (this.directoriesOverlap(stagingDirectory, sealedDirectory)) {
			throw new Error(
				'Restore staging and sealed directories must be distinct non-nested paths'
			);
		}
		if (
			await this.matchesArtifact(
				sealedPath,
				expectedSha256,
				Number(expectedSize)
			)
		) {
			return { stagingPath, sealedPath };
		}
		const temporaryPath = `${sealedPath}.${randomUUID()}.tmp`;
		let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
		let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
		let sealedPublishedByThisCall = false;
		try {
			sourceHandle = await open(
				stagingPath,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
			);
			const sourceState = await sourceHandle.stat();
			if (
				!sourceState.isFile() ||
				sourceState.size !== Number(expectedSize) ||
				sourceState.size < 5 ||
				sourceState.size > DATABASE_RESTORE_MAX_FILE_SIZE_BYTES
			) {
				throw new Error(
					'Restore staging artifact size or type is invalid'
				);
			}
			destinationHandle = await open(
				temporaryPath,
				constants.O_CREAT |
					constants.O_EXCL |
					constants.O_WRONLY |
					constants.O_NOFOLLOW,
				0o600
			);
			const hash = createHash('sha256');
			const buffer = Buffer.allocUnsafe(64 * 1024);
			let position = 0;
			while (position < sourceState.size) {
				const { bytesRead } = await sourceHandle.read(
					buffer,
					0,
					Math.min(buffer.length, sourceState.size - position),
					position
				);
				if (bytesRead === 0) break;
				hash.update(buffer.subarray(0, bytesRead));
				let written = 0;
				while (written < bytesRead) {
					const result = await destinationHandle.write(
						buffer,
						written,
						bytesRead - written,
						position + written
					);
					written += result.bytesWritten;
				}
				position += bytesRead;
			}
			if (
				position !== sourceState.size ||
				hash.digest('hex') !== expectedSha256
			) {
				throw new Error(
					'Sealed restore artifact SHA-256 does not match the job'
				);
			}
			await destinationHandle.sync();
			await destinationHandle.close();
			destinationHandle = undefined;
			await sourceHandle.close();
			sourceHandle = undefined;
			await rename(temporaryPath, sealedPath);
			sealedPublishedByThisCall = true;
			await this.syncParentDirectory(sealedPath);
			if (
				!(await this.matchesArtifact(
					sealedPath,
					expectedSha256,
					Number(expectedSize)
				))
			) {
				throw new Error(
					'Sealed restore artifact changed after atomic publish'
				);
			}
			return { stagingPath, sealedPath };
		} catch (error) {
			await destinationHandle?.close();
			await sourceHandle?.close();
			await this.removeFailedSealArtifact(temporaryPath);
			if (sealedPublishedByThisCall) {
				await this.removeFailedSealArtifact(sealedPath);
			}
			throw error;
		}
	}

	private async removeFailedSealArtifact(path: string): Promise<void> {
		try {
			await rm(path, { force: true });
			await this.syncParentDirectory(path);
		} catch {
			// The DB-aware orphan sweep retries durable cleanup after 24 hours.
		}
	}

	private async stagingDirectory(): Promise<string> {
		return this.storageDirectory('DATABASE_RESTORE_STAGING_DIR');
	}

	private async sealedDirectory(): Promise<string> {
		return this.storageDirectory('DATABASE_RESTORE_SEALED_DIR');
	}

	private async storageDirectory(key: string): Promise<string> {
		const value = this.config.get<string>(key)?.trim();
		if (!value || !isAbsolute(value) || value === '/') {
			throw new ServiceUnavailableException(`${key} is not configured`);
		}
		await mkdir(value, { recursive: true, mode: 0o700 });
		await chmod(value, 0o700);
		return value;
	}

	private async matchesArtifact(
		path: string,
		expectedSha256: string,
		expectedSize?: number
	): Promise<boolean> {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(
				path,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
			);
			const state = await handle.stat();
			if (
				!state.isFile() ||
				(expectedSize !== undefined && state.size !== expectedSize)
			) {
				return false;
			}
			const hash = createHash('sha256');
			for await (const chunk of handle.createReadStream({
				autoClose: false
			})) {
				hash.update(chunk as Buffer);
			}
			return hash.digest('hex') === expectedSha256;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
			throw error;
		} finally {
			await handle?.close();
		}
	}

	private async persistStagingArtifact(
		path: string,
		buffer: Buffer,
		expectedSha256: string
	): Promise<void> {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		let created = false;
		try {
			handle = await open(
				path,
				constants.O_CREAT |
					constants.O_EXCL |
					constants.O_WRONLY |
					constants.O_NOFOLLOW,
				0o600
			);
			created = true;
			await handle.writeFile(buffer);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await this.syncParentDirectory(path);
			return;
		} catch (error) {
			await handle?.close();
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				if (created) {
					await rm(path, { force: true });
					await this.syncParentDirectory(path);
				}
				throw error;
			}
		}
		let existing: Awaited<ReturnType<typeof open>> | undefined;
		try {
			existing = await open(
				path,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
			);
			const state = await existing.stat();
			if (!state.isFile() || state.size !== buffer.length) {
				throw new ConflictException(
					'Restore staging artifact уже существует с другим размером'
				);
			}
			const hash = createHash('sha256');
			for await (const chunk of existing.createReadStream({
				autoClose: false
			})) {
				hash.update(chunk as Buffer);
			}
			if (hash.digest('hex') !== expectedSha256) {
				throw new ConflictException(
					'Restore staging artifact уже существует с другим SHA-256'
				);
			}
			await this.syncParentDirectory(path);
		} finally {
			await existing?.close();
		}
	}

	private async syncParentDirectory(path: string): Promise<void> {
		const handle = await open(dirname(path), 'r');
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	private directoriesOverlap(first: string, second: string): boolean {
		const isWithin = (base: string, candidate: string) => {
			const path = relative(base, candidate);
			return (
				path === '' ||
				(path !== '..' &&
					!path.startsWith(`..${sep}`) &&
					!isAbsolute(path))
			);
		};
		return isWithin(first, second) || isWithin(second, first);
	}

	private enabled(): boolean {
		return (
			this.config.get<string>('DATABASE_RESTORE_ENABLED')?.trim() ===
			'true'
		);
	}

	private target(value: string): DatabaseRestoreTarget {
		if (
			!DATABASE_RESTORE_TARGETS.includes(value as DatabaseRestoreTarget)
		) {
			throw new BadRequestException('Некорректная цель восстановления');
		}
		return value as DatabaseRestoreTarget;
	}

	private uuid(value: string, label: string): void {
		if (!UUID_PATTERN.test(value))
			throw new BadRequestException(`Invalid ${label}`);
	}

	private safeFileName(value: string): string {
		const normalized = value
			.replace(/[\u0000-\u001f\u007f/\\]/g, '_')
			.trim();
		return (normalized || 'database.dump').slice(0, 255);
	}

	private isUniqueConflict(error: unknown): boolean {
		return (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			(error as { code?: unknown }).code === 'P2002'
		);
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

	private async publicationStatus(
		eventId: string
	): Promise<OutboxStatus | null> {
		const event = await this.prisma.outboxEvent.findUnique({
			where: { eventId },
			select: { status: true }
		});
		return event?.status ?? null;
	}

	private serialize(
		job: {
			id: string;
			target: string;
			status: DatabaseRestoreJobStatus;
			attempts: number;
			sourceFileName: string;
			sourceSha256: string;
			sourceSize: bigint;
			sourceBackupJobId: string;
			backupProvenanceEnvelopeSha256: string;
			backupProvenanceKeyId: string;
			result: Prisma.JsonValue | null;
			lastError: string | null;
			startedAt: Date | null;
			finishedAt: Date | null;
			createdAt: Date;
			eventId: string;
			expectedServicesSha: string;
			migrationManifestSha: string;
			recoveryResolvedAt?: Date | null;
			artifactRetainUntil?: Date | null;
			terminalReceipt?: {
				terminalStatus: DatabaseRestoreJobStatus;
				permitId: string;
				permitRequestedById: string;
				permitApprovedById: string;
				permitCreatedAt: Date;
				permitApprovedAt: Date;
				permitExpiresAt: Date;
				permitConsumedAt: Date;
				phase: string | null;
				sourceSha256: string;
				sourceSize: bigint;
				sourceBackupJobId: string;
				backupProvenanceEnvelopeSha256: string;
				backupProvenanceKeyId: string;
				safetyBackupSha256: string | null;
				expectedServicesSha: string;
				migrationManifestSha: string;
				resultSha256: string | null;
				errorSha256: string | null;
				payloadSha256: string;
				signatureHmacSha256: string;
				signatureKeyId: string;
				completedAt: Date;
				writerFenceRoles: Prisma.JsonValue | null;
				writerFenceRequestedAt: Date | null;
				writerFenceAppliedAt: Date | null;
				writerFenceReleasedAt: Date | null;
				writerFenceEvidenceSha256: string | null;
				writerFenceReleaseEvidenceSha256: string | null;
			} | null;
			recoveryActions?: Array<{
				id: string;
				action: string;
				status: string;
				receiptPayloadSha: string;
				requestedById: string;
				approvedById: string | null;
				expiresAt: Date;
				phase: string | null;
				attempts: number;
				artifactSha256: string | null;
				lastError: string | null;
				result: Prisma.JsonValue | null;
				startedAt: Date | null;
				finishedAt: Date | null;
				writerFenceAppliedAt: Date | null;
				writerFenceReleasedAt: Date | null;
			}>;
			recoveryResolutionReceipt?: {
				actionId: string;
				action: string;
				initialReceiptPayloadSha: string;
				artifactSha256: string | null;
				expectedServicesSha: string;
				migrationManifestSha: string;
				writerFenceRoles: Prisma.JsonValue;
				writerFenceAppliedAt: Date;
				writerFenceReleasedAt: Date;
				writerFenceEvidenceSha256: string;
				writerFenceReleaseEvidenceSha256: string;
				resultSha256: string;
				payloadSha256: string;
				signatureHmacSha256: string;
				signatureKeyId: string;
				resolvedAt: Date;
			} | null;
		},
		publicationStatus: OutboxStatus | null
	) {
		return {
			jobId: job.id,
			target: job.target,
			status: job.status,
			originalFileName: job.sourceFileName,
			fileSize: Number(job.sourceSize),
			sha256: job.sourceSha256,
			sourceBackupJobId: job.sourceBackupJobId,
			backupProvenanceEnvelopeSha256: job.backupProvenanceEnvelopeSha256,
			backupProvenanceKeyId: job.backupProvenanceKeyId,
			requestedAt: job.createdAt.toISOString(),
			startedAt: job.startedAt?.toISOString() ?? null,
			finishedAt: job.finishedAt?.toISOString() ?? null,
			attempt: job.attempts,
			error: job.lastError
				? {
						code:
							job.status === DatabaseRestoreJobStatus.RECOVERY_REQUIRED
								? 'RESTORE_RECOVERY_REQUIRED'
								: 'RESTORE_FAILED',
						message: job.lastError
					}
				: null,
			result: job.result,
			expectedServicesSha: job.expectedServicesSha,
			migrationManifestSha: job.migrationManifestSha,
			recoveryResolvedAt: job.recoveryResolvedAt?.toISOString() ?? null,
			artifactRetainUntil: job.artifactRetainUntil?.toISOString() ?? null,
			terminalReceipt: job.terminalReceipt
				? {
						terminalStatus: job.terminalReceipt.terminalStatus,
						permitId: job.terminalReceipt.permitId,
						permitRequestedById: job.terminalReceipt.permitRequestedById,
						permitApprovedById: job.terminalReceipt.permitApprovedById,
						permitCreatedAt:
							job.terminalReceipt.permitCreatedAt.toISOString(),
						permitApprovedAt:
							job.terminalReceipt.permitApprovedAt.toISOString(),
						permitExpiresAt:
							job.terminalReceipt.permitExpiresAt.toISOString(),
						permitConsumedAt:
							job.terminalReceipt.permitConsumedAt.toISOString(),
						phase: job.terminalReceipt.phase,
						sourceSha256: job.terminalReceipt.sourceSha256,
						sourceSize: Number(job.terminalReceipt.sourceSize),
						sourceBackupJobId: job.terminalReceipt.sourceBackupJobId,
						backupProvenanceEnvelopeSha256:
							job.terminalReceipt.backupProvenanceEnvelopeSha256,
						backupProvenanceKeyId:
							job.terminalReceipt.backupProvenanceKeyId,
						safetyBackupSha256: job.terminalReceipt.safetyBackupSha256,
						expectedServicesSha: job.terminalReceipt.expectedServicesSha,
						migrationManifestSha: job.terminalReceipt.migrationManifestSha,
						resultSha256: job.terminalReceipt.resultSha256,
						errorSha256: job.terminalReceipt.errorSha256,
						payloadSha256: job.terminalReceipt.payloadSha256,
						signatureHmacSha256: job.terminalReceipt.signatureHmacSha256,
						signatureKeyId: job.terminalReceipt.signatureKeyId,
						completedAt: job.terminalReceipt.completedAt.toISOString(),
						writerFenceRoles: job.terminalReceipt.writerFenceRoles,
						writerFenceRequestedAt:
							job.terminalReceipt.writerFenceRequestedAt?.toISOString() ??
							null,
						writerFenceAppliedAt:
							job.terminalReceipt.writerFenceAppliedAt?.toISOString() ??
							null,
						writerFenceReleasedAt:
							job.terminalReceipt.writerFenceReleasedAt?.toISOString() ??
							null,
						writerFenceEvidenceSha256:
							job.terminalReceipt.writerFenceEvidenceSha256,
						writerFenceReleaseEvidenceSha256:
							job.terminalReceipt.writerFenceReleaseEvidenceSha256
					}
				: null,
			recoveryActions: (job.recoveryActions ?? []).map(action => ({
				actionId: action.id,
				action: action.action,
				status: action.status,
				receiptPayloadSha: action.receiptPayloadSha,
				requestedById: action.requestedById,
				approvedById: action.approvedById,
				expiresAt: action.expiresAt.toISOString(),
				phase: action.phase,
				attempts: action.attempts,
				artifactSha256: action.artifactSha256,
				error: action.lastError,
				result: action.result,
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
			})),
			recoveryResolutionReceipt: job.recoveryResolutionReceipt
				? {
						actionId: job.recoveryResolutionReceipt.actionId,
						action: job.recoveryResolutionReceipt.action,
						initialReceiptPayloadSha:
							job.recoveryResolutionReceipt.initialReceiptPayloadSha,
						artifactSha256: job.recoveryResolutionReceipt.artifactSha256,
						expectedServicesSha:
							job.recoveryResolutionReceipt.expectedServicesSha,
						migrationManifestSha:
							job.recoveryResolutionReceipt.migrationManifestSha,
						writerFenceRoles:
							job.recoveryResolutionReceipt.writerFenceRoles,
						writerFenceAppliedAt:
							job.recoveryResolutionReceipt.writerFenceAppliedAt.toISOString(),
						writerFenceReleasedAt:
							job.recoveryResolutionReceipt.writerFenceReleasedAt.toISOString(),
						writerFenceEvidenceSha256:
							job.recoveryResolutionReceipt.writerFenceEvidenceSha256,
						writerFenceReleaseEvidenceSha256:
							job.recoveryResolutionReceipt
								.writerFenceReleaseEvidenceSha256,
						resultSha256: job.recoveryResolutionReceipt.resultSha256,
						payloadSha256: job.recoveryResolutionReceipt.payloadSha256,
						signatureHmacSha256:
							job.recoveryResolutionReceipt.signatureHmacSha256,
						signatureKeyId: job.recoveryResolutionReceipt.signatureKeyId,
						resolvedAt:
							job.recoveryResolutionReceipt.resolvedAt.toISOString()
					}
				: null,
			canCancel: job.status === DatabaseRestoreJobStatus.QUEUED,
			cancellationPending: false,
			cancellationRequested:
				job.status === DatabaseRestoreJobStatus.CANCELLED,
			publicationStatus,
			publicationConfirmed: publicationStatus === OutboxStatus.PUBLISHED
		};
	}
}
