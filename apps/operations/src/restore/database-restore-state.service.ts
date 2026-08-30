import { Injectable } from '@nestjs/common';
import {
	DatabaseRestoreJobPhase,
	DatabaseRestoreJobStatus,
	OperationalAlertSeverity,
	Prisma
} from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import {
	OperationalAlertService,
	RecordOperationalAlertInput
} from '../monitoring/operational-alert.service';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { DatabaseRestoreTarget } from './database-restore.contract';
import { DatabaseRestoreCheckpoint } from './database-restore-executor.service';

const RESTORE_LEASE_MS = 60_000;

export interface DatabaseRestoreEventIdentity {
	eventId: string;
	jobId: string;
	target: DatabaseRestoreTarget;
}

export interface DatabaseRestoreLease {
	event: DatabaseRestoreEventIdentity;
	leaseToken: string;
	leaseExpiresAt: Date;
	phase: DatabaseRestoreJobPhase;
}

export type DatabaseRestoreClaim =
	| { state: 'claimed'; lease: DatabaseRestoreLease }
	| { state: 'busy' }
	| { state: 'unclaimed' };

export type DatabaseRestoreObservation =
	| { state: 'missing' | 'mismatched' }
	| { state: 'queued' }
	| {
			state: 'processing';
			job: ExpirableRestoreJob;
	  }
	| { state: 'terminal'; status: DatabaseRestoreJobStatus };

export interface RecoveredDatabaseRestoreJob {
	id: string;
	target: string;
	status: DatabaseRestoreJobStatus;
	phase: DatabaseRestoreJobPhase | null;
}

export interface ExpirableRestoreJob {
	id: string;
	target: string;
	status: DatabaseRestoreJobStatus;
	phase: DatabaseRestoreJobPhase | null;
	leaseToken: string | null;
	leaseExpiresAt: Date | null;
}

@Injectable()
export class DatabaseRestoreStateService {
	private readonly instanceId = randomUUID();

	constructor(
		private readonly prisma: OperationsPrismaService,
		private readonly alerts: OperationalAlertService
	) {}

	async claim(
		event: DatabaseRestoreEventIdentity
	): Promise<DatabaseRestoreClaim> {
		const leaseToken = randomUUID();
		const leaseExpiresAt = this.nextLeaseExpiry();
		try {
			const claimed = await this.prisma.databaseRestoreJob.updateMany({
				where: {
					id: event.jobId,
					target: event.target,
					eventId: event.eventId,
					status: DatabaseRestoreJobStatus.QUEUED
				},
				data: {
					status: DatabaseRestoreJobStatus.PROCESSING,
					phase: DatabaseRestoreJobPhase.PREPARING,
					leaseOwner: this.instanceId,
					leaseToken,
					leaseExpiresAt,
					attempts: { increment: 1 },
					startedAt: new Date(),
					finishedAt: null,
					lastError: null
				}
			});
			return claimed.count === 1
				? {
						state: 'claimed',
						lease: {
							event,
							leaseToken,
							leaseExpiresAt,
							phase: DatabaseRestoreJobPhase.PREPARING
						}
					}
				: { state: 'unclaimed' };
		} catch (error) {
			if (this.isUniqueConflict(error)) return { state: 'busy' };
			throw error;
		}
	}

	async loadClaimedJob(lease: DatabaseRestoreLease): Promise<{
		id: string;
		sourceSha256: string;
	}> {
		return this.prisma.databaseRestoreJob.findFirstOrThrow({
			where: {
				id: lease.event.jobId,
				target: lease.event.target,
				eventId: lease.event.eventId,
				status: DatabaseRestoreJobStatus.PROCESSING,
				leaseToken: lease.leaseToken
			},
			select: { id: true, sourceSha256: true }
		});
	}

	async renew(lease: DatabaseRestoreLease): Promise<boolean> {
		const leaseExpiresAt = this.nextLeaseExpiry();
		const renewed = await this.prisma.databaseRestoreJob.updateMany({
			where: {
				id: lease.event.jobId,
				target: lease.event.target,
				eventId: lease.event.eventId,
				status: DatabaseRestoreJobStatus.PROCESSING,
				leaseToken: lease.leaseToken,
				leaseExpiresAt: { gt: new Date() }
			},
			data: { leaseExpiresAt }
		});
		if (renewed.count !== 1) return false;
		lease.leaseExpiresAt = leaseExpiresAt;
		return true;
	}

