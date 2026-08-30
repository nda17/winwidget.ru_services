import { NotificationDeliveryPrismaService } from './prisma/notification-delivery-prisma.service';
import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	NotificationDeliveryFailureResolution,
	NotificationDeliveryOutboxStatus,
	NotificationDeliveryReceiptStatus,
	Prisma
} from '@prisma/notification-delivery-client';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CLEANUP_CONTINUATION_MS = 1000;
const CLEANUP_RETRY_MS = 60 * 1000;
const CLEANUP_BATCH_SIZE = 1000;
const CLEANUP_MAX_BATCHES = 20;
const OUTBOX_RETENTION_DAYS = 7;
const RECEIPT_DETAIL_RETENTION_DAYS = 90;
const FAILURE_DETAIL_RETENTION_DAYS = 30;
const FAILURE_RETENTION_DAYS = 365;
const HEARTBEAT_RETENTION_DAYS = 7;
const REDACTED_FAILURE_DETAIL = '[redacted after retention]';
const TERMINAL_FAILURE_RESOLUTIONS = [
	NotificationDeliveryFailureResolution.DELIVERED,
	NotificationDeliveryFailureResolution.CLOSED_NO_RETRY
];
const FIXED_RETENTION_ENV = [
	['NOTIFICATION_DELIVERY_OUTBOX_RETENTION_DAYS', OUTBOX_RETENTION_DAYS],
	[
		'NOTIFICATION_DELIVERY_RECEIPT_RETENTION_DAYS',
		RECEIPT_DETAIL_RETENTION_DAYS
	],
	[
		'NOTIFICATION_DELIVERY_FAILURE_DETAIL_RETENTION_DAYS',
		FAILURE_DETAIL_RETENTION_DAYS
	]
] as const;

type CleanupBatchResult = {
	count: number;
	hasMore: boolean;
};

type CleanupCycleResult = {
	hasMore: boolean;
	deletedOutbox: number;
	redactedReceipts: number;
	redactedFailures: number;
	deletedFailures: number;
	deletedHeartbeats: number;
};

