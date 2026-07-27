import { NotificationDeliveryPrismaService } from './prisma/notification-delivery-prisma.service';
import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	NotificationDeliveryReceiptStatus,
	Prisma
} from '@prisma/notification-delivery-client';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 1000;
const CLEANUP_MAX_BATCHES = 20;
const REDACTED_FAILURE_DETAIL = '[redacted after retention]';

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

	constructor(
		private readonly prisma: NotificationDeliveryPrismaService,
		private readonly configService: ConfigService
	) {}

	onModuleInit(): void {
		void this.runCleanup();
		this.timer = setInterval(
			() => void this.runCleanup(),
			CLEANUP_INTERVAL_MS
		);
		this.timer.unref();
	}

	onApplicationShutdown(): void {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
	}

	private async runCleanup(): Promise<void> {
		if (this.running || this.stopped) return;
		this.running = true;

		try {
			const now = Date.now();
			const deletedReceipts = await this.deleteDeliveredReceipts(
				new Date(
					now -
						this.getRetentionDays(
							'NOTIFICATION_DELIVERY_RECEIPT_RETENTION_DAYS',
							90,
							30
						) *
							24 *
							60 *
							60 *
							1000
				)
			);
			const redactedFailures = await this.redactResolvedFailures(
				new Date(
					now -
						this.getRetentionDays(
							'NOTIFICATION_DELIVERY_FAILURE_DETAIL_RETENTION_DAYS',
							30,
							1
						) *
							24 *
							60 *
							60 *
							1000
				)
			);
			const deletedHeartbeats =
				await this.prisma.notificationDeliveryHeartbeat.deleteMany({
					where: {
						lastSeenAt: {
							lt: new Date(now - 7 * 24 * 60 * 60 * 1000)
						}
					}
				});

			if (deletedReceipts || redactedFailures || deletedHeartbeats.count) {
				this.logger.log(
					`Notification retention cleanup receipts=${deletedReceipts} failures=${redactedFailures} heartbeats=${deletedHeartbeats.count}`
				);
			}
		} catch (error) {
			this.logger.error(
				`Notification retention cleanup failed: ${
					error instanceof Error ? error.stack : String(error)
				}`
			);
		} finally {
			this.running = false;
		}
	}

	private async deleteDeliveredReceipts(
		deliveredBefore: Date
	): Promise<number> {
		let deleted = 0;
		for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch += 1) {
			const rows = await this.prisma.notificationDeliveryReceipt.findMany({
				where: {
					status: NotificationDeliveryReceiptStatus.DELIVERED,
					deliveredAt: { lt: deliveredBefore }
				},
				orderBy: { deliveredAt: 'asc' },
				take: CLEANUP_BATCH_SIZE,
				select: { id: true }
			});
			if (!rows.length) break;
			const result =
				await this.prisma.notificationDeliveryReceipt.deleteMany({
					where: {
						id: { in: rows.map(row => row.id) },
						status: NotificationDeliveryReceiptStatus.DELIVERED,
						deliveredAt: { lt: deliveredBefore }
					}
				});
			deleted += result.count;
			if (rows.length < CLEANUP_BATCH_SIZE) break;
		}
		return deleted;
	}

	private async redactResolvedFailures(
		resolvedBefore: Date
	): Promise<number> {
		let redacted = 0;
		for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch += 1) {
			const rows = await this.prisma.notificationDeliveryFailure.findMany({
				where: {
					resolvedAt: { lt: resolvedBefore },
					lastError: { not: REDACTED_FAILURE_DETAIL }
				},
				orderBy: { resolvedAt: 'asc' },
				take: CLEANUP_BATCH_SIZE,
				select: { id: true }
			});
			if (!rows.length) break;
			const result =
				await this.prisma.notificationDeliveryFailure.updateMany({
					where: {
						id: { in: rows.map(row => row.id) },
						resolvedAt: { lt: resolvedBefore },
						lastError: { not: REDACTED_FAILURE_DETAIL }
					},
					data: {
						payload: {} as Prisma.InputJsonObject,
						headers: {} as Prisma.InputJsonObject,
						lastError: REDACTED_FAILURE_DETAIL,
						safeReason: REDACTED_FAILURE_DETAIL,
						httpStatus: null,
						providerCode: null
					}
				});
			redacted += result.count;
			if (rows.length < CLEANUP_BATCH_SIZE) break;
		}
		return redacted;
	}

	private getRetentionDays(
		key: string,
		defaultValue: number,
		minimum: number
	): number {
		const configured = Number(
			this.configService.get<string>(key) || defaultValue
		);
		return Number.isInteger(configured) && configured >= minimum
			? configured
			: defaultValue;
	}
}
