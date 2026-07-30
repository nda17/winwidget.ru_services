import {
	CAMPAIGN_EMAIL_REQUESTED_EVENT_TYPE,
	CAMPAIGN_TELEGRAM_REQUESTED_EVENT_TYPE,
	CAMPAIGNS_RETRY_EXCHANGE,
	DEAD_LETTER_EXCHANGE,
	EVENTS_EXCHANGE
} from './campaigns-messaging.constants';
import { assertCampaignsPublishedEvent } from './campaigns-event.contract';
import {
	CampaignsPublishExchange,
	CampaignsRabbitMqService
} from './campaigns-rabbitmq.service';
import { CampaignsPrismaService } from '../prisma/campaigns-prisma.service';
import { CampaignsRuntimeService } from '../runtime/campaigns-runtime.service';
import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	CampaignDeliveryChannel,
	CampaignDeliveryStatus,
	CampaignOutboxEvent,
	CampaignOutboxExchange,
	CampaignOutboxStatus,
	CampaignStatus,
	Prisma
} from '@prisma/campaigns-client';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const OUTBOX_LEASE_MS = 60_000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 20_000;
const OUTBOX_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const OUTBOX_CLEANUP_BATCH_SIZE = 1000;

type ClaimedOutboxEvent = CampaignOutboxEvent & { lockToken: string };

