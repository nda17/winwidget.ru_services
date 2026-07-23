import {
	OUTBOX_DEFAULT_BATCH_SIZE,
	OUTBOX_DEFAULT_POLL_INTERVAL_MS,
	OUTBOX_DEFAULT_RETENTION_DAYS,
	OUTBOX_LOCK_TIMEOUT_MS,
	OUTBOX_MAX_PUBLISH_ATTEMPTS
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

	private async publish(event: OutboxEvent): Promise<void> {
		try {
			await this.rabbitMq.publishEvent(event.routingKey, event.payload, {
				messageId: event.id,
				type: event.eventType,
				headers: {
					'x-outbox-event-id': event.id,
					'x-publish-attempt': event.attempts + 1
				}
			});

			await this.prisma.outboxEvent.updateMany({
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
		} catch (error) {
			const attempts = event.attempts + 1;
			const failed = attempts >= OUTBOX_MAX_PUBLISH_ATTEMPTS;
			const message =
				error instanceof Error ? error.message : String(error);

			await this.prisma.outboxEvent.updateMany({
				where: {
					id: event.id,
					status: OutboxEventStatus.PUBLISHING,
					lockedBy: this.workerId
				},
				data: {
					status: failed
						? OutboxEventStatus.FAILED
						: OutboxEventStatus.PENDING,
					attempts,
					availableAt: new Date(
						Date.now() + this.getBackoffDelay(attempts)
					),
					lockedAt: null,
					lockedBy: null,
					lastError: message.slice(0, 4000)
				}
			});

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

		const result = await this.prisma.outboxEvent.deleteMany({
			where: {
				status: OutboxEventStatus.PUBLISHED,
				publishedAt: { lt: publishedBefore }
			}
		});
		if (result.count) {
			this.logger.log(
				`Deleted ${result.count} published outbox events older than ${retentionDays} days`
			);
		}
	}
}
