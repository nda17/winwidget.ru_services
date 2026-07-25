import {
	OUTBOX_DEFAULT_BATCH_SIZE,
	OUTBOX_DEFAULT_POLL_INTERVAL_MS,
	OUTBOX_DEFAULT_RETENTION_DAYS,
	OUTBOX_LOCK_TIMEOUT_MS
} from '@/messaging/messaging.constants';
import { getCurrentCorrelationId } from '@/messaging/messaging-context';
import { MessagingHeartbeatService } from '@/messaging/messaging-heartbeat.service';
import { RabbitMqService } from '@/messaging/rabbitmq.service';
import { PrismaService } from '@/prisma.service';
import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxEvent, OutboxEventStatus, Prisma } from '@prisma/client';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

const SHUTDOWN_DRAIN_TIMEOUT_MS = 20_000;

@Injectable()
export class OutboxPublisherService
	implements OnModuleInit, BeforeApplicationShutdown
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
		private readonly configService: ConfigService,
		private readonly heartbeat: MessagingHeartbeatService
	) {}

	onModuleInit(): void {
		this.schedule(0);
	}

	async beforeApplicationShutdown(): Promise<void> {
		this.shuttingDown = true;
		if (this.timer) clearTimeout(this.timer);

		const deadline = Date.now() + SHUTDOWN_DRAIN_TIMEOUT_MS;
		while (this.running && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		if (this.running) {
			this.logger.warn(
				JSON.stringify({
					event: 'outbox.shutdown_timeout',
					activePoll: true,
					timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS
				})
			);
		} else {
			this.logger.log(
				JSON.stringify({ event: 'outbox.shutdown_complete' })
			);
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
			this.heartbeat.markSuccessfulPoll();
			for (let index = 0; index < events.length; index++) {
				if (this.shuttingDown) {
					await this.releaseClaims(
						events.slice(index).map(item => item.id)
					);
					break;
				}
				const event = events[index];
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
		const headers = this.getEventHeaders(event.headers);
		const correlationId =
			getCurrentCorrelationId() ||
			(typeof headers['x-correlation-id'] === 'string'
				? headers['x-correlation-id']
				: event.messageId || event.id);
		try {
			await this.rabbitMq.publishEvent(event.routingKey, event.payload, {
				messageId: event.messageId ?? event.id,
				type: event.eventType,
				correlationId,
				headers: {
					...headers,
					'x-outbox-event-id': event.id,
					'x-publish-attempt': event.attempts + 1
				}
			});
			this.heartbeat.markSuccessfulPublish();

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
			} else {
				this.logger.log(
					JSON.stringify({
						event: 'outbox.publish_succeeded',
						eventId: event.id,
						messageId: event.messageId || event.id,
						eventType: event.eventType,
						routingKey: event.routingKey,
						correlationId,
						attempt: event.attempts + 1
					})
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
				JSON.stringify({
					event: 'outbox.publish_failed',
					eventId: event.id,
					messageId: event.messageId || event.id,
					eventType: event.eventType,
					routingKey: event.routingKey,
					correlationId,
					attempt: attempts,
					error: message
				})
			);
		}
	}

	private async releaseClaims(eventIds: string[]): Promise<void> {
		if (!eventIds.length) return;
		await this.prisma.outboxEvent.updateMany({
			where: {
				id: { in: eventIds },
				status: OutboxEventStatus.PUBLISHING,
				lockedBy: this.workerId
			},
			data: {
				status: OutboxEventStatus.PENDING,
				lockedAt: null,
				lockedBy: null
			}
		});
	}

	private getEventHeaders(
		value: Prisma.JsonValue
	): Record<string, string | number | boolean> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return {};
		}
		return Object.fromEntries(
			Object.entries(value).filter(
				(entry): entry is [string, string | number | boolean] =>
					typeof entry[1] === 'string' ||
					typeof entry[1] === 'number' ||
					typeof entry[1] === 'boolean'
			)
		);
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