@Injectable()
export class CampaignsOutboxPublisherService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(
		CampaignsOutboxPublisherService.name
	);
	private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private started = false;
	private shuttingDown = false;
	private lastSuccessfulPollAt: Date | null = null;
	private lastCleanupAt = 0;

	constructor(
		private readonly prisma: CampaignsPrismaService,
		private readonly rabbitMq: CampaignsRabbitMqService,
		private readonly runtime: CampaignsRuntimeService,
		private readonly config: ConfigService
	) {}

	onModuleInit(): void {
		if (!this.runtime.publisherEnabled) return;
		this.started = true;
		this.schedule(0);
	}

	isReady(): boolean {
		return (
			!this.runtime.publisherEnabled ||
			(this.started &&
				!this.shuttingDown &&
				this.lastSuccessfulPollAt !== null)
		);
	}

	async beforeApplicationShutdown(): Promise<void> {
		if (!this.runtime.publisherEnabled) return;
		this.shuttingDown = true;
		if (this.timer) clearTimeout(this.timer);
		const deadline = Date.now() + SHUTDOWN_DRAIN_TIMEOUT_MS;
		while (this.running && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 50));
		}
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
			await this.cleanupTerminalEventsIfDue();
			const events = await this.claimBatch();
			this.lastSuccessfulPollAt = new Date();
			for (const event of events) {
				if (this.shuttingDown) {
					await this.release(event);
					continue;
				}
				await this.publish(event);
			}
		} catch (error) {
			this.logger.error(
				`Campaigns outbox poll failed: ${
					error instanceof Error ? error.stack : String(error)
				}`
			);
		} finally {
			this.running = false;
			this.schedule(this.pollInterval());
		}
	}

	private async cleanupTerminalEventsIfDue(): Promise<void> {
		if (Date.now() - this.lastCleanupAt < OUTBOX_CLEANUP_INTERVAL_MS) {
			return;
		}
		const cutoff = new Date(
			Date.now() - this.retentionDays() * 24 * 60 * 60 * 1000
		);
		for (let batch = 0; batch < 10; batch += 1) {
			const deleted = await this.prisma.$executeRaw`
				DELETE FROM "campaigns"."outbox_events"
				WHERE "id" IN (
					SELECT "id"
					FROM "campaigns"."outbox_events"
					WHERE "status" IN (
						'PUBLISHED'::"campaigns"."CampaignOutboxStatus",
						'CANCELLED'::"campaigns"."CampaignOutboxStatus"
					)
						AND "updated_at" < ${cutoff}
					ORDER BY "updated_at" ASC
					LIMIT ${OUTBOX_CLEANUP_BATCH_SIZE}
					FOR UPDATE SKIP LOCKED
				)
			`;
			if (deleted < OUTBOX_CLEANUP_BATCH_SIZE) break;
		}
		this.lastCleanupAt = Date.now();
	}

	private async claimBatch(): Promise<ClaimedOutboxEvent[]> {
		const now = new Date();
		return this.prisma.$transaction(async transaction => {
			await transaction.campaignOutboxEvent.updateMany({
				where: {
					status: CampaignOutboxStatus.PUBLISHING,
					leaseExpiresAt: { lte: now }
				},
				data: {
					status: CampaignOutboxStatus.PENDING,
					lockedAt: null,
					lockedBy: null,
					lockToken: null,
					leaseExpiresAt: null
				}
			});
			const candidates = await transaction.campaignOutboxEvent.findMany({
				where: {
					status: CampaignOutboxStatus.PENDING,
					availableAt: { lte: now }
				},
				orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
				take: this.batchSize(),
				select: { id: true }
			});
			const claimed: ClaimedOutboxEvent[] = [];
			for (const candidate of candidates) {
				const lockToken = randomUUID();
				const lockedAt = new Date();
				const result = await transaction.campaignOutboxEvent.updateMany({
					where: {
						id: candidate.id,
						status: CampaignOutboxStatus.PENDING,
						availableAt: { lte: now }
					},
					data: {
						status: CampaignOutboxStatus.PUBLISHING,
						lockedAt,
						lockedBy: this.workerId,
						lockToken,
						leaseExpiresAt: new Date(lockedAt.getTime() + OUTBOX_LEASE_MS)
					}
				});
				if (result.count !== 1) continue;
				const event = await transaction.campaignOutboxEvent.findUnique({
					where: { id: candidate.id }
				});
				if (event?.lockToken === lockToken) {
					claimed.push({ ...event, lockToken });
				}
			}
			return claimed;
		});
	}

	private async publish(event: ClaimedOutboxEvent): Promise<void> {
		if (!(await this.prepareDispatch(event))) return;
		if (event.exchange === CampaignOutboxExchange.EVENTS) {
			try {
				assertCampaignsPublishedEvent(
					event.payload,
					event.eventType,
					event.messageId
				);
			} catch (error) {
				await this.quarantine(
					event,
					error instanceof Error
						? error.message
						: 'Invalid outbox contract'
				);
				return;
			}
		}
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
			const result = await this.prisma.campaignOutboxEvent.updateMany({
				where: {
					id: event.id,
					status: CampaignOutboxStatus.PUBLISHING,
					lockedBy: this.workerId,
					lockToken: event.lockToken
				},
				data: {
					status: CampaignOutboxStatus.PUBLISHED,
					attempts: { increment: 1 },
					publishedAt: new Date(),
					lockedAt: null,
					lockedBy: null,
					lockToken: null,
					leaseExpiresAt: null,
					lastError: null
				}
			});
			if (result.count !== 1) {
				this.logger.warn(
					`Published outbox event after losing claim eventId=${event.id}`
				);
			}
		} catch (error) {
			const attempts = event.attempts + 1;
			await this.prisma.campaignOutboxEvent.updateMany({
				where: {
					id: event.id,
					status: CampaignOutboxStatus.PUBLISHING,
					lockedBy: this.workerId,
					lockToken: event.lockToken
				},
				data: {
					status: CampaignOutboxStatus.PENDING,
					attempts,
					availableAt: new Date(Date.now() + this.backoff(attempts)),
					lockedAt: null,
					lockedBy: null,
					lockToken: null,
					leaseExpiresAt: null,
					lastError: this.errorMessage(error).slice(0, 4000)
				}
			});
			this.logger.warn(
				`Campaigns outbox publish rescheduled eventId=${event.id} attempt=${attempts}: ${this.errorMessage(error)}`
			);
		}
	}

	private async prepareDispatch(
		event: ClaimedOutboxEvent
	): Promise<boolean> {
		const isDeliveryRequest =
			event.aggregateType === 'campaign-delivery' &&
			(event.eventType === CAMPAIGN_EMAIL_REQUESTED_EVENT_TYPE ||
				event.eventType === CAMPAIGN_TELEGRAM_REQUESTED_EVENT_TYPE);
		if (!isDeliveryRequest || !event.aggregateId || !event.generation) {
			return true;
		}
		const aggregateId = event.aggregateId;
		const generation = event.generation;
		return this.prisma.$transaction(
			async transaction => {
				const identity = await transaction.campaignDelivery.findUnique({
					where: { id: aggregateId },
					select: { campaignId: true }
				});
				if (!identity) {
					await this.cancelEvent(
						transaction,
						event,
						'UNKNOWN_CAMPAIGN_DELIVERY'
					);
					return false;
				}
				await transaction.$executeRaw`
					SELECT pg_advisory_xact_lock(
						hashtextextended(
							${`campaign-aggregate:${identity.campaignId}`},
							0
						)
					)
				`;
				await transaction.$executeRaw`
					SELECT pg_advisory_xact_lock(
						hashtextextended(
							${`campaign-aggregate:${aggregateId}`},
							0
						)
					)
				`;
				const delivery = await transaction.campaignDelivery.findUnique({
					where: { id: aggregateId },
					include: { campaign: true }
				});
				if (
					!delivery ||
					delivery.dispatchGeneration !== generation ||
					delivery.requestEventId !== event.messageId
				) {
					await this.cancelEvent(
						transaction,
						event,
						'STALE_CAMPAIGN_DELIVERY_REQUEST'
					);
					return false;
				}
				if (delivery.status === CampaignDeliveryStatus.PROCESSING) {
					return true;
				}
				if (delivery.status !== CampaignDeliveryStatus.PENDING) {
					await this.cancelEvent(
						transaction,
						event,
						'TERMINAL_CAMPAIGN_DELIVERY'
					);
					return false;
				}
				if (
					delivery.campaign.status === CampaignStatus.CANCEL_REQUESTED ||
					delivery.campaign.status === CampaignStatus.CANCELLED
				) {
					await transaction.campaignDelivery.update({
						where: { id: delivery.id },
						data: {
							status: CampaignDeliveryStatus.CANCELLED,
							cancelledAt: new Date()
						}
					});
					await transaction.campaign.update({
						where: { id: delivery.campaignId },
						data: {
							cancelledCount: { increment: 1 }
						}
					});
					await this.cancelEvent(
						transaction,
						event,
						'CAMPAIGN_CANCEL_REQUESTED'
					);
					await this.finalizeCancellation(
						transaction,
						delivery.campaignId
					);
					return false;
				}
				if (delivery.campaign.status === CampaignStatus.SNAPSHOTTING) {
					await transaction.campaignOutboxEvent.updateMany({
						where: {
							id: event.id,
							status: CampaignOutboxStatus.PUBLISHING,
							lockedBy: this.workerId,
							lockToken: event.lockToken
						},
						data: {
							status: CampaignOutboxStatus.PENDING,
							availableAt: new Date(Date.now() + 1000),
							lockedAt: null,
							lockedBy: null,
							lockToken: null,
							leaseExpiresAt: null
						}
					});
					return false;
				}
				if (
					delivery.campaign.status !== CampaignStatus.QUEUED &&
					delivery.campaign.status !== CampaignStatus.RUNNING
				) {
					await this.cancelEvent(
						transaction,
						event,
						'CAMPAIGN_NOT_DISPATCHABLE'
					);
					return false;
				}
				const delay = await this.acquireRateSlot(
					transaction,
					delivery.campaignId,
					delivery.channel
				);
				if (delay > 0) {
					await transaction.campaignOutboxEvent.updateMany({
						where: {
							id: event.id,
							status: CampaignOutboxStatus.PUBLISHING,
							lockedBy: this.workerId,
							lockToken: event.lockToken
						},
						data: {
							status: CampaignOutboxStatus.PENDING,
							availableAt: new Date(Date.now() + delay),
							lockedAt: null,
							lockedBy: null,
							lockToken: null,
							leaseExpiresAt: null
						}
					});
					return false;
				}
				await transaction.campaignDelivery.update({
					where: { id: delivery.id },
					data: {
						status: CampaignDeliveryStatus.PROCESSING,
						attempts: { increment: 1 }
					}
				});
				await transaction.campaign.updateMany({
					where: {
						id: delivery.campaignId,
						status: CampaignStatus.QUEUED
					},
					data: {
						status: CampaignStatus.RUNNING,
						startedAt: delivery.campaign.startedAt || new Date()
					}
				});
				return true;
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable
			}
		);
	}

	private async acquireRateSlot(
		transaction: Prisma.TransactionClient,
		campaignId: string,
		channel: CampaignDeliveryChannel
	): Promise<number> {
		await transaction.$executeRaw`
			SELECT pg_advisory_xact_lock(
				hashtextextended(${`campaign-rate:${campaignId}:${channel}`}, 0)
			)
		`;
		const now = new Date();
		const current = await transaction.campaignRateLimit.findUnique({
			where: { campaignId_channel: { campaignId, channel } }
		});
		if (current && current.nextAvailableAt.getTime() > now.getTime()) {
			return current.nextAvailableAt.getTime() - now.getTime();
		}
		const rate = this.ratePerSecond(channel);
		const nextAvailableAt = new Date(
			now.getTime() + Math.ceil(1000 / rate)
		);
		await transaction.campaignRateLimit.upsert({
			where: { campaignId_channel: { campaignId, channel } },
			create: { campaignId, channel, nextAvailableAt },
			update: { nextAvailableAt }
		});
		return 0;
	}

	private async finalizeCancellation(
		transaction: Prisma.TransactionClient,
		campaignId: string
	): Promise<void> {
		const active = await transaction.campaignDelivery.count({
			where: {
				campaignId,
				status: {
					in: [
						CampaignDeliveryStatus.PENDING,
						CampaignDeliveryStatus.PROCESSING
					]
				}
			}
		});
		if (active === 0) {
			await transaction.campaign.updateMany({
				where: {
					id: campaignId,
					status: CampaignStatus.CANCEL_REQUESTED
				},
				data: {
					status: CampaignStatus.CANCELLED,
					completedAt: new Date()
				}
			});
		}
	}

	private cancelEvent(
		transaction: Prisma.TransactionClient,
		event: ClaimedOutboxEvent,
		reason: string
	) {
		return transaction.campaignOutboxEvent.updateMany({
			where: {
				id: event.id,
				status: CampaignOutboxStatus.PUBLISHING,
				lockedBy: this.workerId,
				lockToken: event.lockToken
			},
			data: {
				status: CampaignOutboxStatus.CANCELLED,
				lockedAt: null,
				lockedBy: null,
				lockToken: null,
				leaseExpiresAt: null,
				lastError: reason
			}
		});
	}

	private async quarantine(
		event: ClaimedOutboxEvent,
		reason: string
	): Promise<void> {
		await this.prisma.$transaction(async transaction => {
			if (
				event.aggregateType === 'campaign-delivery' &&
				event.aggregateId &&
				event.generation
			) {
				const identity = await transaction.campaignDelivery.findUnique({
					where: { id: event.aggregateId },
					select: { campaignId: true }
				});
				if (identity) {
					await transaction.$executeRaw`
						SELECT pg_advisory_xact_lock(
							hashtextextended(
								${`campaign-aggregate:${identity.campaignId}`},
								0
							)
						)
					`;
					const delivery = await transaction.campaignDelivery.findUnique({
						where: { id: event.aggregateId },
						include: { campaign: true }
					});
					if (
						delivery &&
						delivery.dispatchGeneration === event.generation &&
						delivery.requestEventId === event.messageId &&
						(delivery.status === CampaignDeliveryStatus.PENDING ||
							delivery.status === CampaignDeliveryStatus.PROCESSING)
					) {
						await transaction.campaignDelivery.update({
							where: { id: delivery.id },
							data: {
								status: CampaignDeliveryStatus.FAILED,
								lastErrorCode: 'INVALID_OUTBOX_CONTRACT',
								lastErrorReason:
									'Campaign delivery request failed internal contract validation'
							}
						});
						const campaign = await transaction.campaign.update({
							where: { id: delivery.campaignId },
							data: {
								failedCount: { increment: 1 }
							}
						});
						const active = await transaction.campaignDelivery.count({
							where: {
								campaignId: delivery.campaignId,
								status: {
									in: [
										CampaignDeliveryStatus.PENDING,
										CampaignDeliveryStatus.PROCESSING
									]
								}
							}
						});
						if (active === 0) {
							await transaction.campaign.update({
								where: { id: delivery.campaignId },
								data: {
									status:
										campaign.status === CampaignStatus.CANCEL_REQUESTED
											? CampaignStatus.CANCELLED
											: campaign.sentCount > 0
												? CampaignStatus.PARTIAL_FAILED
												: CampaignStatus.FAILED,
									completedAt: new Date()
								}
							});
						}
					}
				}
			}
			const quarantined = await transaction.campaignOutboxEvent.updateMany(
				{
					where: {
						id: event.id,
						status: CampaignOutboxStatus.PUBLISHING,
						lockedBy: this.workerId,
						lockToken: event.lockToken
					},
					data: {
						status: CampaignOutboxStatus.CANCELLED,
						attempts: { increment: 1 },
						lockedAt: null,
						lockedBy: null,
						lockToken: null,
						leaseExpiresAt: null,
						lastError: `INVALID_OUTBOX_CONTRACT: ${reason}`.slice(0, 4000)
					}
				}
			);
			if (quarantined.count !== 1) {
				throw new Error('Campaigns outbox quarantine claim was lost');
			}
		});
	}

	private release(
		event: ClaimedOutboxEvent
	): Promise<Prisma.BatchPayload> {
		return this.prisma.campaignOutboxEvent.updateMany({
			where: {
				id: event.id,
				status: CampaignOutboxStatus.PUBLISHING,
				lockedBy: this.workerId,
				lockToken: event.lockToken
			},
			data: {
				status: CampaignOutboxStatus.PENDING,
				lockedAt: null,
				lockedBy: null,
				lockToken: null,
				leaseExpiresAt: null
			}
		});
	}

	private exchange(
		exchange: CampaignOutboxExchange
	): CampaignsPublishExchange {
		if (exchange === CampaignOutboxExchange.EVENTS) {
			return EVENTS_EXCHANGE;
		}
		if (exchange === CampaignOutboxExchange.RETRY) {
			return CAMPAIGNS_RETRY_EXCHANGE;
		}
		return DEAD_LETTER_EXCHANGE;
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

	private ratePerSecond(channel: CampaignDeliveryChannel): number {
		const key =
			channel === CampaignDeliveryChannel.EMAIL
				? 'CAMPAIGNS_EMAIL_RATE_PER_SECOND'
				: 'CAMPAIGNS_TELEGRAM_RATE_PER_SECOND';
		const fallback = channel === CampaignDeliveryChannel.EMAIL ? 10 : 5;
		const value = Number(this.config.get<string>(key) || fallback);
		if (!Number.isFinite(value) || value <= 0 || value > 1000) {
			throw new Error(`${key} must be greater than 0 and at most 1000`);
		}
		return value;
	}

	private batchSize(): number {
		const value = Number(
			this.config.get<string>('CAMPAIGNS_OUTBOX_BATCH_SIZE') ||
				DEFAULT_BATCH_SIZE
		);
		return Number.isInteger(value) && value >= 1 && value <= 500
			? value
			: DEFAULT_BATCH_SIZE;
	}

	private pollInterval(): number {
		const value = Number(
			this.config.get<string>('CAMPAIGNS_OUTBOX_POLL_INTERVAL_MS') ||
				DEFAULT_POLL_INTERVAL_MS
		);
		return Number.isInteger(value) && value >= 100 && value <= 60_000
			? value
			: DEFAULT_POLL_INTERVAL_MS;
	}

	private retentionDays(): number {
		const value = Number(
			this.config.get<string>('CAMPAIGNS_OUTBOX_RETENTION_DAYS') || 7
		);
		if (!Number.isInteger(value) || value < 1 || value > 365) {
			throw new Error(
				'CAMPAIGNS_OUTBOX_RETENTION_DAYS must be between 1 and 365'
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

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
