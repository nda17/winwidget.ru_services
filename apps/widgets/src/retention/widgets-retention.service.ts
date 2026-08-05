import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/widgets-client';
import { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import { WidgetsRuntimeService } from '../runtime/widgets-runtime.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CLEANUP_STALE_AFTER_MS = 3 * CLEANUP_INTERVAL_MS;
const CLEANUP_BATCH_SIZE = 1000;
const CLEANUP_MAX_BATCHES = 20;
const SHUTDOWN_TIMEOUT_MS = 20_000;
const OUTBOX_RETENTION_MAX_DAYS = 365;
const RECEIPT_RETENTION_MAX_DAYS = 730;
const FAILURE_RETENTION_MAX_DAYS = 365;

export const WIDGETS_REDACTED_FAILURE_DETAIL =
	'[redacted after retention]';

export interface WidgetsRetentionConfig {
	outboxDays: number;
	receiptDays: number;
	failureDetailDays: number;
}

export interface WidgetsRetentionResult {
	publishedOutboxDeleted: number;
	credentialSnapshotsDeleted: number;
	integrationReceiptsCompacted: number;
	consumerReceiptsCompacted: number;
	integrationFailureDetailsRedacted: number;
	consumerFailureDetailsRedacted: number;
}

export interface WidgetsRetentionCleanupInput extends WidgetsRetentionConfig {
	cleanupOutbox: boolean;
	cleanupWorkerState: boolean;
	now?: Date;
	batchSize?: number;
	maxBatches?: number;
}

const emptyResult = (): WidgetsRetentionResult => ({
	publishedOutboxDeleted: 0,
	credentialSnapshotsDeleted: 0,
	integrationReceiptsCompacted: 0,
	consumerReceiptsCompacted: 0,
	integrationFailureDetailsRedacted: 0,
	consumerFailureDetailsRedacted: 0
});

export function parseWidgetsRetentionConfig(
	config: ConfigService
): WidgetsRetentionConfig {
	return {
		outboxDays: retentionDays(
			config,
			'WIDGETS_OUTBOX_RETENTION_DAYS',
			7,
			OUTBOX_RETENTION_MAX_DAYS
		),
		receiptDays: retentionDays(
			config,
			'WIDGETS_RECEIPT_RETENTION_DAYS',
			90,
			RECEIPT_RETENTION_MAX_DAYS
		),
		failureDetailDays: retentionDays(
			config,
			'WIDGETS_FAILURE_DETAIL_RETENTION_DAYS',
			30,
			FAILURE_RETENTION_MAX_DAYS
		)
	};
}

export async function runWidgetsRetentionCleanup(
	prisma: WidgetsPrismaService,
	input: WidgetsRetentionCleanupInput
): Promise<WidgetsRetentionResult> {
	assertRetentionConfig(input);
	const now = input.now || new Date();
	if (Number.isNaN(now.getTime())) {
		throw new Error('Widgets retention cleanup time must be valid');
	}
	const batchSize = input.batchSize ?? CLEANUP_BATCH_SIZE;
	const maxBatches = input.maxBatches ?? CLEANUP_MAX_BATCHES;
	assertCleanupBounds(batchSize, maxBatches);
	const result = emptyResult();

	if (input.cleanupOutbox) {
		const cutoff = new Date(now.getTime() - input.outboxDays * DAY_MS);
		result.publishedOutboxDeleted = await executeBatches(
			maxBatches,
			batchSize,
			() =>
				prisma.$executeRaw(
					Prisma.sql`
						WITH expired AS (
							SELECT "id"
							FROM "widgets"."outbox_events"
							WHERE "status" = 'PUBLISHED'::"widgets"."WidgetsOutboxStatus"
								AND "published_at" < ${cutoff}
							ORDER BY "published_at" ASC, "id" ASC
							LIMIT ${batchSize}
							FOR UPDATE SKIP LOCKED
						)
						DELETE FROM "widgets"."outbox_events" AS event
						USING expired
						WHERE event."id" = expired."id"
					`
				)
		);
	}

	if (!input.cleanupWorkerState) return result;

	const receiptCutoff = new Date(
		now.getTime() - input.receiptDays * DAY_MS
	);
	const deliveredSnapshotsDeleted = await executeBatches(
		maxBatches,
		batchSize,
		() =>
			prisma.$executeRaw(
				Prisma.sql`
					WITH expired AS (
						SELECT snapshot."id"
						FROM "widgets"."integration_credential_snapshots" AS snapshot
						JOIN "widgets"."integration_delivery_receipts" AS receipt
							ON receipt."event_id" = snapshot."event_id"
							AND receipt."integration" = snapshot."integration"
						WHERE receipt."status" = 'DELIVERED'::"widgets"."IntegrationDeliveryReceiptStatus"
							AND receipt."delivered_at" < ${receiptCutoff}
							AND NOT EXISTS (
								SELECT 1
								FROM "widgets"."integration_delivery_failures" AS failure
								WHERE failure."event_id" = receipt."event_id"
									AND failure."integration" = receipt."integration"
									AND failure."resolved_at" IS NULL
							)
						ORDER BY receipt."delivered_at" ASC, snapshot."id" ASC
						LIMIT ${batchSize}
						FOR UPDATE OF snapshot SKIP LOCKED
					)
					DELETE FROM "widgets"."integration_credential_snapshots" AS snapshot
					USING expired
					WHERE snapshot."id" = expired."id"
				`
			)
	);
	const closedSnapshotsDeleted = await executeBatches(
		maxBatches,
		batchSize,
		() =>
			prisma.$executeRaw(
				Prisma.sql`
					WITH expired AS (
						SELECT snapshot."id"
						FROM "widgets"."integration_credential_snapshots" AS snapshot
						JOIN "widgets"."integration_delivery_receipts" AS receipt
							ON receipt."event_id" = snapshot."event_id"
							AND receipt."integration" = snapshot."integration"
						WHERE receipt."status" = 'CLOSED_NO_RETRY'::"widgets"."IntegrationDeliveryReceiptStatus"
							AND receipt."updated_at" < ${receiptCutoff}
							AND NOT EXISTS (
								SELECT 1
								FROM "widgets"."integration_delivery_failures" AS failure
								WHERE failure."event_id" = receipt."event_id"
									AND failure."integration" = receipt."integration"
									AND failure."resolved_at" IS NULL
							)
						ORDER BY receipt."updated_at" ASC, snapshot."id" ASC
						LIMIT ${batchSize}
						FOR UPDATE OF snapshot SKIP LOCKED
					)
					DELETE FROM "widgets"."integration_credential_snapshots" AS snapshot
					USING expired
					WHERE snapshot."id" = expired."id"
				`
			)
	);
	result.credentialSnapshotsDeleted =
		deliveredSnapshotsDeleted + closedSnapshotsDeleted;
	result.integrationReceiptsCompacted = await executeBatches(
		maxBatches,
		batchSize,
		() =>
			prisma.$executeRaw(
				Prisma.sql`
					WITH expired AS (
						SELECT receipt."id"
						FROM "widgets"."integration_delivery_receipts" AS receipt
						WHERE receipt."details_purged_at" IS NULL
							AND (
								(
									receipt."status" = 'DELIVERED'::"widgets"."IntegrationDeliveryReceiptStatus"
									AND receipt."delivered_at" < ${receiptCutoff}
								)
								OR (
									receipt."status" = 'CLOSED_NO_RETRY'::"widgets"."IntegrationDeliveryReceiptStatus"
									AND receipt."updated_at" < ${receiptCutoff}
								)
							)
							AND receipt."locked_at" IS NULL
							AND receipt."lock_token" IS NULL
							AND receipt."lease_expires_at" IS NULL
							AND NOT EXISTS (
								SELECT 1
								FROM "widgets"."integration_delivery_failures" AS failure
								WHERE failure."event_id" = receipt."event_id"
									AND failure."integration" = receipt."integration"
									AND failure."resolved_at" IS NULL
							)
						ORDER BY COALESCE(receipt."delivered_at", receipt."updated_at") ASC,
							receipt."id" ASC
						LIMIT ${batchSize}
						FOR UPDATE OF receipt SKIP LOCKED
					)
					UPDATE "widgets"."integration_delivery_receipts" AS receipt
					SET
						"last_error" = NULL,
						"details_purged_at" = ${now}
					FROM expired
					WHERE receipt."id" = expired."id"
				`
			)
	);
	result.consumerReceiptsCompacted = await executeBatches(
		maxBatches,
		batchSize,
		() =>
			prisma.$executeRaw(
				Prisma.sql`
					WITH expired AS (
						SELECT receipt."id"
						FROM "widgets"."consumer_receipts" AS receipt
						WHERE receipt."status" = 'DELIVERED'::"widgets"."WidgetsConsumerReceiptStatus"
							AND receipt."delivered_at" < ${receiptCutoff}
							AND receipt."details_purged_at" IS NULL
							AND receipt."locked_at" IS NULL
							AND receipt."lock_token" IS NULL
							AND receipt."lease_expires_at" IS NULL
							AND NOT EXISTS (
								SELECT 1
								FROM "widgets"."consumer_failures" AS failure
								WHERE failure."event_id" = receipt."event_id"
									AND failure."consumer" = receipt."consumer"
									AND failure."status" <> 'RESOLVED'::"widgets"."WidgetsConsumerFailureStatus"
							)
						ORDER BY receipt."delivered_at" ASC, receipt."id" ASC
						LIMIT ${batchSize}
						FOR UPDATE OF receipt SKIP LOCKED
					)
					UPDATE "widgets"."consumer_receipts" AS receipt
					SET
						"last_error" = NULL,
						"details_purged_at" = ${now}
					FROM expired
					WHERE receipt."id" = expired."id"
				`
			)
	);

	const failureCutoff = new Date(
		now.getTime() - input.failureDetailDays * DAY_MS
	);
	result.integrationFailureDetailsRedacted = await executeBatches(
		maxBatches,
		batchSize,
		() =>
			prisma.$executeRaw(
				Prisma.sql`
					WITH expired AS (
						SELECT failure."id"
						FROM "widgets"."integration_delivery_failures" AS failure
						WHERE failure."resolved_at" < ${failureCutoff}
							AND failure."details_purged_at" IS NULL
							AND failure."resolution" IS NOT NULL
							AND failure."active_retry_token" IS NULL
							AND failure."retry_lease_expires_at" IS NULL
						ORDER BY failure."resolved_at" ASC, failure."id" ASC
						LIMIT ${batchSize}
						FOR UPDATE OF failure SKIP LOCKED
					)
					UPDATE "widgets"."integration_delivery_failures" AS failure
					SET
						"payload" = '{}'::jsonb,
						"headers" = '{}'::jsonb,
						"last_error" = ${WIDGETS_REDACTED_FAILURE_DETAIL},
						"safe_reason" = NULL,
						"http_status" = NULL,
						"provider_code" = NULL,
						"resolution_comment" = CASE
							WHEN failure."resolution_comment" IS NULL THEN NULL
							ELSE ${WIDGETS_REDACTED_FAILURE_DETAIL}
						END,
						"details_purged_at" = ${now},
						"updated_at" = NOW()
					FROM expired
					WHERE failure."id" = expired."id"
				`
			)
	);
	result.consumerFailureDetailsRedacted = await executeBatches(
		maxBatches,
		batchSize,
		() =>
			prisma.$executeRaw(
				Prisma.sql`
					WITH expired AS (
						SELECT failure."id"
						FROM "widgets"."consumer_failures" AS failure
						WHERE failure."status" = 'RESOLVED'::"widgets"."WidgetsConsumerFailureStatus"
							AND failure."resolved_at" < ${failureCutoff}
							AND failure."details_purged_at" IS NULL
							AND failure."retry_token" IS NULL
							AND failure."retry_lease_expires_at" IS NULL
						ORDER BY failure."resolved_at" ASC, failure."id" ASC
						LIMIT ${batchSize}
						FOR UPDATE OF failure SKIP LOCKED
					)
					UPDATE "widgets"."consumer_failures" AS failure
					SET
						"payload" = '{}'::jsonb,
						"headers" = '{}'::jsonb,
						"last_error" = ${WIDGETS_REDACTED_FAILURE_DETAIL},
						"details_purged_at" = ${now},
						"updated_at" = NOW()
					FROM expired
					WHERE failure."id" = expired."id"
				`
			)
	);

	return result;
}

@Injectable()
export class WidgetsRetentionService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(WidgetsRetentionService.name);
	private readonly retention: WidgetsRetentionConfig;
	private readonly totals = emptyResult();
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;
	private stopping = false;
	private lastSuccessfulCleanupAt: Date | null = null;
	private lastFailureAt: Date | null = null;
	private lastAttemptAt: Date | null = null;
	private runs = 0;
	private consecutiveFailures = 0;

	constructor(
		private readonly prisma: WidgetsPrismaService,
		private readonly runtime: WidgetsRuntimeService,
		config: ConfigService
	) {
		this.retention = parseWidgetsRetentionConfig(config);
	}

	onModuleInit(): void {
		if (!this.enabled()) return;
		void this.scheduleCleanup();
		this.timer = setInterval(
			() => void this.scheduleCleanup(),
			CLEANUP_INTERVAL_MS
		);
		this.timer.unref();
	}

	isReady(): boolean {
		if (!this.enabled()) return true;
		return Boolean(
			this.lastSuccessfulCleanupAt &&
			Date.now() - this.lastSuccessfulCleanupAt.getTime() <=
				CLEANUP_STALE_AFTER_MS
		);
	}

	status() {
		return {
			enabled: this.enabled(),
			healthy: this.isReady(),
			running: Boolean(this.running),
			lastSuccessfulCleanupAt:
				this.lastSuccessfulCleanupAt?.toISOString() || null,
			lastAttemptAt: this.lastAttemptAt?.toISOString() || null,
			lastFailureAt: this.lastFailureAt?.toISOString() || null,
			runs: this.runs,
			consecutiveFailures: this.consecutiveFailures,
			totals: { ...this.totals }
		};
	}

	async beforeApplicationShutdown(): Promise<void> {
		this.stopping = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		if (!this.running) return;
		await Promise.race([
			this.running.catch(() => undefined),
			new Promise<void>(resolve =>
				setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref()
			)
		]);
	}

	private async scheduleCleanup(): Promise<void> {
		if (this.stopping || this.running || !this.enabled()) return;
		this.running = this.cleanup();
		try {
			await this.running;
		} finally {
			this.running = null;
		}
	}

	private async cleanup(): Promise<void> {
		this.lastAttemptAt = new Date();
		try {
			const result = await runWidgetsRetentionCleanup(this.prisma, {
				...this.retention,
				cleanupOutbox: this.runtime.publisherEnabled,
				cleanupWorkerState: this.runtime.workerEnabled
			});
			this.lastSuccessfulCleanupAt = new Date();
			this.runs += 1;
			this.consecutiveFailures = 0;
			for (const key of Object.keys(result) as Array<
				keyof WidgetsRetentionResult
			>) {
				this.totals[key] += result[key];
			}
			const total = Object.values(result).reduce(
				(sum, count) => sum + count,
				0
			);
			if (total) {
				this.logger.log(
					`Widgets retention cleanup outbox=${result.publishedOutboxDeleted} snapshots=${result.credentialSnapshotsDeleted} integrationReceipts=${result.integrationReceiptsCompacted} consumerReceipts=${result.consumerReceiptsCompacted} integrationFailures=${result.integrationFailureDetailsRedacted} consumerFailures=${result.consumerFailureDetailsRedacted}`
				);
			}
		} catch (error) {
			this.lastFailureAt = new Date();
			this.consecutiveFailures += 1;
			this.logger.error(
				`Widgets retention cleanup failed: ${this.error(error)}`
			);
		}
	}

	private enabled(): boolean {
		return this.runtime.publisherEnabled || this.runtime.workerEnabled;
	}

	private error(error: unknown): string {
		if (error instanceof Prisma.PrismaClientKnownRequestError) {
			return `PrismaClientKnownRequestError:${error.code}`;
		}
		return error instanceof Error &&
			/^[A-Za-z0-9_.-]{1,80}$/.test(error.name)
			? error.name
			: 'UnknownError';
	}
}