@Injectable()
export class NotificationDeliveryRetentionService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(
		NotificationDeliveryRetentionService.name
	);
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private stopped = false;
	private initialCleanupComplete = false;

	constructor(
		private readonly prisma: NotificationDeliveryPrismaService,
		private readonly configService: ConfigService
	) {}

	onModuleInit(): void {
		this.assertFixedRetentionEnvironment();
		this.schedule(0);
	}

	isInitialCleanupReady(): boolean {
		return this.initialCleanupComplete;
	}

	onApplicationShutdown(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
	}

	private schedule(delayMs: number): void {
		if (this.stopped) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.runCleanup(), delayMs);
		this.timer.unref();
	}

	private async runCleanup(): Promise<void> {
		if (this.running || this.stopped) return;
		this.running = true;

		try {
			const result = await this.cleanupCycle(new Date());
			if (!result.hasMore) this.initialCleanupComplete = true;

			if (
				result.deletedOutbox ||
				result.redactedReceipts ||
				result.redactedFailures ||
				result.deletedFailures ||
				result.deletedHeartbeats
			) {
				this.logger.log(
					`Notification retention cleanup outbox=${result.deletedOutbox} receipts=${result.redactedReceipts} redactedFailures=${result.redactedFailures} deletedFailures=${result.deletedFailures} heartbeats=${result.deletedHeartbeats}`
				);
			}

			this.schedule(
				result.hasMore ? CLEANUP_CONTINUATION_MS : CLEANUP_INTERVAL_MS
			);
		} catch (error) {
			this.logger.error(
				`Notification retention cleanup failed: ${
					error instanceof Error ? error.stack : String(error)
				}`
			);
			this.schedule(CLEANUP_RETRY_MS);
		} finally {
			this.running = false;
		}
	}

	private async cleanupCycle(now: Date): Promise<CleanupCycleResult> {
		const publishedBefore = this.subtractDays(now, OUTBOX_RETENTION_DAYS);
		const receiptDetailsBefore = this.subtractDays(
			now,
			RECEIPT_DETAIL_RETENTION_DAYS
		);
		const failureDetailsBefore = this.subtractDays(
			now,
			FAILURE_DETAIL_RETENTION_DAYS
		);
		const failuresBefore = this.subtractDays(now, FAILURE_RETENTION_DAYS);

		const deletedOutbox =
			await this.deletePublishedOutbox(publishedBefore);
		const redactedReceipts = await this.redactDeliveredReceiptDetails(
			receiptDetailsBefore,
			now
		);
		const deletedFailures =
			await this.deleteResolvedFailures(failuresBefore);
		const redactedFailures = await this.redactResolvedFailureDetails(
			failureDetailsBefore,
			now
		);
		const deletedHeartbeats =
			await this.prisma.notificationDeliveryHeartbeat.deleteMany({
				where: {
					lastSeenAt: {
						lt: this.subtractDays(now, HEARTBEAT_RETENTION_DAYS)
					}
				}
			});
		const retentionBacklog = await this.hasRetentionBacklog({
			publishedBefore,
			receiptDetailsBefore,
			failureDetailsBefore,
			failuresBefore
		});

		return {
			hasMore:
				deletedOutbox.hasMore ||
				redactedReceipts.hasMore ||
				deletedFailures.hasMore ||
				redactedFailures.hasMore ||
				retentionBacklog,
			deletedOutbox: deletedOutbox.count,
			redactedReceipts: redactedReceipts.count,
			redactedFailures: redactedFailures.count,
			deletedFailures: deletedFailures.count,
			deletedHeartbeats: deletedHeartbeats.count
		};
	}

	private async deletePublishedOutbox(
		publishedBefore: Date
	): Promise<CleanupBatchResult> {
		let deleted = 0;
		let hasMore = false;

		for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch += 1) {
			const rows =
				await this.prisma.notificationDeliveryOutboxEvent.findMany({
					where: {
						status: NotificationDeliveryOutboxStatus.PUBLISHED,
						publishedAt: { lt: publishedBefore }
					},
					orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
					take: CLEANUP_BATCH_SIZE,
					select: { id: true }
				});
			if (!rows.length) {
				hasMore = false;
				break;
			}
			const result =
				await this.prisma.notificationDeliveryOutboxEvent.deleteMany({
					where: {
						id: { in: rows.map(row => row.id) },
						status: NotificationDeliveryOutboxStatus.PUBLISHED,
						publishedAt: { lt: publishedBefore }
					}
				});
			deleted += result.count;
			hasMore = rows.length === CLEANUP_BATCH_SIZE;
			if (!hasMore) break;
		}

		return { count: deleted, hasMore };
	}

	private async redactDeliveredReceiptDetails(
		deliveredBefore: Date,
		redactedAt: Date
	): Promise<CleanupBatchResult> {
		let redacted = 0;
		let hasMore = false;

		for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch += 1) {
			const rows = await this.prisma.notificationDeliveryReceipt.findMany({
				where: {
					status: NotificationDeliveryReceiptStatus.DELIVERED,
					deliveredAt: { lt: deliveredBefore },
					detailsRedactedAt: null
				},
				orderBy: [{ deliveredAt: 'asc' }, { id: 'asc' }],
				take: CLEANUP_BATCH_SIZE,
				select: { id: true }
			});
			if (!rows.length) {
				hasMore = false;
				break;
			}

			const result =
				await this.prisma.notificationDeliveryReceipt.updateMany({
					where: {
						id: { in: rows.map(row => row.id) },
						status: NotificationDeliveryReceiptStatus.DELIVERED,
						deliveredAt: { lt: deliveredBefore },
						detailsRedactedAt: null
					},
					data: {
						checkpoint: Prisma.DbNull,
						detailsRedactedAt: redactedAt
					}
				});
			redacted += result.count;
			hasMore = rows.length === CLEANUP_BATCH_SIZE;
			if (!hasMore) break;
		}

		return { count: redacted, hasMore };
	}

	private async redactResolvedFailureDetails(
		resolvedBefore: Date,
		redactedAt: Date
	): Promise<CleanupBatchResult> {
		let redacted = 0;
		let hasMore = false;

		for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch += 1) {
			const batchResult = await this.prisma.$transaction(
				async transaction => {
					const rows =
						await transaction.notificationDeliveryFailure.findMany({
							where: {
								resolution: {
									in: TERMINAL_FAILURE_RESOLUTIONS
								},
								resolvedAt: { lt: resolvedBefore },
								detailsRedactedAt: null
							},
							orderBy: [
								{ resolution: 'asc' },
								{ resolvedAt: 'asc' },
								{ id: 'asc' }
							],
							take: CLEANUP_BATCH_SIZE,
							select: { id: true }
						});
					if (!rows.length) return { count: 0, selected: 0 };

					const ids = rows.map(row => row.id);
					await transaction.notificationDeliveryControlAction.updateMany({
						where: {
							failureId: { in: ids },
							comment: { not: null },
							failure: {
								is: {
									resolution: {
										in: TERMINAL_FAILURE_RESOLUTIONS
									},
									resolvedAt: { lt: resolvedBefore },
									detailsRedactedAt: null
								}
							}
						},
						data: { comment: REDACTED_FAILURE_DETAIL }
					});
					const baseData = {
						payload: {} as Prisma.InputJsonObject,
						headers: {} as Prisma.InputJsonObject,
						lastError: REDACTED_FAILURE_DETAIL,
						safeReason: REDACTED_FAILURE_DETAIL,
						httpStatus: null,
						providerCode: null,
						resolutionComment: null,
						detailsRedactedAt: redactedAt
					};
					const delivered =
						await transaction.notificationDeliveryFailure.updateMany({
							where: {
								id: { in: ids },
								resolution:
									NotificationDeliveryFailureResolution.DELIVERED,
								resolvedAt: { lt: resolvedBefore },
								detailsRedactedAt: null
							},
							data: baseData
						});
					const closed =
						await transaction.notificationDeliveryFailure.updateMany({
							where: {
								id: { in: ids },
								resolution:
									NotificationDeliveryFailureResolution.CLOSED_NO_RETRY,
								resolvedAt: { lt: resolvedBefore },
								detailsRedactedAt: null
							},
							data: {
								...baseData,
								resolutionComment: REDACTED_FAILURE_DETAIL
							}
						});
					const count = delivered.count + closed.count;
					if (count !== rows.length) {
						throw new Error(
							'Notification failure detail redaction lost its retention claim'
						);
					}
					return { count, selected: rows.length };
				}
			);
			if (!batchResult.selected) {
				hasMore = false;
				break;
			}

			redacted += batchResult.count;
			hasMore = batchResult.selected === CLEANUP_BATCH_SIZE;
			if (!hasMore) break;
		}

		return { count: redacted, hasMore };
	}

	private async deleteResolvedFailures(
		resolvedBefore: Date
	): Promise<CleanupBatchResult> {
		let deleted = 0;
		let hasMore = false;

		for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch += 1) {
			const batchResult = await this.prisma.$transaction(
				async transaction => {
					const rows = await transaction.$queryRaw<Array<{ id: string }>>(
						Prisma.sql`
							SELECT "id"
							FROM "notification_delivery"."delivery_failures"
							WHERE "resolution" IN (
								'DELIVERED'::"notification_delivery"."NotificationDeliveryFailureResolution",
								'CLOSED_NO_RETRY'::"notification_delivery"."NotificationDeliveryFailureResolution"
							)
								AND "resolved_at" < ${resolvedBefore}
							ORDER BY "resolution", "resolved_at", "id"
							FOR UPDATE SKIP LOCKED
							LIMIT ${CLEANUP_BATCH_SIZE}
						`
					);
					if (!rows.length) return { count: 0, selected: 0 };

					const ids = rows.map(row => row.id);
					await transaction.notificationDeliveryControlAction.deleteMany({
						where: { failureId: { in: ids } }
					});
					const result =
						await transaction.notificationDeliveryFailure.deleteMany({
							where: {
								id: { in: ids },
								resolution: {
									in: TERMINAL_FAILURE_RESOLUTIONS
								},
								resolvedAt: { lt: resolvedBefore }
							}
						});
					if (result.count !== rows.length) {
						throw new Error(
							'Notification failure deletion lost its retention claim'
						);
					}
					return { count: result.count, selected: rows.length };
				}
			);
			if (!batchResult.selected) {
				hasMore = false;
				break;
			}

			deleted += batchResult.count;
			hasMore = batchResult.selected === CLEANUP_BATCH_SIZE;
			if (!hasMore) break;
		}

		return { count: deleted, hasMore };
	}

	private async hasRetentionBacklog(cutoffs: {
		publishedBefore: Date;
		receiptDetailsBefore: Date;
		failureDetailsBefore: Date;
		failuresBefore: Date;
	}): Promise<boolean> {
		const [outbox, receipt, failure] = await Promise.all([
			this.prisma.notificationDeliveryOutboxEvent.findFirst({
				where: {
					status: NotificationDeliveryOutboxStatus.PUBLISHED,
					publishedAt: { lt: cutoffs.publishedBefore }
				},
				select: { id: true }
			}),
			this.prisma.notificationDeliveryReceipt.findFirst({
				where: {
					status: NotificationDeliveryReceiptStatus.DELIVERED,
					deliveredAt: { lt: cutoffs.receiptDetailsBefore },
					detailsRedactedAt: null
				},
				select: { id: true }
			}),
			this.prisma.notificationDeliveryFailure.findFirst({
				where: {
					resolution: { in: TERMINAL_FAILURE_RESOLUTIONS },
					OR: [
						{ resolvedAt: { lt: cutoffs.failuresBefore } },
						{
							resolvedAt: { lt: cutoffs.failureDetailsBefore },
							detailsRedactedAt: null
						}
					]
				},
				select: { id: true }
			})
		]);

		return Boolean(outbox || receipt || failure);
	}

	private subtractDays(value: Date, days: number): Date {
		return new Date(value.getTime() - days * DAY_MS);
	}

	private assertFixedRetentionEnvironment(): void {
		for (const [key, expected] of FIXED_RETENTION_ENV) {
			const configured = this.configService.get<string>(key);
			if (configured === undefined) continue;
			if (configured.trim() !== String(expected)) {
				throw new Error(`${key} is fixed at ${expected} days`);
			}
		}
	}
}
