import { ReportingMetricsService } from '../metrics/reporting-metrics.service';
import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import { ReportingRuntimeService } from '../runtime/reporting-runtime.service';
import {
	ADMIN_AUDIT_EVENT_TYPE,
	DAILY_SUMMARY_NOTIFICATION_EVENT_TYPE,
	REPORTING_DEAD_LETTER_EXCHANGE,
	REPORTING_EVENTS_EXCHANGE,
	REPORTING_MANUAL_RETRY_EXCHANGE,
	REPORTING_RETRY_EXCHANGE
} from './reporting-messaging.constants';
import { ReportingRabbitMqService } from './reporting-rabbitmq.service';
import {
	assertDailySummaryNotificationRequestedEvent,
	assertReportingConsumerOutboxEvent,
	assertReportingAdminAuditEvent
} from './reporting-published-event.contract';
import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	Prisma,
	ReportingOutboxEvent,
	ReportingOutboxExchange,
	ReportingOutboxStatus
} from '@prisma/reporting-client';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const OUTBOX_LEASE_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 20_000;
const OUTBOX_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const OUTBOX_CLEANUP_BATCH_SIZE = 1000;

type ClaimedOutboxEvent = ReportingOutboxEvent & { lockToken: string };

@Injectable()
export class ReportingOutboxPublisherService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(
		ReportingOutboxPublisherService.name
	);
	private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;
	private stopping = false;
	private firstPollCompleted = false;
	private lastCleanupAt = 0;

	constructor(
		private readonly prisma: ReportingPrismaService,
		private readonly rabbitMq: ReportingRabbitMqService,
		private readonly runtime: ReportingRuntimeService,
		private readonly metrics: ReportingMetricsService,
		private readonly config: ConfigService
	) {}

	onModuleInit(): void {
		if (!this.runtime.publisherEnabled) return;
		void this.schedulePoll();
		this.timer = setInterval(
			() => void this.schedulePoll(),
			this.pollInterval()
		);
		this.timer.unref();
	}

	isReady(): boolean {
		return !this.runtime.publisherEnabled || this.firstPollCompleted;
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

	private async schedulePoll(): Promise<void> {
		if (this.stopping || this.running) return;
		this.running = this.poll();
		try {
			await this.running;
			this.firstPollCompleted = true;
			this.metrics.setGauge('outbox_publisher_ready', 1);
		} catch (error) {
			this.logger.error(
				`Reporting Outbox poll failed: ${this.error(error)}`
			);
			this.metrics.increment('outbox_poll_failures_total');
		} finally {
			this.running = null;
		}
	}

	private async poll(): Promise<void> {
		await this.cleanupPublishedEventsIfDue();
		const now = new Date();
		const candidates = await this.prisma.reportingOutboxEvent.findMany({
			where: {
				OR: [
					{
						status: ReportingOutboxStatus.PENDING,
						availableAt: { lte: now }
					},
					{
						status: ReportingOutboxStatus.PUBLISHING,
						leaseExpiresAt: { lte: now }
					}
				]
			},
			orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
			take: this.batchSize(),
			select: { id: true }
		});
		for (const candidate of candidates) {
			if (this.stopping) break;
			const claimed = await this.claim(candidate.id);
			if (claimed) await this.publish(claimed);
		}
		this.metrics.setGauge(
			'outbox_last_poll_timestamp_seconds',
			Date.now() / 1000
		);
	}

	private async cleanupPublishedEventsIfDue(): Promise<void> {
		if (Date.now() - this.lastCleanupAt < OUTBOX_CLEANUP_INTERVAL_MS)
			return;
		const cutoff = new Date(
			Date.now() - this.retentionDays() * 24 * 60 * 60 * 1000
		);
		let deletedTotal = 0;
		for (let batch = 0; batch < 10; batch += 1) {
			const deleted = await this.prisma.$executeRaw`
				DELETE FROM "reporting"."outbox_events"
				WHERE "id" IN (
					SELECT "id"
					FROM "reporting"."outbox_events"
					WHERE "status" = 'PUBLISHED'::"reporting"."ReportingOutboxStatus"
						AND "updated_at" < ${cutoff}
					ORDER BY "updated_at" ASC
					LIMIT ${OUTBOX_CLEANUP_BATCH_SIZE}
					FOR UPDATE SKIP LOCKED
				)
			`;
			deletedTotal += deleted;
			if (deleted < OUTBOX_CLEANUP_BATCH_SIZE) break;
		}
		this.lastCleanupAt = Date.now();
		if (deletedTotal) {
			this.metrics.increment('outbox_events_cleaned_total', deletedTotal);
		}
	}

	private async claim(id: string): Promise<ClaimedOutboxEvent | null> {
		const now = new Date();
		const lockToken = randomUUID();
		const claimed = await this.prisma.reportingOutboxEvent.updateMany({
			where: {
				id,
				OR: [
					{
						status: ReportingOutboxStatus.PENDING,
						availableAt: { lte: now }
					},
					{
						status: ReportingOutboxStatus.PUBLISHING,
						leaseExpiresAt: { lte: now }
					}
				]
			},
			data: {
				status: ReportingOutboxStatus.PUBLISHING,
				lockedAt: now,
				lockedBy: this.workerId,
				lockToken,
				leaseExpiresAt: new Date(now.getTime() + OUTBOX_LEASE_MS)
			}
		});
		if (claimed.count !== 1) return null;
		const event = await this.prisma.reportingOutboxEvent.findUnique({
			where: { id }
		});
		return event?.lockToken === lockToken
			? ({ ...event, lockToken } as ClaimedOutboxEvent)
			: null;
	}

	private async publish(event: ClaimedOutboxEvent): Promise<void> {
		if (event.exchange === ReportingOutboxExchange.EVENTS) {
			try {
				if (event.eventType === DAILY_SUMMARY_NOTIFICATION_EVENT_TYPE) {
					assertDailySummaryNotificationRequestedEvent(
						event.payload,
						event.messageId
					);
				} else if (event.eventType === ADMIN_AUDIT_EVENT_TYPE) {
					assertReportingAdminAuditEvent(event.payload, event.messageId);
				} else {
					throw new Error(
						`Reporting cannot publish event type ${event.eventType}`
					);
				}
			} catch (error) {
				await this.quarantine(event, this.error(error));
				return;
			}
		} else {
			try {
				assertReportingConsumerOutboxEvent({
					exchange: event.exchange,
					eventType: event.eventType,
					routingKey: event.routingKey,
					messageId: event.messageId,
					payload: event.payload,
					headers: event.headers
				});
			} catch (error) {
				await this.quarantine(event, this.error(error));
				return;
			}
		}

		const renewed = await this.prisma.reportingOutboxEvent.updateMany({
			where: {
				id: event.id,
				status: ReportingOutboxStatus.PUBLISHING,
				lockedBy: this.workerId,
				lockToken: event.lockToken
			},
			data: {
				leaseExpiresAt: new Date(Date.now() + OUTBOX_LEASE_MS)
			}
		});
		if (renewed.count !== 1) return;
		const headers = this.scalarHeaders(event.headers);
		try {
			await this.rabbitMq.publish(
				this.exchange(event.exchange),
				event.routingKey,
				event.payload,
				{
					messageId: event.messageId,
					type: event.eventType,
					correlationId:
						typeof headers['x-correlation-id'] === 'string'
							? headers['x-correlation-id']
							: event.messageId,
					headers: {
						...headers,
						'x-outbox-event-id': event.id,
						'x-publish-attempt': event.attempts + 1
					}
				}
			);
			const completed = await this.prisma.reportingOutboxEvent.updateMany({
				where: {
					id: event.id,
					status: ReportingOutboxStatus.PUBLISHING,
					lockedBy: this.workerId,
					lockToken: event.lockToken
				},
				data: {
					status: ReportingOutboxStatus.PUBLISHED,
					attempts: { increment: 1 },
					publishedAt: new Date(),
					lockedAt: null,
					lockedBy: null,
					lockToken: null,
					leaseExpiresAt: null,
					lastError: null
				}
			});
			if (completed.count !== 1) {
				this.logger.warn(
					`Published reporting event after losing claim eventId=${event.id}`
				);
			}
			this.metrics.increment('outbox_events_published_total');
		} catch (error) {
			const attempts = event.attempts + 1;
			await this.prisma.reportingOutboxEvent.updateMany({
				where: {
					id: event.id,
					status: ReportingOutboxStatus.PUBLISHING,
					lockedBy: this.workerId,
					lockToken: event.lockToken
				},
				data: {
					status: ReportingOutboxStatus.PENDING,
					attempts,
					availableAt: new Date(Date.now() + this.backoff(attempts)),
					lockedAt: null,
					lockedBy: null,
					lockToken: null,
					leaseExpiresAt: null,
					lastError: this.error(error).slice(0, 4000)
				}
			});
			this.metrics.increment('outbox_publish_retries_total');
			this.logger.warn(
				`Reporting Outbox publish rescheduled eventId=${event.id} attempt=${attempts}: ${this.error(error)}`
			);
		}
	}

	private quarantine(
		event: ClaimedOutboxEvent,
		reason: string
	): Promise<Prisma.BatchPayload> {
		return this.prisma.reportingOutboxEvent.updateMany({
			where: {
				id: event.id,
				status: ReportingOutboxStatus.PUBLISHING,
				lockedBy: this.workerId,
				lockToken: event.lockToken
			},
			data: {
				status: ReportingOutboxStatus.QUARANTINED,
				attempts: { increment: 1 },
				lockedAt: null,
				lockedBy: null,
				lockToken: null,
				leaseExpiresAt: null,
				lastError: `INVALID_OUTBOX_CONTRACT: ${reason}`.slice(0, 4000)
			}
		});
	}

	private exchange(exchange: ReportingOutboxExchange) {
		if (exchange === ReportingOutboxExchange.EVENTS) {
			return REPORTING_EVENTS_EXCHANGE;
		}
		if (exchange === ReportingOutboxExchange.RETRY) {
			return REPORTING_RETRY_EXCHANGE;
		}
		if (exchange === ReportingOutboxExchange.MANUAL_RETRY) {
			return REPORTING_MANUAL_RETRY_EXCHANGE;
		}
		return REPORTING_DEAD_LETTER_EXCHANGE;
	}

	private scalarHeaders(
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

	private batchSize(): number {
		const value = Number(
			process.env.REPORTING_OUTBOX_BATCH_SIZE || DEFAULT_BATCH_SIZE
		);
		if (!Number.isInteger(value) || value < 1 || value > 500) {
			throw new Error(
				'REPORTING_OUTBOX_BATCH_SIZE must be between 1 and 500'
			);
		}
		return value;
	}

	private pollInterval(): number {
		const value = Number(
			process.env.REPORTING_OUTBOX_POLL_INTERVAL_MS ||
				DEFAULT_POLL_INTERVAL_MS
		);
		if (!Number.isInteger(value) || value < 100 || value > 60_000) {
			throw new Error(
				'REPORTING_OUTBOX_POLL_INTERVAL_MS must be between 100 and 60000'
			);
		}
		return value;
	}

	private retentionDays(): number {
		const value = Number(
			this.config.get<string>('REPORTING_OUTBOX_RETENTION_DAYS') || 7
		);
		if (!Number.isInteger(value) || value < 1 || value > 365) {
			throw new Error(
				'REPORTING_OUTBOX_RETENTION_DAYS must be between 1 and 365'
			);
		}
		return value;
	}

	private backoff(attempt: number): number {
		return Math.min(
			300_000,
			1000 * 2 ** Math.min(Math.max(attempt - 1, 0), 8)
		);
	}

	private error(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