	async checkpoint(
		lease: DatabaseRestoreLease,
		checkpoint: DatabaseRestoreCheckpoint
	): Promise<void> {
		const nextPhase = this.checkpointPhase(checkpoint);
		const expectedPhase =
			nextPhase === DatabaseRestoreJobPhase.SAFETY_READY
				? DatabaseRestoreJobPhase.PREPARING
				: nextPhase === DatabaseRestoreJobPhase.MUTATING
					? DatabaseRestoreJobPhase.SAFETY_READY
					: DatabaseRestoreJobPhase.MUTATING;
		if (lease.phase !== expectedPhase) {
			throw new Error('Database restore checkpoint order is invalid');
		}
		const leaseExpiresAt = this.nextLeaseExpiry();
		const changed = await this.prisma.databaseRestoreJob.updateMany({
			where: {
				id: lease.event.jobId,
				target: lease.event.target,
				eventId: lease.event.eventId,
				status: DatabaseRestoreJobStatus.PROCESSING,
				phase: expectedPhase,
				leaseToken: lease.leaseToken,
				leaseExpiresAt: { gt: new Date() }
			},
			data: {
				phase: nextPhase,
				leaseExpiresAt,
				...(checkpoint.phase === 'SAFETY_READY'
					? {
							safetyBackupFileName: checkpoint.safetyBackupFileName,
							safetyBackupSha256: checkpoint.safetyBackupSha256
						}
					: {})
			}
		});
		if (changed.count !== 1) {
			throw new Error(
				`Database restore ${checkpoint.phase} checkpoint could not be persisted`
			);
		}
		lease.phase = nextPhase;
		lease.leaseExpiresAt = leaseExpiresAt;
	}

	async succeed(
		lease: DatabaseRestoreLease,
		result: Prisma.InputJsonValue
	): Promise<boolean> {
		return this.prisma.$transaction(async transaction => {
			const succeeded = await transaction.databaseRestoreJob.updateMany({
				where: {
					id: lease.event.jobId,
					target: lease.event.target,
					eventId: lease.event.eventId,
					status: DatabaseRestoreJobStatus.PROCESSING,
					phase: DatabaseRestoreJobPhase.VERIFIED,
					leaseToken: lease.leaseToken,
					leaseExpiresAt: { gt: new Date() }
				},
				data: {
					status: DatabaseRestoreJobStatus.SUCCEEDED,
					result,
					lastError: null,
					finishedAt: new Date(),
					leaseOwner: null,
					leaseToken: null,
					leaseExpiresAt: null
				}
			});
			if (succeeded.count !== 1) return false;
			await this.alerts.resolveInTransaction(
				transaction,
				`database-restore:${lease.event.target}`
			);
			return true;
		});
	}

	async fail(
		lease: DatabaseRestoreLease,
		error: unknown
	): Promise<DatabaseRestoreJobStatus | null> {
		const status = this.requiresRecovery(lease.phase)
			? DatabaseRestoreJobStatus.RECOVERY_REQUIRED
			: DatabaseRestoreJobStatus.FAILED;
		const lastError = this.safeError(error);
		return this.prisma.$transaction(async transaction => {
			const failed = await transaction.databaseRestoreJob.updateMany({
				where: {
					id: lease.event.jobId,
					target: lease.event.target,
					eventId: lease.event.eventId,
					status: DatabaseRestoreJobStatus.PROCESSING,
					phase: lease.phase,
					leaseToken: lease.leaseToken,
					leaseExpiresAt: { gt: new Date() }
				},
				data: {
					status,
					lastError,
					finishedAt: new Date(),
					leaseOwner: null,
					leaseToken: null,
					leaseExpiresAt: null
				}
			});
			if (failed.count !== 1) return null;
			await this.alerts.recordInTransaction(
				transaction,
				this.failureAlert(
					lease.event.jobId,
					lease.event.target,
					status === DatabaseRestoreJobStatus.RECOVERY_REQUIRED
						? 'DEV database restore требует ручного восстановления из safety backup'
						: 'DEV database restore завершился до изменения целевой базы'
				)
			);
			return status;
		});
	}

	async failQueuedWithoutSource(
		event: DatabaseRestoreEventIdentity,
		error: unknown
	): Promise<boolean> {
		const failedAt = new Date();
		const lastError = this.safeError(error);
		return this.prisma.$transaction(async transaction => {
			const failed = await transaction.databaseRestoreJob.updateMany({
				where: {
					id: event.jobId,
					target: event.target,
					eventId: event.eventId,
					status: DatabaseRestoreJobStatus.QUEUED
				},
				data: {
					status: DatabaseRestoreJobStatus.FAILED,
					phase: DatabaseRestoreJobPhase.PREPARING,
					attempts: { increment: 1 },
					lastError,
					startedAt: failedAt,
					finishedAt: failedAt
				}
			});
			if (failed.count !== 1) return false;
			await this.alerts.recordInTransaction(
				transaction,
				this.failureAlert(
					event.jobId,
					event.target,
					'DEV database restore не запущен: не удалось подготовить путь к исходному dump'
				)
			);
			return true;
		});
	}