async function executeBatches(
	maxBatches: number,
	batchSize: number,
	operation: () => Promise<number>
): Promise<number> {
	let total = 0;
	for (let batch = 0; batch < maxBatches; batch += 1) {
		const affected = await operation();
		total += affected;
		if (affected < batchSize) break;
	}
	return total;
}

function retentionDays(
	config: ConfigService,
	key: string,
	defaultValue: number,
	maximum: number
): number {
	const value = Number(config.get<string>(key) || defaultValue);
	assertRetentionDays(value, key, maximum);
	return value;
}

function assertCleanupBounds(batchSize: number, maxBatches: number): void {
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
		throw new Error(
			'Widgets retention batch size must be between 1 and 1000'
		);
	}
	if (
		!Number.isInteger(maxBatches) ||
		maxBatches < 1 ||
		maxBatches > 100
	) {
		throw new Error(
			'Widgets retention max batches must be between 1 and 100'
		);
	}
}

function assertRetentionConfig(config: WidgetsRetentionConfig): void {
	assertRetentionDays(
		config.outboxDays,
		'WIDGETS_OUTBOX_RETENTION_DAYS',
		OUTBOX_RETENTION_MAX_DAYS
	);
	assertRetentionDays(
		config.receiptDays,
		'WIDGETS_RECEIPT_RETENTION_DAYS',
		RECEIPT_RETENTION_MAX_DAYS
	);
	assertRetentionDays(
		config.failureDetailDays,
		'WIDGETS_FAILURE_DETAIL_RETENTION_DAYS',
		FAILURE_RETENTION_MAX_DAYS
	);
}

function assertRetentionDays(
	value: number,
	key: string,
	maximum: number
): void {
	if (!Number.isInteger(value) || value < 1 || value > maximum) {
		throw new Error(`${key} must be between 1 and ${maximum}`);
	}
}
