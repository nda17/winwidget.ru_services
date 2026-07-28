import {
	INTEGRATION_KINDS,
	INTEGRATION_ROUTING_KEYS,
	IntegrationKind,
	MONOLITH_INTEGRATION_KINDS,
	MonolithIntegrationKind,
	NOTIFICATION_DELIVERY_KINDS,
	NotificationDeliveryKind
} from '@/messaging/messaging.constants';
import { DailySummaryRequestedEventPayload } from '@/messaging/daily-summary-event';
import { LeadIntegrationEventPayload } from '@/messaging/lead-integration-event';
import {
	classifyIntegrationError,
	IntegrationErrorClassification
} from '@/messaging/integration-error-classifier';
import { MailingDeliveryEventPayload } from '@/messaging/mailing-delivery-event';
import {
	createMessagingHeaders,
	getCurrentCorrelationId
} from '@/messaging/messaging-context';
import { assertMessagingEventContract } from '@/messaging/messaging-event-contract';
import { MessagingHeartbeatService } from '@/messaging/messaging-heartbeat.service';
import { NotificationDeliveryOutcomeEventPayload } from '@/messaging/notification-delivery-event';
import { getStableMessageId } from '@/messaging/poison-message-id';
import { IntegrationDeliveryService } from '@/messaging/integration-delivery.service';
import { RabbitMqService } from '@/messaging/rabbitmq.service';
import { TelegramDestinationUnavailableEventPayload } from '@/messaging/telegram-destination-unavailable-event';
import { PrismaService } from '@/prisma.service';
import {
	ScheduledJobDispatchHandledError,
	ScheduledJobDispatchRejectedError
} from '@/reports/daily-summary-delivery.service';
import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	IntegrationDeliveryReceiptStatus,
	IntegrationErrorCategory,
	MailingCampaignStatus,
	MailingDeliveryStatus,
	Prisma,
	ScheduledJobRunStatus
} from '@prisma/client';
import type { ConsumeMessage } from 'amqplib';
import { randomUUID } from 'crypto';

const DELIVERY_RECEIPT_LEASE_MS = 10 * 60 * 1000;
const DELIVERY_RECOVERY_GRACE_MS = 5_000;
const AUTOMATIC_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 20_000;
const REDACTED_FAILURE_DETAIL = '[redacted after retention]';

type DeliveryClaim =
	| { state: 'claimed'; lockedAt: Date }
	| { state: 'delivered' }
	| { state: 'closed' }
	| { state: 'dead-lettered' }
	| { state: 'deferred' }
	| { state: 'processing'; lockedAt: Date };

type WorkerEventPayload =
	| LeadIntegrationEventPayload
	| MailingDeliveryEventPayload
	| TelegramDestinationUnavailableEventPayload
	| NotificationDeliveryOutcomeEventPayload
	| DailySummaryRequestedEventPayload;

interface ScheduledJobStatusRow {
	jobType: string;
	status: ScheduledJobRunStatus;
	attempts: number;
}

interface DeliveryFailureLockRow {
	resolvedAt: Date | null;
	retryingAt: Date | null;
	activeRetryToken: string | null;
}

interface MessagingRateLimitReservationRow {
	waitMs: number;
}

