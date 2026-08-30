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
	Prisma
} from '@prisma/operations-client';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { AdminEventLogService } from '../admin-event-log/admin-event-log.service';
import {
	OPERATIONS_DATABASE_RESTORE_EVENT_TYPE,
	OPERATIONS_DATABASE_RESTORE_ROUTING_KEY
} from '../messaging/operations-messaging.constants';
import { OperationsOutboxService } from '../messaging/operations-outbox.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import {
	DATABASE_RESTORE_MAX_FILE_SIZE_BYTES,
	DATABASE_RESTORE_SETTINGS,
	DATABASE_RESTORE_TARGETS,
	DatabaseRestoreTarget,
	UploadedRestoreFile
} from './database-restore.contract';
import { DatabaseRestoreCleanupService } from './database-restore-cleanup.service';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class DatabaseRestoreService {
	constructor(
		private readonly config: ConfigService,
		private readonly prisma: OperationsPrismaService,
		private readonly outbox: OperationsOutboxService,
		private readonly audit: AdminEventLogService,
		private readonly cleanup: DatabaseRestoreCleanupService
	) {}

	getSettings() {
		return {
			enabled: this.enabled(),
			approved: null,
			maxFileSizeBytes: DATABASE_RESTORE_MAX_FILE_SIZE_BYTES,
			allowedFileExtension: '.dump',
			targets: DATABASE_RESTORE_SETTINGS
		};
	}

	async getJob(id: string) {
		this.uuid(id, 'job id');
		const job = await this.prisma.databaseRestoreJob.findUnique({
			where: { id }
		});
		if (!job)
			throw new NotFoundException('Задание восстановления не найдено');
		return this.serialize(job);
	}

	async enqueue(input: {
		target: string;
		file: UploadedRestoreFile | undefined;
		confirmation: string;
		requestId?: string;
		actorId: string;
		ip: string | null;
		userAgent: string | null;
	}) {
		if (!this.enabled()) {
			throw new ServiceUnavailableException(
				'Database restore temporarily disabled'
			);
		}
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
		const idempotencyKey = input.requestId ?? randomUUID();
		this.uuid(idempotencyKey, 'request id');
		const existing = await this.prisma.databaseRestoreJob.findUnique({
			where: {
				requestedById_idempotencyKey: {
					requestedById: input.actorId,
					idempotencyKey
				}
			}
		});
		if (existing) return this.serialize(existing);
		const jobId = idempotencyKey;
		const path = await this.resolveSourcePath(jobId);
		const handle = await open(path, 'wx', 0o600);
		try {
			await handle.writeFile(file.buffer);
			await handle.sync();
		} finally {
			await handle.close();
		}
		const sha256 = createHash('sha256').update(file.buffer).digest('hex');
		const eventId = randomUUID();
		try {
			const job = await this.prisma.$transaction(async transaction => {
				const created = await transaction.databaseRestoreJob.create({
					data: {
						id: jobId,
						target,
						eventId,
						sourceFileName: this.safeFileName(file.originalname),
						sourceSha256: sha256,
						sourceSize: BigInt(file.size),
						requestedById: input.actorId,
						idempotencyKey
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
						schemaVersion: 1,
						eventId,
						jobId,
						target
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
						sha256
					},
					ip: input.ip,
					userAgent: input.userAgent
				});
				return created;
			});
			return this.serialize(job);
		} catch (error) {
			await rm(path, { force: true });
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
		return this.serialize(job);
	}

	async resolveSourcePath(id: string): Promise<string> {
		this.uuid(id, 'job id');
		return join(await this.storageDirectory(), `${id}.dump`);
	}

	private async storageDirectory(): Promise<string> {
		const value = this.config
			.get<string>('DATABASE_RESTORE_STORAGE_DIR')
			?.trim();
		if (!value || !isAbsolute(value) || value === '/') {
			throw new ServiceUnavailableException(
				'Restore storage is not configured'
			);
		}
		await mkdir(value, { recursive: true, mode: 0o700 });
		return value;
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

	private serialize(job: {
		id: string;
		target: string;
		status: DatabaseRestoreJobStatus;
		attempts: number;
		sourceFileName: string;
		sourceSha256: string;
		sourceSize: bigint;
		result: Prisma.JsonValue | null;
		lastError: string | null;
		startedAt: Date | null;
		finishedAt: Date | null;
		createdAt: Date;
	}) {
		return {
			jobId: job.id,
			target: job.target,
			status: job.status,
			originalFileName: job.sourceFileName,
			fileSize: Number(job.sourceSize),
			sha256: job.sourceSha256,
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
			canCancel: job.status === DatabaseRestoreJobStatus.QUEUED,
			cancellationPending: false,
			cancellationRequested:
				job.status === DatabaseRestoreJobStatus.CANCELLED,
			publicationConfirmed: true
		};
	}
}
