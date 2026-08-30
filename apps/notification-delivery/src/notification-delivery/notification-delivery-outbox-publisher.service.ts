import {
	CAMPAIGN_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	DEAD_LETTER_EXCHANGE,
	EVENTS_EXCHANGE,
	getDeadLetterRoutingKey,
	getManualRetryRoutingKey,
	NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	NOTIFICATION_DELIVERY_KINDS,
	NotificationDeliveryKind,
	REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE
} from '../messaging/messaging.constants';
import { assertMessagingEventContract } from '../messaging/messaging-event-contract';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { NotificationDeliveryHeartbeatService } from './notification-delivery-heartbeat.service';
import { NotificationDeliveryPrismaService } from './prisma/notification-delivery-prisma.service';
import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	NotificationDeliveryExchange,
	NotificationDeliveryOutboxEvent,
	NotificationDeliveryOutboxStatus,
	Prisma
} from '@prisma/notification-delivery-client';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const OUTBOX_LEASE_MS = 60_000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 20_000;

type ClaimedOutboxEvent = NotificationDeliveryOutboxEvent & {
	lockToken: string;
};

@Injectable()
export class NotificationDeliveryOutboxPublisherService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(
		NotificationDeliveryOutboxPublisherService.name
	);
	private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private shuttingDown = false;
	private started = false;
	private lastSuccessfulPollAt: Date | null = null;

	constructor(
		private readonly prisma: NotificationDeliveryPrismaService,
		private readonly rabbitMq: RabbitMqService,
		private readonly configService: ConfigService,
		private readonly heartbeat: NotificationDeliveryHeartbeatService
	) {}

	onModuleInit(): void {
		this.started = true;
		this.schedule(0);
	}

	isReady(): boolean {
		return (
			this.started &&
			!this.shuttingDown &&
			this.lastSuccessfulPollAt !== null
		);
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
					event: 'notification_outbox.shutdown_timeout',
					activePoll: true,
					timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS
				})
			);
			return;
		}
		this.logger.log(
			JSON.stringify({ event: 'notification_outbox.shutdown_complete' })
		);
	}

	private schedule(delayMs: number): void {
		if (this.shuttingDown) return;
		this.timer = setTimeout(() => void this.poll(), delayMs);
		this.timer.unref();
	}

	private async poll(): Promise<void> {
		if (this.running || this.shuttingDown) return;
		this.running = true;

		try {
			const events = await this.claimBatch();
			this.lastSuccessfulPollAt = new Date();

			for (let index = 0; index < events.length; index += 1) {
				if (this.shuttingDown) {
					await this.releaseClaims(events.slice(index));
					break;
				}
				const event = events[index];
				if (!(await this.renewClaim(event))) {
					this.logger.warn(
						`Skipped notification outbox event with lost claim eventId=${event.id}`
					);
					continue;
				}
				await this.publish(event);
			}
		} catch (error) {
			this.logger.error(
				`Notification outbox polling failed: ${
					error instanceof Error ? error.stack : String(error)
				}`
			);
		} finally {
			this.running = false;
			this.schedule(this.getPollInterval());
		}
	}

	private async claimBatch(): Promise<ClaimedOutboxEvent[]> {
		const now = new Date();
		const batchSize = this.getBatchSize();

		return this.prisma.$transaction(async transaction => {
			await transaction.notificationDeliveryOutboxEvent.updateMany({
				where: {
					status: NotificationDeliveryOutboxStatus.PUBLISHING,
					leaseExpiresAt: { lte: now }
				},
				data: {
					status: NotificationDeliveryOutboxStatus.PENDING,
					lockedAt: null,
					lockedBy: null,
					lockToken: null,
					leaseExpiresAt: null
				}
			});

			const candidates =
				await transaction.notificationDeliveryOutboxEvent.findMany({
					where: {
						status: NotificationDeliveryOutboxStatus.PENDING,
						availableAt: { lte: now }
					},
					orderBy: { createdAt: 'asc' },
					take: batchSize,
					select: { id: true }
				});
			const claimed: ClaimedOutboxEvent[] = [];

			for (const candidate of candidates) {
				const lockedAt = new Date();
				const lockToken = randomUUID();
				const leaseExpiresAt = new Date(
					lockedAt.getTime() + OUTBOX_LEASE_MS
				);
				const result =
					await transaction.notificationDeliveryOutboxEvent.updateMany({
						where: {
							id: candidate.id,
							status: NotificationDeliveryOutboxStatus.PENDING,
							availableAt: { lte: now }
						},
						data: {
							status: NotificationDeliveryOutboxStatus.PUBLISHING,
							lockedAt,
							lockedBy: this.workerId,
							lockToken,
							leaseExpiresAt
						}
					});
				if (result.count !== 1) continue;

				const event =
					await transaction.notificationDeliveryOutboxEvent.findUnique({
						where: { id: candidate.id }
					});
				if (event?.lockToken === lockToken) {
					claimed.push({ ...event, lockToken });
				}
			}

			return claimed;
		});
	}

	private async renewClaim(event: ClaimedOutboxEvent): Promise<boolean> {
		const now = new Date();
		const result =
			await this.prisma.notificationDeliveryOutboxEvent.updateMany({
				where: {
					id: event.id,
					status: NotificationDeliveryOutboxStatus.PUBLISHING,
					lockedBy: this.workerId,
					lockToken: event.lockToken
				},
				data: {
					lockedAt: now,
					leaseExpiresAt: new Date(now.getTime() + OUTBOX_LEASE_MS)
				}
			});
		return result.count === 1;
	}

	private async publish(event: ClaimedOutboxEvent): Promise<void> {
		const validationError = this.getValidationError(event);
		if (validationError) {
			await this.quarantine(event, validationError);
			return;
		}

		const headers = this.getEventHeaders(event.headers);
		const correlationId =
			typeof headers['x-correlation-id'] === 'string'
				? headers['x-correlation-id']
				: event.messageId;

		try {
			await this.rabbitMq.publishOutboxMessage(
				this.getExchange(event.exchange),
				event.routingKey,
				event.payload,
				{
					messageId: event.messageId,
					type: event.eventType,
					correlationId,
					headers: {
						...headers,
						'x-outbox-event-id': event.id,
						'x-publish-attempt': event.attempts + 1
					}
				}
			);
			this.heartbeat.markSuccessfulPublish();

			const published =
				await this.prisma.notificationDeliveryOutboxEvent.updateMany({
					where: {
						id: event.id,
						status: NotificationDeliveryOutboxStatus.PUBLISHING,
						lockedBy: this.workerId,
						lockToken: event.lockToken
					},
					data: {
						status: NotificationDeliveryOutboxStatus.PUBLISHED,
						attempts: { increment: 1 },
						publishedAt: new Date(),
						lockedAt: null,
						lockedBy: null,
						lockToken: null,
						leaseExpiresAt: null,
						lastError: null
					}
				});
			if (published.count !== 1) {
				this.logger.warn(
					`Published notification outbox event but lost finalization claim eventId=${event.id}`
				);
				return;
			}
			this.logger.log(
				JSON.stringify({
					event: 'notification_outbox.publish_succeeded',
					eventId: event.id,
					messageId: event.messageId,
					eventType: event.eventType,
					exchange: event.exchange,
					routingKey: event.routingKey,
					attempt: event.attempts + 1
				})
			);
		} catch (error) {
			const attempts = event.attempts + 1;
			const message =
				error instanceof Error ? error.message : String(error);
			const rescheduled =
				await this.prisma.notificationDeliveryOutboxEvent.updateMany({
					where: {
						id: event.id,
						status: NotificationDeliveryOutboxStatus.PUBLISHING,
						lockedBy: this.workerId,
						lockToken: event.lockToken
					},
					data: {
						status: NotificationDeliveryOutboxStatus.PENDING,
						attempts,
						availableAt: new Date(
							Date.now() + this.getBackoffDelay(attempts)
						),
						lockedAt: null,
						lockedBy: null,
						lockToken: null,
						leaseExpiresAt: null,
						lastError: message.slice(0, 4000)
					}
				});
			if (rescheduled.count !== 1) {
				this.logger.warn(
					`Could not reschedule notification outbox event with lost claim eventId=${event.id}`
				);
			}
			this.logger.warn(
				JSON.stringify({
					event: 'notification_outbox.publish_failed',
					eventId: event.id,
					messageId: event.messageId,
					eventType: event.eventType,
					exchange: event.exchange,
					routingKey: event.routingKey,
					attempt: attempts,
					error: message
				})
			);
		}
	}

	private getValidationError(event: ClaimedOutboxEvent): string | null {
		const isStrictOutcomeRoute =
			event.exchange === NotificationDeliveryExchange.EVENTS &&
			((event.eventType === TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE &&
				event.routingKey ===
					TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE) ||
				(event.eventType === NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE &&
					event.routingKey === NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE) ||
				(event.eventType ===
					REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE &&
					event.routingKey ===
						REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE) ||
				(event.eventType ===
					CAMPAIGN_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE &&
					event.routingKey ===
						CAMPAIGN_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE));
		if (isStrictOutcomeRoute) {
			try {
				assertMessagingEventContract(event.payload, {
					eventType: event.eventType,
					routingKey: event.routingKey,
					messageId: event.messageId
				});
				return null;
			} catch {
				return 'INVALID_NOTIFICATION_DELIVERY_CONTRACT';
			}
		}

		const kind = this.getOwnedKind(event);
		if (!kind) {
			return 'INVALID_NOTIFICATION_DELIVERY_ROUTE';
		}
		if (event.exchange === NotificationDeliveryExchange.DEAD_LETTER) {
			return null;
		}
		try {
			assertMessagingEventContract(event.payload, {
				eventType: event.eventType,
				routingKey: event.routingKey,
				messageId: event.messageId,
				kind
			});
			return null;
		} catch {
			return 'INVALID_NOTIFICATION_DELIVERY_CONTRACT';
		}
	}

	private getOwnedKind(
		event: ClaimedOutboxEvent
	): NotificationDeliveryKind | null {
		for (const kind of NOTIFICATION_DELIVERY_KINDS) {
			if (
				event.exchange === NotificationDeliveryExchange.EVENTS &&
				event.routingKey === getManualRetryRoutingKey(kind)
			) {
				return kind;
			}
			if (
				event.exchange === NotificationDeliveryExchange.DEAD_LETTER &&
				event.routingKey === getDeadLetterRoutingKey(kind)
			) {
				return kind;
			}
		}
		return null;
	}

	private async quarantine(
		event: ClaimedOutboxEvent,
		reason: string
	): Promise<void> {
		const quarantined =
			await this.prisma.notificationDeliveryOutboxEvent.updateMany({
				where: {
					id: event.id,
					status: NotificationDeliveryOutboxStatus.PUBLISHING,
					lockedBy: this.workerId,
					lockToken: event.lockToken
				},
				data: {
					status: NotificationDeliveryOutboxStatus.FAILED,
					attempts: { increment: 1 },
					lockedAt: null,
					lockedBy: null,
					lockToken: null,
					leaseExpiresAt: null,
					lastError: reason
				}
			});
		if (quarantined.count !== 1) {
			this.logger.warn(
				`Could not quarantine invalid notification outbox event with lost claim eventId=${event.id}`
			);
			return;
		}
		this.logger.error(
			JSON.stringify({
				event: 'notification_outbox.event_quarantined',
				eventId: event.id,
				messageId: event.messageId,
				eventType: event.eventType,
				exchange: event.exchange,
				routingKey: event.routingKey,
				reason
			})
		);
	}

	private async releaseClaims(
		events: ClaimedOutboxEvent[]
	): Promise<void> {
		for (const event of events) {
			await this.prisma.notificationDeliveryOutboxEvent.updateMany({
				where: {
					id: event.id,
					status: NotificationDeliveryOutboxStatus.PUBLISHING,
					lockedBy: this.workerId,
					lockToken: event.lockToken
				},
				data: {
					status: NotificationDeliveryOutboxStatus.PENDING,
					lockedAt: null,
					lockedBy: null,
					lockToken: null,
					leaseExpiresAt: null
				}
			});
		}
	}

	private getExchange(
		exchange: NotificationDeliveryExchange
	): typeof EVENTS_EXCHANGE | typeof DEAD_LETTER_EXCHANGE {
		return exchange === NotificationDeliveryExchange.EVENTS
			? EVENTS_EXCHANGE
			: DEAD_LETTER_EXCHANGE;
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
			this.configService.get<string>(
				'NOTIFICATION_DELIVERY_OUTBOX_BATCH_SIZE'
			) || DEFAULT_BATCH_SIZE
		);
		return Number.isInteger(value) && value > 0
			? Math.min(value, 500)
			: DEFAULT_BATCH_SIZE;
	}

	private getPollInterval(): number {
		const value = Number(
			this.configService.get<string>(
				'NOTIFICATION_DELIVERY_OUTBOX_POLL_INTERVAL_MS'
			) || DEFAULT_POLL_INTERVAL_MS
		);
		return Number.isInteger(value) && value >= 100
			? value
			: DEFAULT_POLL_INTERVAL_MS;
	}
}