@Injectable()
export class IntegrationWorkerService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(IntegrationWorkerService.name);
	private readonly receiptCleanupBatchSize = 1000;
	private readonly receiptCleanupMaxBatches = 20;
	private lastReceiptCleanupAt = 0;
	private readonly activeHandlers = new Set<Promise<void>>();
	private shutdownPromise: Promise<void> | null = null;
	private cleanupTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly rabbitMq: RabbitMqService,
		private readonly delivery: IntegrationDeliveryService,
		private readonly configService: ConfigService,
		private readonly prisma: PrismaService,
		private readonly heartbeat: MessagingHeartbeatService
	) {}

	async onModuleInit(): Promise<void> {
		const prefetch = this.getPrefetch();
		const kinds = this.getEnabledKinds();
		for (const kind of kinds) {
			await this.rabbitMq.consume(
				kind,
				message =>
					this.trackHandler(
						() => this.handle(kind, message),
						kind,
						message
					),
				prefetch
			);
			await this.rabbitMq.consumeDeadLetter(
				kind,
				message =>
					this.trackHandler(
						() => this.collectDeadLetter(kind, message),
						kind,
						message
					),
				prefetch
			);
		}
		this.logger.log(
			`Integration consumers started kinds=${kinds.join(',')} prefetch=${prefetch}`
		);
		void this.runCleanup();
		this.cleanupTimer = setInterval(
			() => void this.runCleanup(),
			60 * 60 * 1000
		);
		this.cleanupTimer.unref();
	}

	beforeApplicationShutdown(): Promise<void> {
		if (!this.shutdownPromise) {
			this.shutdownPromise = this.shutdown();
		}
		return this.shutdownPromise;
	}

	private async shutdown(): Promise<void> {
		if (this.cleanupTimer) clearInterval(this.cleanupTimer);
		let consumerCancellationError: unknown = null;
		const drained = await Promise.race([
			(async () => {
				await this.rabbitMq.cancelConsumers().catch(error => {
					consumerCancellationError = error;
				});
				while (this.activeHandlers.size) {
					await Promise.allSettled([...this.activeHandlers]);
				}
				return true;
			})(),
			new Promise<false>(resolve =>
				setTimeout(() => resolve(false), SHUTDOWN_DRAIN_TIMEOUT_MS).unref()
			)
		]);
		if (consumerCancellationError) {
			this.logger.error(
				`Failed to cancel integration consumers during shutdown: ${
					consumerCancellationError instanceof Error
						? consumerCancellationError.message
						: String(consumerCancellationError)
				}`
			);
		}
		if (!drained) {
			this.logger.warn(
				JSON.stringify({
					event: 'integration_worker.shutdown_timeout',
					activeHandlers: this.activeHandlers.size,
					timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS
				})
			);
			return;
		}
		this.logger.log(
			JSON.stringify({ event: 'integration_worker.shutdown_complete' })
		);
	}

	private trackHandler(
		handler: () => Promise<void>,
		kind?: MonolithIntegrationKind,
		message?: ConsumeMessage
	): Promise<void> {
		const promise = handler().then(() => {
			if (!kind || !message) return;
			this.heartbeat.markSuccessfulConsume(kind);
			this.logger.log(
				JSON.stringify({
					event: 'integration_worker.consume_completed',
					kind,
					messageId: message.properties.messageId || null,
					correlationId: getCurrentCorrelationId()
				})
			);
		});
		this.activeHandlers.add(promise);
		void promise.then(
			() => this.activeHandlers.delete(promise),
			() => this.activeHandlers.delete(promise)
		);
		return promise;
	}

	private async handle(
		kind: MonolithIntegrationKind,
		message: ConsumeMessage
	): Promise<void> {
		const eventId = message.properties.messageId;
		if (!this.isUuid(eventId)) {
			await this.deadLetterMalformed(
				kind,
				message,
				'RabbitMQ messageId is missing or invalid'
			);
			return;
		}

		let payload: WorkerEventPayload;
		try {
			payload = this.parsePayload(kind, message);
		} catch (error) {
			await this.deadLetterMalformed(
				kind,
				message,
				error instanceof Error ? error.message : String(error)
			);
			return;
		}

		let receiptClaim: Date | null = null;
		try {
			const claim = await this.claimDelivery(
				eventId,
				kind,
				this.getRetryAttempt(message),
				this.getStringHeader(message, 'x-delivery-token')
			);
			if (claim.state === 'delivered') {
				await this.resolveFailure(eventId, kind);
				this.rabbitMq.ack(message);
				this.logger.warn(
					`Duplicate integration skipped eventId=${eventId} kind=${kind}`
				);
				return;
			}
			if (
				claim.state === 'closed' ||
				claim.state === 'dead-lettered' ||
				claim.state === 'deferred'
			) {
				this.rabbitMq.ack(message);
				this.logger.warn(
					`Integration delivery skipped by receipt state=${claim.state} eventId=${eventId} kind=${kind}`
				);
				return;
			}
			if (claim.state === 'processing') {
				try {
					await this.scheduleClaimRecovery(
						kind,
						payload,
						eventId,
						claim.lockedAt,
						message
					);
					this.rabbitMq.ack(message);
					this.logger.warn(
						`Integration recovery scheduled for an active claim eventId=${eventId} kind=${kind}`
					);
				} catch (error) {
					this.logger.error(
						`Failed to schedule integration claim recovery eventId=${eventId} kind=${kind}: ${
							error instanceof Error ? error.message : String(error)
						}`
					);
					this.rabbitMq.nack(message, true);
				}
				return;
			}
			receiptClaim = claim.lockedAt;

			await this.deliverWithRateLimit(kind, payload, eventId);
			await this.markDeliveryDelivered(eventId, kind, receiptClaim);
			receiptClaim = null;
			await this.runCleanup();
			this.rabbitMq.ack(message);
			this.logger.log(
				`Integration delivered eventId=${eventId} kind=${kind}`
			);
		} catch (error) {
			const lastAttempt = this.getRetryAttempt(message);
			const nextAttempt = lastAttempt + 1;
			const firstFailedAt = this.getFirstFailedAt(message);

			try {
				if (error instanceof ScheduledJobDispatchRejectedError) {
					const classification: IntegrationErrorClassification = {
						category: 'PERMANENT',
						normalizedCode: 'SCHEDULED_JOB_REFERENCE_INVALID',
						retryable: false,
						retryDelayMs: null,
						safeReason: error.message.slice(0, 1000),
						recognized: true,
						mayDisableDestination: false,
						classificationVersion: 1
					};
					await this.rabbitMq.publishDeadLetter(
						kind,
						payload,
						nextAttempt,
						eventId,
						error.message,
						this.getEventType(payload),
						this.getDeadLetterMetadata(
							error,
							classification,
							firstFailedAt,
							this.getStringHeader(message, 'x-delivery-token')
						)
					);
					await this.markDeliveryDeadLettered(eventId, kind, receiptClaim);
					receiptClaim = null;
					this.rabbitMq.ack(message);
					this.logger.error(
						`Scheduled integration rejected eventId=${eventId} kind=${kind}: ${error.message}`
					);
					return;
				}
				if (error instanceof ScheduledJobDispatchHandledError) {
					if (error.state === 'failed') {
						await this.markDeliveryDeadLettered(
							eventId,
							kind,
							receiptClaim
						);
						receiptClaim = null;
						this.logger.error(
							`Scheduled integration terminal DLQ intent persisted eventId=${eventId} kind=${kind}: ${error.message}`
						);
					} else {
						await this.releaseDeliveryClaimIfOwned(
							eventId,
							kind,
							receiptClaim
						);
						receiptClaim = null;
						this.logger.warn(
							`Scheduled integration retry persisted eventId=${eventId} kind=${kind} attempt=${error.job.attempts}: ${error.message}`
						);
					}
					this.rabbitMq.ack(message);
					return;
				}

				let classification = this.classifyDeliveryError(kind, error);
				const retryDelayMs = this.getRetryDelayMs(
					classification,
					nextAttempt
				);
				const retryBudgetAvailable =
					nextAttempt <= this.getMaxRetryPublications(classification);
				const retryWindowAvailable =
					Date.now() + retryDelayMs <=
					firstFailedAt.getTime() + AUTOMATIC_RETRY_WINDOW_MS;
				if (
					classification.retryable &&
					retryBudgetAvailable &&
					retryWindowAvailable
				) {
					const availableAt = await this.scheduleRetry(
						kind,
						payload,
						nextAttempt,
						eventId,
						receiptClaim,
						classification,
						retryDelayMs,
						firstFailedAt
					);
					receiptClaim = null;
					this.logger.warn(
						`Integration retry scheduled eventId=${eventId} kind=${kind} attempt=${nextAttempt} category=${classification.category} code=${classification.normalizedCode} availableAt=${availableAt.toISOString()}`
					);
				} else {
					if (classification.retryable && !retryWindowAvailable) {
						classification = this.getExpiredRetryClassification();
					} else if (classification.retryable && !retryBudgetAvailable) {
						classification = {
							...classification,
							retryable: false,
							retryDelayMs: null,
							safeReason: `${classification.safeReason}; automatic retry budget exhausted`
						};
					}
					await this.rabbitMq.publishDeadLetter(
						kind,
						payload,
						nextAttempt,
						eventId,
						classification.safeReason,
						this.getEventType(payload),
						this.getDeadLetterMetadata(
							error,
							classification,
							firstFailedAt,
							this.getStringHeader(message, 'x-delivery-token')
						)
					);
					await this.markDeliveryDeadLettered(eventId, kind, receiptClaim);
					receiptClaim = null;
					this.logger.error(
						`Integration moved to dead-letter eventId=${eventId} kind=${kind} category=${classification.category} code=${classification.normalizedCode}: ${classification.safeReason}`
					);
				}
				this.rabbitMq.ack(message);
			} catch (failureHandlingError) {
				this.logger.error(
					`Failed to finalize failed delivery eventId=${eventId} kind=${kind}: ${
						failureHandlingError instanceof Error
							? failureHandlingError.message
							: String(failureHandlingError)
					}`
				);
				await this.releaseDeliveryClaimIfOwned(
					eventId,
					kind,
					receiptClaim
				).catch(releaseError => {
					this.logger.error(
						`Failed to release delivery claim after republish error eventId=${eventId} kind=${kind}: ${
							releaseError instanceof Error
								? releaseError.message
								: String(releaseError)
						}`
					);
				});
				this.rabbitMq.nack(message, true);
			}
		}
	}

	private async claimDelivery(
		eventId: string,
		integration: IntegrationKind,
		retryAttempt: number,
		deliveryToken: string | null
	): Promise<DeliveryClaim> {
		const lockedAt = new Date();
		try {
			await this.prisma.integrationDeliveryReceipt.create({
				data: {
					eventId,
					integration,
					status: IntegrationDeliveryReceiptStatus.PROCESSING,
					lockedAt,
					deliveredAt: null,
					retryAttempt: null,
					retryAvailableAt: null,
					retryToken: null
				}
			});
			return { state: 'claimed', lockedAt };
		} catch (error) {
			if (!this.isUniqueConstraintError(error)) throw error;
		}

		const receipt =
			await this.prisma.integrationDeliveryReceipt.findUnique({
				where: {
					eventId_integration: {
						eventId,
						integration
					}
				},
				select: {
					status: true,
					lockedAt: true,
					retryAttempt: true,
					retryAvailableAt: true,
					retryToken: true
				}
			});
		if (!receipt) {
			throw new Error(
				`Integration delivery receipt disappeared eventId=${eventId} kind=${integration}`
			);
		}
		if (receipt.status === IntegrationDeliveryReceiptStatus.DELIVERED) {
			return { state: 'delivered' };
		}
		if (
			receipt.status === IntegrationDeliveryReceiptStatus.CLOSED_NO_RETRY
		) {
			return { state: 'closed' };
		}
		if (
			receipt.status === IntegrationDeliveryReceiptStatus.DEAD_LETTERED
		) {
			return { state: 'dead-lettered' };
		}
		if (
			receipt.status === IntegrationDeliveryReceiptStatus.RETRY_SCHEDULED
		) {
			if (
				receipt.retryAttempt !== retryAttempt ||
				!deliveryToken ||
				!this.isUuid(deliveryToken) ||
				receipt.retryToken !== deliveryToken ||
				!receipt.retryAvailableAt ||
				receipt.retryAvailableAt > lockedAt
			) {
				return { state: 'deferred' };
			}
			const activated =
				await this.prisma.integrationDeliveryReceipt.updateMany({
					where: {
						eventId,
						integration,
						status: IntegrationDeliveryReceiptStatus.RETRY_SCHEDULED,
						retryAttempt,
						retryAvailableAt: receipt.retryAvailableAt,
						retryToken: deliveryToken
					},
					data: {
						status: IntegrationDeliveryReceiptStatus.PROCESSING,
						lockedAt,
						deliveredAt: null,
						retryAttempt: null,
						retryAvailableAt: null,
						retryToken: null
					}
				});
			return activated.count === 1
				? { state: 'claimed', lockedAt }
				: { state: 'deferred' };
		}
		if (
			receipt.lockedAt.getTime() >
			lockedAt.getTime() - DELIVERY_RECEIPT_LEASE_MS
		) {
			return { state: 'processing', lockedAt: receipt.lockedAt };
		}

		const reclaimed =
			await this.prisma.integrationDeliveryReceipt.updateMany({
				where: {
					eventId,
					integration,
					status: IntegrationDeliveryReceiptStatus.PROCESSING,
					lockedAt: receipt.lockedAt
				},
				data: {
					lockedAt,
					retryAttempt: null,
					retryAvailableAt: null,
					retryToken: null
				}
			});
		return reclaimed.count === 1
			? { state: 'claimed', lockedAt }
			: { state: 'deferred' };
	}

	private async markDeliveryDelivered(
		eventId: string,
		integration: IntegrationKind,
		lockedAt: Date
	): Promise<void> {
		await this.prisma.$transaction(async transaction => {
			const delivered =
				await transaction.integrationDeliveryReceipt.updateMany({
					where: {
						eventId,
						integration,
						status: IntegrationDeliveryReceiptStatus.PROCESSING,
						lockedAt
					},
					data: {
						status: IntegrationDeliveryReceiptStatus.DELIVERED,
						deliveredAt: new Date(),
						retryAttempt: null,
						retryAvailableAt: null,
						retryToken: null
					}
				});
			if (delivered.count !== 1) {
				throw new Error(
					`Integration delivery claim was lost eventId=${eventId} kind=${integration}`
				);
			}
			await transaction.integrationDeliveryFailure.updateMany({
				where: { eventId, integration, resolvedAt: null },
				data: {
					resolvedAt: new Date(),
					retryingAt: null,
					resolution: 'DELIVERED',
					resolutionComment: null,
					resolvedById: null,
					activeRetryToken: null
				}
			});
			await transaction.integrationCredentialSnapshot.deleteMany({
				where: { eventId, integration }
			});
		});
	}

	private async markDeliveryDeadLettered(
		eventId: string,
		integration: IntegrationKind,
		lockedAt: Date | null
	): Promise<void> {
		if (!lockedAt) {
			throw new Error(
				`Integration delivery claim is missing before DLQ eventId=${eventId} kind=${integration}`
			);
		}
		const marked = await this.prisma.integrationDeliveryReceipt.updateMany(
			{
				where: {
					eventId,
					integration,
					status: IntegrationDeliveryReceiptStatus.PROCESSING,
					lockedAt
				},
				data: {
					status: IntegrationDeliveryReceiptStatus.DEAD_LETTERED,
					deliveredAt: null,
					retryAttempt: null,
					retryAvailableAt: null,
					retryToken: null
				}
			}
		);
		if (marked.count !== 1) {
			const current =
				await this.prisma.integrationDeliveryReceipt.findUnique({
					where: {
						eventId_integration: { eventId, integration }
					},
					select: { status: true }
				});
			if (
				current?.status === IntegrationDeliveryReceiptStatus.DEAD_LETTERED
			) {
				return;
			}
			throw new Error(
				`Integration delivery claim was lost before DLQ eventId=${eventId} kind=${integration}`
			);
		}
	}

	private async releaseDeliveryClaim(
		eventId: string,
		integration: IntegrationKind,
		lockedAt: Date
	): Promise<void> {
		await this.prisma.integrationDeliveryReceipt.deleteMany({
			where: {
				eventId,
				integration,
				status: IntegrationDeliveryReceiptStatus.PROCESSING,
				lockedAt
			}
		});
	}

	private async releaseDeliveryClaimIfOwned(
		eventId: string,
		integration: IntegrationKind,
		lockedAt: Date | null
	): Promise<void> {
		if (!lockedAt) return;
		await this.releaseDeliveryClaim(eventId, integration, lockedAt);
	}

	private isUniqueConstraintError(error: unknown): boolean {
		return (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === 'P2002'
		);
	}

	private async resolveFailure(
		eventId: string,
		integration: IntegrationKind
	): Promise<void> {
		await this.prisma.$transaction(async transaction => {
			await transaction.integrationDeliveryFailure.updateMany({
				where: {
					eventId,
					integration,
					resolvedAt: null
				},
				data: {
					resolvedAt: new Date(),
					retryingAt: null,
					resolution: 'DELIVERED',
					resolutionComment: null,
					resolvedById: null,
					activeRetryToken: null
				}
			});
			await transaction.integrationCredentialSnapshot.deleteMany({
				where: { eventId, integration }
			});
		});
	}

	private async scheduleRetry(
		integration: IntegrationKind,
		payload: WorkerEventPayload,
		attempt: number,
		eventId: string,
		lockedAt: Date | null,
		classification: IntegrationErrorClassification,
		delayMs: number,
		firstFailedAt: Date
	): Promise<Date> {
		if (!lockedAt) {
			throw new Error(
				`Integration delivery claim is missing before retry eventId=${eventId} kind=${integration}`
			);
		}
		const availableAt = new Date(Date.now() + delayMs);
		const retryToken = randomUUID();

		await this.prisma.$transaction(async transaction => {
			const scheduled =
				await transaction.integrationDeliveryReceipt.updateMany({
					where: {
						eventId,
						integration,
						status: IntegrationDeliveryReceiptStatus.PROCESSING,
						lockedAt
					},
					data: {
						status: IntegrationDeliveryReceiptStatus.RETRY_SCHEDULED,
						deliveredAt: null,
						retryAttempt: attempt,
						retryAvailableAt: availableAt,
						retryToken
					}
				});
			if (scheduled.count !== 1) {
				throw new Error(
					`Integration delivery claim was lost before retry eventId=${eventId} kind=${integration}`
				);
			}
			await transaction.integrationDeliveryFailure.updateMany({
				where: {
					eventId,
					integration,
					resolvedAt: null,
					retryingAt: { not: null }
				},
				data: { activeRetryToken: retryToken }
			});
			await transaction.outboxEvent.create({
				data: {
					messageId: eventId,
					deduplicationKey: `integration:${eventId}:${integration}:retry:${attempt}:${retryToken}`,
					eventType: this.getEventType(payload),
					routingKey: INTEGRATION_ROUTING_KEYS[integration],
					payload: payload as unknown as Prisma.InputJsonValue,
					headers: createMessagingHeaders({
						messageId: eventId,
						causationId: eventId,
						headers: {
							'x-retry-attempt': attempt,
							'x-first-failed-at': firstFailedAt.toISOString(),
							'x-delivery-token': retryToken,
							'x-error-category': classification.category,
							'x-error-code': classification.normalizedCode,
							'x-classification-version':
								classification.classificationVersion
						}
					}),
					availableAt
				}
			});
		});
		return availableAt;
	}

	private async scheduleClaimRecovery(
		integration: IntegrationKind,
		payload: WorkerEventPayload,
		eventId: string,
		lockedAt: Date,
		message: ConsumeMessage
	): Promise<void> {
		const availableAt = new Date(
			Math.max(
				Date.now() + 1000,
				lockedAt.getTime() +
					DELIVERY_RECEIPT_LEASE_MS +
					DELIVERY_RECOVERY_GRACE_MS
			)
		);
		const attempt = this.getRetryAttempt(message);
		const firstFailedAt = this.getFirstFailedAt(message);
		const deliveryToken = this.getStringHeader(
			message,
			'x-delivery-token'
		);
		await this.prisma.$transaction(async transaction => {
			await transaction.outboxEvent.createMany({
				data: [
					{
						messageId: eventId,
						deduplicationKey: `integration:${eventId}:${integration}:claim:${lockedAt.toISOString()}`,
						eventType: this.getEventType(payload),
						routingKey: INTEGRATION_ROUTING_KEYS[integration],
						payload: payload as unknown as Prisma.InputJsonValue,
						headers: createMessagingHeaders({
							messageId: eventId,
							causationId: eventId,
							headers: {
								'x-retry-attempt': attempt,
								'x-first-failed-at': firstFailedAt.toISOString(),
								...(deliveryToken
									? {
											'x-delivery-token': deliveryToken
										}
									: {})
							}
						}),
						availableAt
					}
				],
				skipDuplicates: true
			});
		});
	}

	private classifyDeliveryError(
		kind: IntegrationKind,
		error: unknown
	): IntegrationErrorClassification {
		return classifyIntegrationError(kind, error);
	}

	private getMaxRetryPublications(
		classification: IntegrationErrorClassification
	): number {
		return classification.recognized ? 3 : 1;
	}

	private getRetryDelayMs(
		classification: IntegrationErrorClassification,
		attempt: number
	): number {
		const base = Math.max(1000, classification.retryDelayMs || 30_000);
		const scaled =
			classification.category === 'RATE_LIMIT'
				? base
				: base * 2 ** Math.max(0, attempt - 1);
		const capped = Math.min(24 * 60 * 60 * 1000, scaled);
		const jitter =
			classification.category === 'RATE_LIMIT'
				? Math.random() * 0.1
				: Math.random() * 0.2 - 0.1;
		return Math.max(1000, Math.round(capped * (1 + jitter)));
	}

	private getFirstFailedAt(message: ConsumeMessage): Date {
		const value = this.getStringHeader(message, 'x-first-failed-at');
		const timestamp = value ? Date.parse(value) : Number.NaN;
		const now = Date.now();
		return Number.isFinite(timestamp) && timestamp <= now + 60_000
			? new Date(timestamp)
			: new Date(now);
	}

	private getExpiredRetryClassification(): IntegrationErrorClassification {
		return {
			category: 'PERMANENT',
			normalizedCode: 'AUTOMATIC_RETRY_WINDOW_EXPIRED',
			retryable: false,
			retryDelayMs: null,
			safeReason: 'Automatic retry window expired',
			recognized: true,
			mayDisableDestination: false,
			classificationVersion: 1
		};
	}

	private getStringHeader(
		message: ConsumeMessage,
		name: string
	): string | null {
		const value = message.properties.headers?.[name];
		if (typeof value === 'string') return value;
		if (Buffer.isBuffer(value)) return value.toString('utf8');
		return null;
	}

	private getNumberHeader(
		message: ConsumeMessage,
		name: string
	): number | null {
		const value = Number(message.properties.headers?.[name]);
		return Number.isInteger(value) ? value : null;
	}

	private getBooleanHeader(
		message: ConsumeMessage,
		name: string
	): boolean | null {
		const value = message.properties.headers?.[name];
		if (typeof value === 'boolean') return value;
		if (value === 'true' || value === 1) return true;
		if (value === 'false' || value === 0) return false;
		return null;
	}

	private getDeadLetterMetadata(
		error: unknown,
		classification: IntegrationErrorClassification,
		firstFailedAt?: Date,
		deliveryToken?: string | null
	) {
		const details =
			error && typeof error === 'object'
				? (error as Record<string, unknown>)
				: null;
		const httpStatus = Number(
			details?.httpStatus || details?.status || details?.responseCode
		);
		const providerCode =
			typeof details?.providerCode === 'string'
				? details.providerCode
				: typeof details?.errorCode === 'string' ||
					  typeof details?.errorCode === 'number'
					? String(details.errorCode)
					: typeof details?.code === 'string'
						? details.code
						: null;
		return {
			category: classification.category,
			normalizedCode: classification.normalizedCode,
			safeReason: classification.safeReason,
			httpStatus:
				Number.isInteger(httpStatus) && httpStatus > 0 ? httpStatus : null,
			providerCode,
			retryable: classification.retryable,
			classificationVersion: classification.classificationVersion,
			firstFailedAt: firstFailedAt?.toISOString(),
			deliveryToken: deliveryToken || undefined
		};
	}

	private async cleanupReceiptsIfDue(): Promise<void> {
		const now = Date.now();
		if (now - this.lastReceiptCleanupAt < 24 * 60 * 60 * 1000) return;
		this.lastReceiptCleanupAt = now;
		const configured = Number(
			this.configService.get<string>(
				'INTEGRATION_RECEIPT_RETENTION_DAYS'
			) || 90
		);
		const retentionDays =
			Number.isInteger(configured) && configured >= 30 ? configured : 90;
		const deliveredBefore = new Date(
			now - retentionDays * 24 * 60 * 60 * 1000
		);
		for (let batch = 0; batch < this.receiptCleanupMaxBatches; batch++) {
			const count = await this.prisma.$executeRaw(
				Prisma.sql`
					WITH expired AS (
						SELECT "id"
						FROM "integration_delivery_receipts"
						WHERE "status" = 'DELIVERED'::"IntegrationDeliveryReceiptStatus"
							AND "delivered_at" < ${deliveredBefore}
						ORDER BY "delivered_at" ASC
						LIMIT ${this.receiptCleanupBatchSize}
					)
					DELETE FROM "integration_delivery_receipts" AS receipt
					USING expired
					WHERE receipt."id" = expired."id"
				`
			);
			if (count < this.receiptCleanupBatchSize) break;
		}

		const configuredFailureRetention = Number(
			this.configService.get<string>(
				'INTEGRATION_FAILURE_DETAIL_RETENTION_DAYS'
			) || 30
		);
		const failureRetentionDays =
			Number.isInteger(configuredFailureRetention) &&
			configuredFailureRetention >= 1
				? configuredFailureRetention
				: 30;
		const resolvedBefore = new Date(
			now - failureRetentionDays * 24 * 60 * 60 * 1000
		);
		let redacted = 0;
		for (let batch = 0; batch < this.receiptCleanupMaxBatches; batch++) {
			const count = await this.prisma.$executeRaw(
				Prisma.sql`
					WITH expired AS (
						SELECT "id"
						FROM "integration_delivery_failures"
						WHERE "resolved_at" IS NOT NULL
							AND "resolved_at" < ${resolvedBefore}
							AND (
								"payload" <> '{}'::jsonb
								OR "last_error" <> ${REDACTED_FAILURE_DETAIL}
								OR (
									"safe_reason" IS NOT NULL
									AND "safe_reason" <> ${REDACTED_FAILURE_DETAIL}
								)
							)
						ORDER BY "resolved_at" ASC
						LIMIT ${this.receiptCleanupBatchSize}
					)
					UPDATE "integration_delivery_failures" AS failure
					SET
						"payload" = '{}'::jsonb,
						"last_error" = ${REDACTED_FAILURE_DETAIL},
						"safe_reason" = CASE
							WHEN failure."safe_reason" IS NULL THEN NULL
							ELSE ${REDACTED_FAILURE_DETAIL}
						END,
						"updated_at" = NOW()
					FROM expired
					WHERE failure."id" = expired."id"
				`
			);
			redacted += count;
			if (count < this.receiptCleanupBatchSize) break;
		}
		if (redacted) {
			this.logger.log(
				`Redacted ${redacted} resolved integration failures older than ${failureRetentionDays} days`
			);
		}
	}

	private async runCleanup(): Promise<void> {
		await this.cleanupReceiptsIfDue().catch(error => {
			this.logger.error(
				`Messaging retention cleanup failed: ${
					error instanceof Error ? error.stack : String(error)
				}`
			);
		});
	}

	private parsePayload(
		kind: MonolithIntegrationKind,
		message: ConsumeMessage
	): WorkerEventPayload {
		const value = JSON.parse(
			message.content.toString('utf8')
		) as WorkerEventPayload;
		assertMessagingEventContract(value, {
			eventType:
				typeof message.properties.type === 'string'
					? message.properties.type
					: '',
			routingKey: message.fields.routingKey,
			messageId:
				typeof message.properties.messageId === 'string'
					? message.properties.messageId
					: '',
			kind
		});
		return value;
	}

	private async deadLetterMalformed(
		kind: IntegrationKind,
		message: ConsumeMessage,
		error: string
	): Promise<void> {
		const eventId = getStableMessageId(message, kind);
		const payload = {
			malformed: true,
			contentLength: message.content.length
		};
		const classification: IntegrationErrorClassification = {
			category: 'PERMANENT',
			normalizedCode: 'INVALID_EVENT_PAYLOAD',
			retryable: false,
			retryDelayMs: null,
			safeReason: error.slice(0, 1000),
			recognized: true,
			mayDisableDestination: false,
			classificationVersion: 1
		};

		try {
			await this.rabbitMq.publishDeadLetter(
				kind,
				payload,
				this.getRetryAttempt(message),
				eventId,
				error,
				message.properties.type || 'unknown',
				this.getDeadLetterMetadata(null, classification)
			);
			this.rabbitMq.ack(message);
		} catch {
			this.rabbitMq.nack(message, true);
		}
	}

	private getEventType(payload: WorkerEventPayload): string {
		return payload.eventType;
	}

	private async collectDeadLetter(
		kind: IntegrationKind,
		message: ConsumeMessage
	): Promise<void> {
		const eventId = getStableMessageId(message, kind);
		const rawPayload = message.content.toString('utf8');
		let payload: Prisma.InputJsonValue = {
			malformed: true,
			contentLength: message.content.length
		};
		let parsedPayload: unknown = null;
		try {
			parsedPayload = JSON.parse(rawPayload) as unknown;
		} catch {}
		if (parsedPayload !== null) {
			payload = parsedPayload as Prisma.InputJsonValue;
		}

		const errorHeader = message.properties.headers?.['x-last-error'];
		const lastError =
			typeof errorHeader === 'string'
				? errorHeader
				: Buffer.isBuffer(errorHeader)
					? errorHeader.toString('utf8')
					: 'Integration delivery failed';
		const failedAt = new Date();
		const categoryHeader = this.getStringHeader(
			message,
			'x-error-category'
		);
		const category =
			categoryHeader &&
			Object.values(IntegrationErrorCategory).includes(
				categoryHeader as IntegrationErrorCategory
			)
				? (categoryHeader as IntegrationErrorCategory)
				: null;
		const normalizedCode = this.getStringHeader(message, 'x-error-code');
		const safeReason =
			this.getStringHeader(message, 'x-safe-reason') || lastError;
		const httpStatus = this.getNumberHeader(message, 'x-http-status');
		const providerCode = this.getStringHeader(message, 'x-provider-code');
		const retryable = this.getBooleanHeader(message, 'x-error-retryable');
		const classificationVersion = this.getNumberHeader(
			message,
			'x-classification-version'
		);
		const firstFailedAtHeader = this.getStringHeader(
			message,
			'x-first-failed-at'
		);
		const firstFailedAtTimestamp = firstFailedAtHeader
			? Date.parse(firstFailedAtHeader)
			: Number.NaN;
		const firstFailedAt = Number.isFinite(firstFailedAtTimestamp)
			? new Date(firstFailedAtTimestamp)
			: failedAt;
		const deliveryTokenHeader = this.getStringHeader(
			message,
			'x-delivery-token'
		);
		const deliveryToken =
			deliveryTokenHeader && this.isUuid(deliveryTokenHeader)
				? deliveryTokenHeader
				: null;
		const classificationData = {
			category,
			normalizedCode: normalizedCode?.slice(0, 255) || null,
			safeReason: safeReason.slice(0, 10_000),
			httpStatus,
			providerCode: providerCode?.slice(0, 255) || null,
			retryable,
			classificationVersion,
			firstFailedAt
		};
		const upsert: Prisma.IntegrationDeliveryFailureUpsertArgs = {
			where: {
				eventId_integration: {
					eventId,
					integration: kind
				}
			},
			create: {
				eventId,
				integration: kind,
				routingKey: INTEGRATION_ROUTING_KEYS[kind],
				payload,
				attempts: this.getRetryAttempt(message),
				lastError: lastError.slice(0, 10_000),
				failedAt,
				...classificationData
			},
			update: {
				integration: kind,
				routingKey: INTEGRATION_ROUTING_KEYS[kind],
				payload,
				attempts: this.getRetryAttempt(message),
				lastError: lastError.slice(0, 10_000),
				failedAt,
				activeRetryToken: null,
				retryingAt: null,
				...classificationData
			}
		};

		try {
			let persisted = true;
			if (kind === 'daily-summary-telegram') {
				persisted = await this.persistDailySummaryDeadLetter(
					eventId,
					payload,
					upsert,
					deliveryToken,
					this.getRetryAttempt(message)
				);
			} else {
				persisted = await this.persistIntegrationDeadLetter(
					eventId,
					kind,
					upsert,
					deliveryToken
				);
			}
			if (!persisted) {
				this.rabbitMq.ack(message);
				this.logger.warn(
					`Skipped stale or resolved dead-letter eventId=${eventId} kind=${kind}`
				);
				return;
			}
			await this.markMailingDeliveryFailed(kind, payload, lastError);
			this.rabbitMq.ack(message);
			this.logger.error(
				`Dead-letter persisted eventId=${eventId} kind=${kind}`
			);
		} catch (error) {
			this.logger.error(
				`Failed to persist dead-letter eventId=${eventId} kind=${kind}: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
			this.rabbitMq.nack(message, true);
		}
	}

	private async persistIntegrationDeadLetter(
		eventId: string,
		kind: IntegrationKind,
		upsert: Prisma.IntegrationDeliveryFailureUpsertArgs,
		deliveryToken: string | null
	): Promise<boolean> {
		return this.prisma.$transaction(async transaction => {
			const failures = await this.lockDeliveryFailure(
				transaction,
				eventId,
				kind
			);
			if (!this.canPersistDeadLetter(failures[0], deliveryToken)) {
				return false;
			}
			if (
				!(await this.ensureDeadLetterReceipt(transaction, eventId, kind))
			) {
				return false;
			}
			await transaction.integrationDeliveryFailure.upsert(upsert);
			return true;
		});
	}

	private async persistDailySummaryDeadLetter(
		eventId: string,
		payload: Prisma.InputJsonValue,
		upsert: Prisma.IntegrationDeliveryFailureUpsertArgs,
		deliveryToken: string | null,
		retryAttempt: number
	): Promise<boolean> {
		const jobId = this.getDailySummaryJobId(payload);
		return this.prisma.$transaction(async transaction => {
			const failures = await this.lockDeliveryFailure(
				transaction,
				eventId,
				'daily-summary-telegram'
			);
			const jobs = jobId
				? await transaction.$queryRaw<ScheduledJobStatusRow[]>(
						Prisma.sql`
							SELECT
								"job_type" AS "jobType",
								"status",
								"attempts"
							FROM "scheduled_job_runs"
							WHERE "id" = ${jobId}::uuid
							FOR SHARE
						`
					)
				: [];
			if (
				jobs[0] &&
				eventId === jobId &&
				jobs[0].jobType === 'DAILY_TELEGRAM_SUMMARY' &&
				(jobs[0].status !== ScheduledJobRunStatus.FAILED ||
					jobs[0].attempts !== retryAttempt)
			) {
				return false;
			}
			if (!this.canPersistDeadLetter(failures[0], deliveryToken, true)) {
				return false;
			}
			if (
				!(await this.ensureDeadLetterReceipt(
					transaction,
					eventId,
					'daily-summary-telegram'
				))
			) {
				return false;
			}
			await transaction.integrationDeliveryFailure.upsert(upsert);
			return true;
		});
	}

	private lockDeliveryFailure(
		transaction: Prisma.TransactionClient,
		eventId: string,
		integration: IntegrationKind
	): Promise<DeliveryFailureLockRow[]> {
		return transaction.$queryRaw<DeliveryFailureLockRow[]>(
			Prisma.sql`
				SELECT
					"resolved_at" AS "resolvedAt",
					"retrying_at" AS "retryingAt",
					"active_retry_token" AS "activeRetryToken"
				FROM "integration_delivery_failures"
				WHERE "event_id" = ${eventId}::uuid
					AND "integration" = ${integration}
				FOR UPDATE
			`
		);
	}

	private canPersistDeadLetter(
		failure: DeliveryFailureLockRow | undefined,
		deliveryToken: string | null,
		allowTokenlessRetry = false
	): boolean {
		if (!failure) return true;
		if (failure.resolvedAt) return false;
		if (
			failure.retryingAt &&
			failure.activeRetryToken &&
			failure.activeRetryToken !== deliveryToken &&
			!(allowTokenlessRetry && deliveryToken === null)
		) {
			return false;
		}
		return true;
	}

	private async ensureDeadLetterReceipt(
		transaction: Prisma.TransactionClient,
		eventId: string,
		integration: IntegrationKind
	): Promise<boolean> {
		const rows = await transaction.$queryRaw<Array<{ id: string }>>(
			Prisma.sql`
				INSERT INTO "integration_delivery_receipts" (
					"id",
					"event_id",
					"integration",
					"status",
					"locked_at",
					"delivered_at",
					"retry_attempt",
					"retry_available_at",
					"retry_token",
					"created_at"
				)
				VALUES (
					${randomUUID()}::uuid,
					${eventId}::uuid,
					${integration},
					'DEAD_LETTERED'::"IntegrationDeliveryReceiptStatus",
					NOW(),
					NULL,
					NULL,
					NULL,
					NULL,
					NOW()
				)
				ON CONFLICT ("event_id", "integration") DO UPDATE
				SET
					"status" = 'DEAD_LETTERED'::"IntegrationDeliveryReceiptStatus",
					"locked_at" = NOW(),
					"delivered_at" = NULL,
					"retry_attempt" = NULL,
					"retry_available_at" = NULL,
					"retry_token" = NULL
				WHERE "integration_delivery_receipts"."status" IN (
					'PROCESSING'::"IntegrationDeliveryReceiptStatus",
					'RETRY_SCHEDULED'::"IntegrationDeliveryReceiptStatus",
					'DEAD_LETTERED'::"IntegrationDeliveryReceiptStatus"
				)
				RETURNING "id"
			`
		);
		return rows.length === 1;
	}

	private getDailySummaryJobId(
		payload: Prisma.InputJsonValue
	): string | null {
		if (
			payload &&
			typeof payload === 'object' &&
			!Array.isArray(payload)
		) {
			const jobId = (payload as Record<string, unknown>).jobId;
			if (this.isUuid(jobId)) return jobId;
		}
		return null;
	}

	private async deliverWithRateLimit(
		kind: MonolithIntegrationKind,
		payload: WorkerEventPayload,
		eventId: string
	): Promise<void> {
		const intervalMs = this.getRateLimitInterval(kind);
		if (
			!intervalMs ||
			(await this.shouldBypassMailingRateLimit(kind, payload))
		) {
			await this.delivery.deliver(kind, payload, eventId);
			return;
		}

		const waitMs = await this.reserveRateLimitSlot(kind, intervalMs);
		if (waitMs > 0) {
			await new Promise<void>(resolve => {
				setTimeout(resolve, waitMs);
			});
		}
		await this.delivery.deliver(kind, payload, eventId);
	}

	private async reserveRateLimitSlot(
		key: string,
		intervalMs: number
	): Promise<number> {
		const [reservation] = await this.prisma.$queryRaw<
			MessagingRateLimitReservationRow[]
		>(
			Prisma.sql`
				WITH "reservation" AS (
					INSERT INTO "messaging_rate_limits" (
						"key",
						"next_available_at",
						"updated_at"
					)
					VALUES (
						${key},
						LOCALTIMESTAMP + ${intervalMs} * INTERVAL '1 millisecond',
						LOCALTIMESTAMP
					)
					ON CONFLICT ("key") DO UPDATE
					SET
						"next_available_at" =
							GREATEST(
								"messaging_rate_limits"."next_available_at",
								LOCALTIMESTAMP
							) + ${intervalMs} * INTERVAL '1 millisecond',
						"updated_at" = LOCALTIMESTAMP
					RETURNING
						"next_available_at" -
							${intervalMs} * INTERVAL '1 millisecond'
							AS "available_at"
				)
				SELECT
					GREATEST(
						0,
						CEIL(
							EXTRACT(
								EPOCH FROM ("available_at" - LOCALTIMESTAMP)
							) * 1000
						)
					)::integer AS "waitMs"
				FROM "reservation"
			`
		);
		if (!reservation) {
			throw new Error(
				`Failed to reserve messaging rate-limit slot for ${key}`
			);
		}
		return reservation.waitMs;
	}

	private async shouldBypassMailingRateLimit(
		kind: IntegrationKind,
		payload: WorkerEventPayload
	): Promise<boolean> {
		if (kind !== 'mailing-email' && kind !== 'mailing-telegram') {
			return false;
		}

		const deliveryId = (payload as MailingDeliveryEventPayload).deliveryId;
		if (!deliveryId) return true;
		const delivery = await this.prisma.mailingDelivery.findUnique({
			where: { id: deliveryId },
			select: {
				status: true,
				updatedAt: true,
				campaign: {
					select: {
						status: true,
						cancelRequestedAt: true
					}
				}
			}
		});
		if (!delivery) return true;
		if (
			delivery.campaign.status === MailingCampaignStatus.CANCELLED ||
			delivery.campaign.cancelRequestedAt
		) {
			return true;
		}
		if (delivery.status === MailingDeliveryStatus.PENDING) return false;
		if (delivery.status === MailingDeliveryStatus.PROCESSING) {
			return (
				delivery.updatedAt.getTime() >
				Date.now() - DELIVERY_RECEIPT_LEASE_MS
			);
		}
		return true;
	}

	private getRateLimitInterval(kind: IntegrationKind): number {
		const key =
			kind === 'mailing-email'
				? 'MAILING_EMAIL_RATE_PER_SECOND'
				: kind === 'mailing-telegram'
					? 'MAILING_TELEGRAM_RATE_PER_SECOND'
					: null;
		if (!key) return 0;
		const fallback = kind === 'mailing-email' ? 5 : 10;
		const configured = Number(
			this.configService.get<string>(key) || fallback
		);
		const rate =
			Number.isFinite(configured) && configured > 0
				? Math.min(configured, 50)
				: fallback;
		return Math.ceil(1000 / rate);
	}

	private async markMailingDeliveryFailed(
		kind: IntegrationKind,
		payload: Prisma.InputJsonValue,
		lastError: string
	): Promise<void> {
		if (kind !== 'mailing-email' && kind !== 'mailing-telegram') return;
		const deliveryId = (payload as { deliveryId?: string }).deliveryId;
		const campaignId = (payload as { campaignId?: string }).campaignId;
		if (!deliveryId || !campaignId) return;

		await this.prisma.$transaction(async transaction => {
			const failed = await transaction.mailingDelivery.updateMany({
				where: {
					id: deliveryId,
					campaignId,
					status: {
						in: [
							MailingDeliveryStatus.PENDING,
							MailingDeliveryStatus.PROCESSING
						]
					}
				},
				data: {
					status: MailingDeliveryStatus.FAILED,
					lastError: lastError.slice(0, 10_000)
				}
			});
			if (failed.count !== 1) return;
			await transaction.mailingCampaign.update({
				where: { id: campaignId },
				data: { failedCount: { increment: 1 } }
			});
			const pending = await transaction.mailingDelivery.count({
				where: {
					campaignId,
					status: {
						in: [
							MailingDeliveryStatus.PENDING,
							MailingDeliveryStatus.PROCESSING
						]
					}
				}
			});
			if (pending !== 0) return;
			await transaction.mailingCampaign.updateMany({
				where: {
					id: campaignId,
					status: { not: MailingCampaignStatus.CANCELLED }
				},
				data: {
					status: MailingCampaignStatus.PARTIAL_FAILED,
					completedAt: new Date()
				}
			});
		});
	}

	private getRetryAttempt(message: ConsumeMessage): number {
		const value = Number(message.properties.headers?.['x-retry-attempt']);
		return Number.isInteger(value) && value >= 0 ? value : 0;
	}

	private isUuid(value: unknown): value is string {
		return (
			typeof value === 'string' &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				value
			)
		);
	}

	private getPrefetch(): number {
		const value = Number(
			this.configService.get<string>('RABBITMQ_WORKER_PREFETCH') || 10
		);
		return Number.isInteger(value) && value > 0
			? Math.min(value, 100)
			: 10;
	}

	private getEnabledKinds(): MonolithIntegrationKind[] {
		const configured = this.configService
			.get<string>('INTEGRATION_WORKER_KINDS')
			?.split(',')
			.map(value => value.trim())
			.filter(Boolean);

		if (!configured?.length) return [...MONOLITH_INTEGRATION_KINDS];

		const invalid = configured.filter(
			value => !INTEGRATION_KINDS.includes(value as IntegrationKind)
		);
		if (invalid.length) {
			throw new Error(
				`Invalid INTEGRATION_WORKER_KINDS values: ${invalid.join(', ')}`
			);
		}

		const extracted = configured.filter(value =>
			NOTIFICATION_DELIVERY_KINDS.includes(
				value as NotificationDeliveryKind
			)
		);
		if (extracted.length) {
			throw new Error(
				`INTEGRATION_WORKER_KINDS cannot include notification-delivery kinds: ${extracted.join(', ')}`
			);
		}

		return [...new Set(configured as MonolithIntegrationKind[])];
	}
}
