import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { Prisma } from '@prisma/identity-client';
import { safeError } from '../common/identity.util';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { IdentityRuntimeService } from './identity-runtime.service';
import { IdentityOwnershipService } from './identity-ownership.service';

const BATCH_SIZE = 1_000;

export type IdentityHousekeepingResult = {
	publishedOutbox: number;
	deliveredReceipts: number;
	resolvedFailures: number;
	expiredChallenges: number;
	expiredOAuth: number;
	expiredSessions: number;
	telegramReceipts: number;
	staleHeartbeats: number;
	deliveredAvatarCleanupJobs: number;
};

@Injectable()
export class IdentityHousekeepingService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(IdentityHousekeepingService.name);
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private ready = false;
	private stopping = false;

	constructor(
		private readonly prisma: IdentityPrismaService,
		private readonly runtime: IdentityRuntimeService,
		private readonly ownership: IdentityOwnershipService
	) {}

	onModuleInit(): void {
		if (!this.runtime.workerEnabled) return;
		void this.tick();
	}

	isReady(): boolean {
		return !this.runtime.workerEnabled || this.ready;
	}

	onApplicationShutdown(): void {
		this.stopping = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.ready = false;
	}

	async runOnce(now = new Date()): Promise<IdentityHousekeepingResult> {
		const outboxBefore = daysBefore(now, this.runtime.outboxRetentionDays);
		const receiptBefore = daysBefore(
			now,
			this.runtime.receiptRetentionDays
		);
		const failureBefore = daysBefore(
			now,
			this.runtime.failureRetentionDays
		);
		const heartbeatBefore = new Date(now.getTime() - 24 * 60 * 60_000);
		const avatarCleanupBefore = daysBefore(
			now,
			this.runtime.avatarCleanupRetentionDays
		);
		const values = await this.prisma.$transaction([
			this.prisma.$executeRaw(Prisma.sql`
				WITH victims AS (
					SELECT "id" FROM "identity"."outbox_events"
					WHERE "status" = 'PUBLISHED'::"identity"."OutboxStatus"
						AND "published_at" < ${outboxBefore}
					ORDER BY "published_at", "id" LIMIT ${BATCH_SIZE}
				)
				DELETE FROM "identity"."outbox_events" target
				USING victims WHERE target."id" = victims."id"
			`),
			this.prisma.$executeRaw(Prisma.sql`
				WITH victims AS (
					SELECT "id" FROM "identity"."consumer_receipts"
					WHERE "status" = 'DELIVERED'::"identity"."ConsumerReceiptStatus"
						AND "delivered_at" < ${receiptBefore}
					ORDER BY "delivered_at", "id" LIMIT ${BATCH_SIZE}
				)
				DELETE FROM "identity"."consumer_receipts" target
				USING victims WHERE target."id" = victims."id"
			`),
			this.prisma.$executeRaw(Prisma.sql`
				WITH victims AS (
					SELECT "id" FROM "identity"."consumer_failures"
					WHERE "status" IN (
						'RESOLVED'::"identity"."ConsumerFailureStatus",
						'CLOSED_NO_RETRY'::"identity"."ConsumerFailureStatus"
					) AND "resolved_at" < ${failureBefore}
					ORDER BY "resolved_at", "id" LIMIT ${BATCH_SIZE}
				)
				DELETE FROM "identity"."consumer_failures" target
				USING victims WHERE target."id" = victims."id"
			`),
			this.prisma.$executeRaw(Prisma.sql`
				WITH victims AS (
					SELECT "id" FROM "identity"."verification_challenges"
					WHERE "expires_at" < ${now}
					ORDER BY "expires_at", "id" LIMIT ${BATCH_SIZE}
				)
				DELETE FROM "identity"."verification_challenges" target
				USING victims WHERE target."id" = victims."id"
			`),
			this.prisma.$executeRaw(Prisma.sql`
				WITH victims AS (
					SELECT "state_hash" FROM "identity"."oauth_authorizations"
					WHERE "expires_at" < ${now}
					ORDER BY "expires_at", "state_hash" LIMIT ${BATCH_SIZE}
				)
				DELETE FROM "identity"."oauth_authorizations" target
				USING victims WHERE target."state_hash" = victims."state_hash"
			`),
			this.prisma.$executeRaw(Prisma.sql`
				WITH victims AS (
					SELECT "id" FROM "identity"."user_sessions"
					WHERE "expires_at" < ${now}
					ORDER BY "expires_at", "id" LIMIT ${BATCH_SIZE}
				)
				DELETE FROM "identity"."user_sessions" target
				USING victims WHERE target."id" = victims."id"
			`),
			this.prisma.$executeRaw(Prisma.sql`
				WITH victims AS (
					SELECT "bot_kind", "update_id"
					FROM "identity"."telegram_update_receipts"
					WHERE "status" IN (
						'DELIVERED'::"identity"."WebhookReceiptStatus",
						'FAILED'::"identity"."WebhookReceiptStatus"
					) AND "updated_at" < ${receiptBefore}
					ORDER BY "updated_at", "bot_kind", "update_id" LIMIT ${BATCH_SIZE}
				)
				DELETE FROM "identity"."telegram_update_receipts" target
				USING victims
				WHERE target."bot_kind" = victims."bot_kind"
					AND target."update_id" = victims."update_id"
			`),
			this.prisma.$executeRaw(Prisma.sql`
				WITH victims AS (
					SELECT "id" FROM "identity"."heartbeats"
					WHERE "last_seen_at" < ${heartbeatBefore}
					ORDER BY "last_seen_at", "id" LIMIT ${BATCH_SIZE}
				)
				DELETE FROM "identity"."heartbeats" target
				USING victims WHERE target."id" = victims."id"
			`),
			this.prisma.$executeRaw(Prisma.sql`
				WITH victims AS (
					SELECT "id" FROM "identity"."avatar_cleanup_jobs"
					WHERE "status" = 'DELIVERED'::"identity"."AvatarCleanupStatus"
						AND "delivered_at" < ${avatarCleanupBefore}
					ORDER BY "delivered_at", "id" LIMIT ${BATCH_SIZE}
				)
				DELETE FROM "identity"."avatar_cleanup_jobs" target
				USING victims WHERE target."id" = victims."id"
			`)
		]);
		return {
			publishedOutbox: values[0],
			deliveredReceipts: values[1],
			resolvedFailures: values[2],
			expiredChallenges: values[3],
			expiredOAuth: values[4],
			expiredSessions: values[5],
			telegramReceipts: values[6],
			staleHeartbeats: values[7],
			deliveredAvatarCleanupJobs: values[8]
		};
	}

	private async tick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			if (!(await this.ownership.isActive())) {
				this.ready = false;
				return;
			}
			await this.runOnce();
			this.ready = true;
		} catch (error) {
			this.ready = false;
			this.logger.error(
				`Identity housekeeping failed: ${safeError(error)}`
			);
		} finally {
			this.running = false;
			if (this.runtime.workerEnabled && !this.stopping && !this.timer) {
				this.timer = setTimeout(
					() => {
						this.timer = null;
						void this.tick();
					},
					this.ready ? this.runtime.housekeepingIntervalMs : 1_000
				);
				this.timer.unref();
			}
		}
	}
}

function daysBefore(now: Date, days: number): Date {
	return new Date(now.getTime() - days * 24 * 60 * 60_000);
}
