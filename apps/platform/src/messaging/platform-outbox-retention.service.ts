import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { Prisma } from '@prisma/platform-client';
import { PlatformPrismaService } from '../prisma/platform-prisma.service';
import { PlatformRuntimeService } from '../runtime/platform-runtime.service';

const DAY_MS = 24 * 60 * 60_000;
const CLEANUP_INTERVAL_MS = 60 * 60_000;
const CLEANUP_BATCH_SIZE = 1_000;
const SHUTDOWN_TIMEOUT_MS = 20_000;

export async function deletePublishedPlatformOutbox(
	prisma: PlatformPrismaService,
	retentionDays: number,
	now = new Date()
): Promise<number> {
	if (
		!Number.isSafeInteger(retentionDays) ||
		retentionDays < 1 ||
		retentionDays > 365
	) {
		throw new Error(
			'PLATFORM_OUTBOX_RETENTION_DAYS must be an integer between 1 and 365'
		);
	}
	if (Number.isNaN(now.getTime())) {
		throw new Error('Platform Outbox retention time must be valid');
	}
	const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
	return prisma.$executeRaw(Prisma.sql`
		WITH expired AS (
			SELECT "id"
			FROM "platform"."outbox_events"
			WHERE "status" = 'PUBLISHED'::"platform"."OutboxStatus"
				AND "published_at" < ${cutoff}
			ORDER BY "published_at" ASC, "id" ASC
			LIMIT ${CLEANUP_BATCH_SIZE}
			FOR UPDATE SKIP LOCKED
		)
		DELETE FROM "platform"."outbox_events" AS event
		USING expired
		WHERE event."id" = expired."id"
	`);
}

@Injectable()
export class PlatformOutboxRetentionService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(
		PlatformOutboxRetentionService.name
	);
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;
	private stopping = false;

	constructor(
		private readonly prisma: PlatformPrismaService,
		private readonly runtime: PlatformRuntimeService
	) {}

	onModuleInit(): void {
		if (!this.runtime.outboxPublisherEnabled) return;
		void this.scheduleCleanup();
		this.timer = setInterval(
			() => void this.scheduleCleanup(),
			CLEANUP_INTERVAL_MS
		);
		this.timer.unref();
	}

	async beforeApplicationShutdown(): Promise<void> {
		this.stopping = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		if (!this.running) return;
		await Promise.race([
			this.running,
			new Promise<void>(resolve =>
				setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref()
			)
		]);
	}

	private async scheduleCleanup(): Promise<void> {
		if (
			this.stopping ||
			this.running ||
			!this.runtime.outboxPublisherEnabled
		) {
			return;
		}
		this.running = this.cleanup();
		try {
			await this.running;
		} finally {
			this.running = null;
		}
	}

	private async cleanup(): Promise<void> {
		try {
			const deleted = await deletePublishedPlatformOutbox(
				this.prisma,
				this.runtime.outboxRetentionDays
			);
			if (deleted > 0) {
				this.logger.log(`Platform Outbox retention deleted=${deleted}`);
			}
		} catch (error) {
			this.logger.error(
				`Platform Outbox retention cleanup failed: ${this.safeError(error)}`
			);
		}
	}

	private safeError(error: unknown): string {
		if (error instanceof Prisma.PrismaClientKnownRequestError) {
			return `PrismaClientKnownRequestError:${error.code}`;
		}
		return error instanceof Error &&
			/^[A-Za-z0-9_.-]{1,80}$/.test(error.name)
			? error.name
			: 'UnknownError';
	}
}