	async observe(
		event: DatabaseRestoreEventIdentity
	): Promise<DatabaseRestoreObservation> {
		const job = await this.prisma.databaseRestoreJob.findUnique({
			where: { id: event.jobId },
			select: {
				id: true,
				target: true,
				eventId: true,
				status: true,
				phase: true,
				leaseToken: true,
				leaseExpiresAt: true
			}
		});
		if (!job) return { state: 'missing' };
		if (job.target !== event.target || job.eventId !== event.eventId) {
			return { state: 'mismatched' };
		}
		if (job.status === DatabaseRestoreJobStatus.QUEUED) {
			return { state: 'queued' };
		}
		if (job.status === DatabaseRestoreJobStatus.PROCESSING) {
			return { state: 'processing', job };
		}
		return { state: 'terminal', status: job.status };
	}

	async findFence(
		target: DatabaseRestoreTarget
	): Promise<ExpirableRestoreJob | null> {
		return this.prisma.databaseRestoreJob.findFirst({
			where: {
				OR: [
					{ status: DatabaseRestoreJobStatus.PROCESSING },
					{
						status: DatabaseRestoreJobStatus.RECOVERY_REQUIRED,
						target
					}
				]
			},
			orderBy: { updatedAt: 'asc' },
			select: {
				id: true,
				target: true,
				status: true,
				phase: true,
				leaseToken: true,
				leaseExpiresAt: true
			}
		});
	}

	async findExpired(limit: number): Promise<ExpirableRestoreJob[]> {
		return this.prisma.databaseRestoreJob.findMany({
			where: {
				status: DatabaseRestoreJobStatus.PROCESSING,
				leaseExpiresAt: { lte: new Date() }
			},
			orderBy: { updatedAt: 'asc' },
			take: limit,
			select: {
				id: true,
				target: true,
				status: true,
				phase: true,
				leaseToken: true,
				leaseExpiresAt: true
			}
		});
	}

	async recoverExpiredJob(
		job: ExpirableRestoreJob
	): Promise<RecoveredDatabaseRestoreJob | null> {
		if (
			job.status !== DatabaseRestoreJobStatus.PROCESSING ||
			!job.leaseToken ||
			!job.leaseExpiresAt
		) {
			return null;
		}
		const status = this.requiresRecovery(job.phase)
			? DatabaseRestoreJobStatus.RECOVERY_REQUIRED
			: DatabaseRestoreJobStatus.FAILED;
		const lastError =
			status === DatabaseRestoreJobStatus.RECOVERY_REQUIRED
				? 'Restore worker lease expired after target mutation; manual recovery from safety backup is required'
				: 'Restore worker lease expired before target mutation';
		return this.prisma.$transaction(async transaction => {
			const changed = await transaction.databaseRestoreJob.updateMany({
				where: {
					id: job.id,
					status: DatabaseRestoreJobStatus.PROCESSING,
					phase: job.phase,
					leaseToken: job.leaseToken,
					leaseExpiresAt: { lte: new Date() }
				},
				data: {
					status,
					lastError,
					finishedAt: new Date(),
					leaseOwner: null,
					leaseToken: null,
					leaseExpiresAt: null
				}
			});
			if (changed.count !== 1) return null;
			await this.alerts.recordInTransaction(
				transaction,
				this.failureAlert(
					job.id,
					job.target,
					status === DatabaseRestoreJobStatus.RECOVERY_REQUIRED
						? 'Истёк lease после начала изменения базы; требуется ручное восстановление из safety backup'
						: 'Истёк lease до начала изменения базы; задание завершено безопасной ошибкой'
				)
			);
			return { id: job.id, target: job.target, status, phase: job.phase };
		});
	}

	private checkpointPhase(
		checkpoint: DatabaseRestoreCheckpoint
	): DatabaseRestoreJobPhase {
		switch (checkpoint.phase) {
			case 'SAFETY_READY':
				return DatabaseRestoreJobPhase.SAFETY_READY;
			case 'MUTATING':
				return DatabaseRestoreJobPhase.MUTATING;
			case 'VERIFIED':
				return DatabaseRestoreJobPhase.VERIFIED;
		}
	}

	private requiresRecovery(
		phase: DatabaseRestoreJobPhase | null
	): boolean {
		return (
			phase === null ||
			phase === DatabaseRestoreJobPhase.MUTATING ||
			phase === DatabaseRestoreJobPhase.VERIFIED
		);
	}

	private failureAlert(
		jobId: string,
		target: string,
		message: string
	): RecordOperationalAlertInput {
		return {
			deduplicationKey: `database-restore:${target}`,
			type: 'INTEGRATION_PROBLEM',
			severity: OperationalAlertSeverity.HIGH,
			source: 'operations',
			referenceId: jobId,
			title: `Не восстановлена база ${target}`,
			message
		};
	}

	private nextLeaseExpiry(): Date {
		return new Date(Date.now() + RESTORE_LEASE_MS);
	}

	private isUniqueConflict(error: unknown): boolean {
		return (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			(error as { code?: unknown }).code === 'P2002'
		);
	}

	private safeError(error: unknown): string {
		return (error instanceof Error ? error.message : String(error))
			.replace(/[\r\n]+/g, ' ')
			.slice(0, 2_000);
	}
}
