import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import {
	AvatarCleanupKind,
	AvatarCleanupStatus,
	Prisma
} from '@prisma/identity-client';
import { randomUUID } from 'node:crypto';
import { safeError } from '../common/identity.util';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { IdentityOwnershipService } from '../runtime/identity-ownership.service';
import { IdentityRuntimeService } from '../runtime/identity-runtime.service';
import {
	AvatarStorageService,
	UnsafeAvatarObjectKeyError,
	UnsafeAvatarObjectVersionStateError
} from './avatar-storage.service';

type ClaimedAvatarCleanupJob = {
	id: string;
	objectKey: string;
	ownerFingerprint: string;
	kind: AvatarCleanupKind;
	attempts: number;
	leaseToken: string;
};

const MAX_RETRY_DELAY_MS = 60 * 60_000;

@Injectable()
export class AvatarCleanupWorkerService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(AvatarCleanupWorkerService.name);
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private ready = false;
	private stopping = false;
	private lastTickAt: Date | null = null;
	private degradedStatus: AvatarCleanupStatus | null = null;

	constructor(
		private readonly prisma: IdentityPrismaService,
		private readonly runtime: IdentityRuntimeService,
		private readonly ownership: IdentityOwnershipService,
		private readonly storage: AvatarStorageService
	) {}

	onModuleInit(): void {
		if (!this.runtime.workerEnabled) return;
		void this.tick();
	}

	isReady(): boolean {
		return !this.runtime.workerEnabled || this.ready;
	}

	health() {
		return {
			ready: this.isReady(),
			lastTickAt: this.lastTickAt?.toISOString() || null,
			degradedStatus: this.degradedStatus
		};
	}

	onApplicationShutdown(): void {
		this.stopping = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.ready = false;
	}

	async runOnce(now = new Date()): Promise<number> {
		const jobs = await this.claim(now);
		await Promise.all(jobs.map(job => this.process(job, now)));
		return jobs.length;
	}

	private async tick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			if (!(await this.ownership.isActive())) {
				this.ready = false;
				this.degradedStatus = null;
				return;
			}
			await this.runOnce();
			const unresolvedFailure =
				await this.prisma.avatarCleanupJob.findFirst({
					where: {
						status: {
							in: [
								AvatarCleanupStatus.PENDING,
								AvatarCleanupStatus.PROCESSING,
								AvatarCleanupStatus.BLOCKED
							]
						},
						lastError: { not: null }
					},
					orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
					select: { status: true }
				});
			this.degradedStatus = unresolvedFailure?.status || null;
			this.ready = !unresolvedFailure;
			this.lastTickAt = new Date();
		} catch (error) {
			this.ready = false;
			this.lastTickAt = new Date();
			this.logger.error(`Avatar cleanup tick failed: ${safeError(error)}`);
		} finally {
			this.running = false;
			if (this.runtime.workerEnabled && !this.stopping && !this.timer) {
				this.timer = setTimeout(
					() => {
						this.timer = null;
						void this.tick();
					},
					this.ready ? this.runtime.avatarCleanupPollIntervalMs : 1_000
				);
				this.timer.unref();
			}
		}
	}

	private claim(now: Date): Promise<ClaimedAvatarCleanupJob[]> {
		const leaseToken = randomUUID();
		const leaseExpiresAt = new Date(
			now.getTime() + this.runtime.avatarCleanupLeaseMs
		);
		return this.prisma.$queryRaw<ClaimedAvatarCleanupJob[]>(Prisma.sql`
			WITH candidates AS (
				SELECT "id"
				FROM "identity"."avatar_cleanup_jobs"
				WHERE (
					"status" = 'PENDING'::"identity"."AvatarCleanupStatus"
					AND "available_at" <= ${now}
				) OR (
					"status" = 'PROCESSING'::"identity"."AvatarCleanupStatus"
					AND "lease_expires_at" <= ${now}
				)
				ORDER BY "available_at", "created_at", "id"
				FOR UPDATE SKIP LOCKED
				LIMIT ${this.runtime.avatarCleanupBatchSize}
			)
			UPDATE "identity"."avatar_cleanup_jobs" target
			SET "status" = 'PROCESSING'::"identity"."AvatarCleanupStatus",
				"lease_token" = ${leaseToken}::uuid,
				"lease_expires_at" = ${leaseExpiresAt},
				"attempts" = target."attempts" + 1,
				"updated_at" = ${now}
			FROM candidates
			WHERE target."id" = candidates."id"
			RETURNING target."id",
				target."object_key" AS "objectKey",
				target."owner_fingerprint" AS "ownerFingerprint",
				target."kind",
				target."attempts",
				target."lease_token" AS "leaseToken"
		`);
	}

	private async process(
		job: ClaimedAvatarCleanupJob,
		now: Date
	): Promise<void> {
		try {
			const references = await this.prisma.user.count({
				where: { avatarObjectKey: job.objectKey }
			});
			if (references > 0) {
				await this.renewLease(job);
				await this.block(
					job,
					'Avatar cleanup key is still referenced by an Identity user',
					now
				);
				return;
			}
			await this.storage.delete(job.objectKey, job.ownerFingerprint, () =>
				this.renewLease(job)
			);
			const delivered = await this.prisma.avatarCleanupJob.updateMany({
				where: {
					id: job.id,
					status: AvatarCleanupStatus.PROCESSING,
					leaseToken: job.leaseToken
				},
				data: {
					status: AvatarCleanupStatus.DELIVERED,
					deliveredAt: new Date(),
					leaseToken: null,
					leaseExpiresAt: null,
					lastError: null
				}
			});
			if (delivered.count !== 1) {
				this.logger.warn(
					`Avatar cleanup lease changed before delivery job=${job.id}`
				);
			}
		} catch (error) {
			if (error instanceof AvatarCleanupLeaseLostError) {
				this.logger.warn(`Avatar cleanup lease was lost job=${job.id}`);
				return;
			}
			if (
				error instanceof UnsafeAvatarObjectKeyError ||
				error instanceof UnsafeAvatarObjectVersionStateError
			) {
				try {
					await this.renewLease(job);
				} catch (leaseError) {
					if (leaseError instanceof AvatarCleanupLeaseLostError) {
						this.logger.warn(
							`Avatar cleanup lease was lost before blocking job=${job.id}`
						);
						return;
					}
					throw leaseError;
				}
				await this.block(job, error.message, now);
				return;
			}
			const retryAt = new Date(now.getTime() + retryDelay(job.attempts));
			const retried = await this.prisma.avatarCleanupJob.updateMany({
				where: {
					id: job.id,
					status: AvatarCleanupStatus.PROCESSING,
					leaseToken: job.leaseToken
				},
				data: {
					status: AvatarCleanupStatus.PENDING,
					availableAt: retryAt,
					leaseToken: null,
					leaseExpiresAt: null,
					lastError: safeError(error)
				}
			});
			if (retried.count === 1) {
				this.logger.warn(
					`Avatar cleanup retry scheduled job=${job.id} attempt=${job.attempts}`
				);
			} else {
				this.logger.warn(
					`Avatar cleanup lease changed before retry job=${job.id}`
				);
			}
		}
	}

	private async renewLease(job: ClaimedAvatarCleanupJob): Promise<void> {
		const renewedAt = new Date();
		const renewed = await this.prisma.avatarCleanupJob.updateMany({
			where: {
				id: job.id,
				status: AvatarCleanupStatus.PROCESSING,
				leaseToken: job.leaseToken,
				leaseExpiresAt: { gt: renewedAt }
			},
			data: {
				leaseExpiresAt: new Date(
					renewedAt.getTime() + this.runtime.avatarCleanupLeaseMs
				),
				updatedAt: renewedAt
			}
		});
		if (renewed.count !== 1) {
			throw new AvatarCleanupLeaseLostError();
		}
	}

	private async block(
		job: ClaimedAvatarCleanupJob,
		message: string,
		now: Date
	): Promise<void> {
		const blocked = await this.prisma.avatarCleanupJob.updateMany({
			where: {
				id: job.id,
				status: AvatarCleanupStatus.PROCESSING,
				leaseToken: job.leaseToken
			},
			data: {
				status: AvatarCleanupStatus.BLOCKED,
				leaseToken: null,
				leaseExpiresAt: null,
				lastError: message,
				updatedAt: now
			}
		});
		if (blocked.count === 1) {
			this.logger.error(`Avatar cleanup blocked job=${job.id}`);
		} else {
			this.logger.warn(
				`Avatar cleanup lease changed before blocking job=${job.id}`
			);
		}
	}
}

class AvatarCleanupLeaseLostError extends Error {
	constructor() {
		super('Avatar cleanup lease was lost');
		this.name = 'AvatarCleanupLeaseLostError';
	}
}

export function retryDelay(attempt: number): number {
	const exponent = Math.max(0, Math.min(attempt - 1, 10));
	return Math.min(MAX_RETRY_DELAY_MS, 5_000 * 2 ** exponent);
}
