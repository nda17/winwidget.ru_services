import {
	OUTBOX_DEFAULT_BATCH_SIZE,
	OUTBOX_DEFAULT_POLL_INTERVAL_MS,
	OUTBOX_DEFAULT_RETENTION_DAYS,
	OUTBOX_LOCK_TIMEOUT_MS
} from '@/messaging/messaging.constants';
import { RabbitMqService } from '@/messaging/rabbitmq.service';
import { PrismaService } from '@/prisma.service';
import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxEvent, OutboxEventStatus, Prisma } from '@prisma/client';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

@Injectable()
export class OutboxPublisherService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(OutboxPublisherService.name);
	private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private readonly cleanupBatchSize = 1000;
	private readonly cleanupMaxBatches = 20;
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private shuttingDown = false;
	private lastCleanupAt = 0;

	constructor(
		private readonly prisma: PrismaService,
		private readonly rabbitMq: RabbitMqService,
		private readonly configService: ConfigService
	) {}

	onModuleInit(): void {
		this.schedule(0);
	}

	async onApplicationShutdown(): Promise<void> {
		this.shuttingDown = true;
		if (this.timer) clearTimeout(this.timer);

		while (this.running) {
			await new Promise(resolve => setTimeout(resolve, 25));
		}
	}

	private schedule(delay: number): void {
		if (this.shuttingDown) return;
		this.timer = setTimeout(() => void this.poll(), delay);
		this.timer.unref();
	}

	private async poll(): Promise<void> {
		if (this.running || this.shuttingDown) return;
		this.running = true;

		try {
			await this.cleanupPublishedEventsIfDue();
			const events = await this.claimBatch();
			for (const event of events) {
				const claimRenewed = await this.renewClaim(event.id);
				if (!claimRenewed) {
					this.logger.warn(
						`Skipped outbox event with lost claim eventId=${event.id}`
					);
					continue;
				}
				await this.publish(event);
			}
		} catch (error) {
			this.logger.error(
				`Outbox polling failed: ${
					error instanceof Error ? error.stack : String(error)
				}`
			);
		} finally {
			this.running = false;
			this.schedule(this.getPollInterval());
		}
	}

	private async claimBatch(): Promise<OutboxEvent[]> {
		const staleBefore = new Date(Date.now() - OUTBOX_LOCK_TIMEOUT_MS);
		const batchSize = this.getBatchSize();

		return this.prisma.$transaction(async transaction => {
			await transaction.outboxEvent.updateMany({
				where: {
					status: OutboxEventStatus.PUBLISHING,
					lockedAt: { lt: staleBefore }
				},
				data: {
					status: OutboxEventStatus.PENDING,
					lockedAt: null,
					lockedBy: null
				}
			});

			await transaction.outboxEvent.updateMany({
				where: {
					status: OutboxEventStatus.FAILED,
					availableAt: { lte: new Date() }
				},
				data: {
					status: OutboxEventStatus.PENDING,
					lockedAt: null,
					lockedBy: null
				}
			});

			const rows = await transaction.$queryRaw<Array<{ id: string }>>(
				Prisma.sql`
					SELECT "id"
					FROM "outbox_events"
					WHERE "status" = 'PENDING'::"OutboxEventStatus"
						AND "available_at" <= NOW()
					ORDER BY "created_at" ASC
					LIMIT ${batchSize}
					FOR UPDATE SKIP LOCKED
				`
			);

			if (!rows.length) return [];
			const ids = rows.map(row => row.id);
			const lockedAt = new Date();

			await transaction.outboxEvent.updateMany({
				where: {
					id: { in: ids },
					status: OutboxEventStatus.PENDING
				},
				data: {
					status: OutboxEventStatus.PUBLISHING,
					lockedAt,
					lockedBy: this.workerId
				}
			});

			return transaction.outboxEvent.findMany({
				where: {
					id: { in: ids },
					status: OutboxEventStatus.PUBLISHING,
					lockedBy: this.workerId,
					lockedAt
				},
				orderBy: { createdAt: 'asc' }
			});
		});
	}

	private async renewClaim(eventId: string): Promise<boolean> {
		const result = await this.prisma.outboxEvent.updateMany({
			where: {
				id: eventId,
				status: OutboxEventStatus.PUBLISHING,
				lockedBy: this.workerId
			},
			data: {
				lockedAt: new Date()
			}
		});

		return result.count === 1;
	}

	private async publish(event: OutboxEvent): Promise<void> {
		try {
			await this.rabbitMq.publishEvent(event.routingKey, event.payload, {
				messageId: event.messageId ?? event.id,
				type: event.eventType,
				headers: {
					'x-outbox-event-id': event.id,
					'x-publish-attempt': event.attempts + 1
				}
			});

			const result = await this.prisma.outboxEvent.updateMany({
				where: {
					id: event.id,
					status: OutboxEventStatus.PUBLISHING,
					lockedBy: this.workerId
				},
				data: {
					status: OutboxEventStatus.PUBLISHED,
					attempts: { increment: 1 },
					publishedAt: new Date(),
					lockedAt: null,
					lockedBy: null,
					lastError: null
				}
			});
			if (result.count !== 1) {
				this.logger.warn(
					`Published outbox event but could not finalize its claim eventId=${event.id}`
				);
			}
		} catch (error) {
			const attempts = event.attempts + 1;
			const message =
				error instanceof Error ? error.message : String(error);

			const result = await this.prisma.outboxEvent.updateMany({
				where: {
					id: event.id,
					status: OutboxEventStatus.PUBLISHING,
					lockedBy: this.workerId
				},
				data: {
					status: OutboxEventStatus.PENDING,
					attempts,
					availableAt: new Date(
						Date.now() + this.getBackoffDelay(attempts)
					),
					lockedAt: null,
					lockedBy: null,
					lastError: message.slice(0, 4000)
				}
			});
			if (result.count !== 1) {
				this.logger.warn(
					`Could not reschedule outbox event with lost claim eventId=${event.id}`
				);
			}

			this.logger.warn(
				`Outbox publish failed eventId=${event.id} attempt=${attempts}: ${message}`
			);
		}
	}

	private getBackoffDelay(attempt: number): number {
		return Math.min(60_000, 1000 * 2 ** Math.min(attempt - 1, 6));
	}

	private getBatchSize(): number {
		const value = Number(
			this.configService.get('OUTBOX_BATCH_SIZE') ||
				OUTBOX_DEFAULT_BATCH_SIZE
		);
		return Number.isInteger(value) && value > 0
			? Math.min(value, 500)
			: OUTBOX_DEFAULT_BATCH_SIZE;
	}

	private getPollInterval(): number {
		const value = Number(
			this.configService.get('OUTBOX_POLL_INTERVAL_MS') ||
				OUTBOX_DEFAULT_POLL_INTERVAL_MS
		);
		return Number.isInteger(value) && value >= 100
			? value
			: OUTBOX_DEFAULT_POLL_INTERVAL_MS;
	}

	private async cleanupPublishedEventsIfDue(): Promise<void> {
		const now = Date.now();
		if (now - this.lastCleanupAt < 60 * 60 * 1000) return;
		this.lastCleanupAt = now;

		const configuredDays = Number(
			this.configService.get('OUTBOX_RETENTION_DAYS') ||
				OUTBOX_DEFAULT_RETENTION_DAYS
		);
		const retentionDays =
			Number.isInteger(configuredDays) && configuredDays >= 1
				? configuredDays
				: OUTBOX_DEFAULT_RETENTION_DAYS;
		const publishedBefore = new Date(
			now - retentionDays * 24 * 60 * 60 * 1000
		);

		let deleted = 0;
		for (let batch = 0; batch < this.cleanupMaxBatches; batch++) {
			const count = await this.prisma.$executeRaw(
				Prisma.sql`
					WITH expired AS (
						SELECT "id"
						FROM "outbox_events"
						WHERE "status" = 'PUBLISHED'::"OutboxEventStatus"
							AND "published_at" < ${publishedBefore}
						ORDER BY "published_at" ASC
						LIMIT ${this.cleanupBatchSize}
					)
					DELETE FROM "outbox_events" AS event
					USING expired
					WHERE event."id" = expired."id"
				`
			);
			deleted += count;
			if (count < this.cleanupBatchSize) break;
		}

		if (deleted) {
			this.logger.log(
				`Deleted ${deleted} published outbox events older than ${retentionDays} days`
			);
		}
	}
}
