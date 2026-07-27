import {
	getDeadLetterRoutingKey,
	getManualRetryRoutingKey,
	MESSAGING_ROUTING_KEYS,
	NotificationDeliveryKind,
	NOTIFICATION_DELIVERY_KINDS
} from '../messaging/messaging.constants';
import { createMessagingHeaders } from '../messaging/messaging-context';
import {
	classifyIntegrationError,
	IntegrationErrorClassification
} from '../messaging/integration-error-classifier';
import { getStableMessageId } from '../messaging/poison-message-id';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { NotificationDeliveryAdapterService } from './notification-delivery-adapter.service';
import { NotificationDeliveryHeartbeatService } from './notification-delivery-heartbeat.service';
import {
	getScalarMessageHeaders,
	NotificationDeliveryEventPayload,
	parseNotificationDeliveryMessage
} from './notification-delivery-contract';
import { NotificationDeliveryPrismaService } from './prisma/notification-delivery-prisma.service';
import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	NotificationDeliveryErrorCategory,
	NotificationDeliveryExchange,
	NotificationDeliveryFailureResolution,
	NotificationDeliveryReceiptStatus,
	Prisma
} from '@prisma/notification-delivery-client';
import type { ConsumeMessage } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const DELIVERY_RECEIPT_LEASE_MS = 10 * 60 * 1000;
const DELIVERY_RECOVERY_GRACE_MS = 5_000;
const AUTOMATIC_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 20_000;
const MAX_FAILURE_TEXT_LENGTH = 10_000;
const MAX_SAFE_REASON_LENGTH = 2_000;
const INVALID_EVENT_PAYLOAD_CODE = 'INVALID_EVENT_PAYLOAD';
const INVALID_EVENT_PAYLOAD_SAFE_REASON =
	'Notification payload failed contract validation';
const SAFE_HEADER_NAMES = new Set([
	'x-correlation-id',
	'x-request-id',
	'x-causation-id',
	'x-retry-attempt',
	'x-first-failed-at',
	'x-delivery-token',
	'x-last-error',
	'x-error-category',
	'x-error-code',
	'x-safe-reason',
	'x-error-retryable',
	'x-classification-version',
	'x-http-status',
	'x-provider-code'
]);

type DeliveryClaim =
	| { state: 'claimed'; lockToken: string }
	| { state: 'delivered' }
	| { state: 'closed' }
	| { state: 'dead-lettered' }
	| { state: 'deferred' }
	| {
			state: 'processing';
			lockToken: string;
			leaseExpiresAt: Date;
	  };

interface FailureMetadata {
	httpStatus: number | null;
	providerCode: string | null;
}

@Injectable()
export class NotificationDeliveryWorkerService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(
		NotificationDeliveryWorkerService.name
	);
	private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private readonly activeHandlers = new Set<Promise<void>>();
	private shutdownPromise: Promise<void> | null = null;
	private ready = false;
	private shuttingDown = false;

	constructor(
		private readonly rabbitMq: RabbitMqService,
		private readonly adapter: NotificationDeliveryAdapterService,
		private readonly prisma: NotificationDeliveryPrismaService,
		private readonly configService: ConfigService,
		private readonly heartbeat: NotificationDeliveryHeartbeatService
	) {}

	async onModuleInit(): Promise<void> {
		const prefetch = this.getPrefetch();
		for (const kind of NOTIFICATION_DELIVERY_KINDS) {
			await this.rabbitMq.consume(
				kind,
				message =>
					this.trackHandler(() => this.handle(kind, message), kind),
				prefetch
			);
			await this.rabbitMq.consumeDeadLetter(
				kind,
				message =>
					this.trackHandler(
						() => this.collectDeadLetter(kind, message),
						kind
					),
				prefetch
			);
		}
		this.ready = true;
		this.logger.log(
			`Notification delivery consumers started kinds=${NOTIFICATION_DELIVERY_KINDS.join(',')} prefetch=${prefetch}`
		);
	}

	isReady(): boolean {
		return this.ready && !this.shuttingDown;
	}

	beforeApplicationShutdown(): Promise<void> {
		this.shutdownPromise ??= this.shutdown();
		return this.shutdownPromise;
	}

	private async shutdown(): Promise<void> {
		this.ready = false;
		this.shuttingDown = true;
		let cancellationError: unknown = null;

		const drained = await Promise.race([
			(async () => {
				await this.rabbitMq.cancelConsumers().catch(error => {
					cancellationError = error;
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

		if (cancellationError) {
			this.logger.error(
				`Failed to cancel notification consumers: ${this.errorMessage(
					cancellationError
				)}`
			);
		}
		if (!drained) {
			this.logger.warn(
				JSON.stringify({
					event: 'notification_delivery.shutdown_timeout',
					activeHandlers: this.activeHandlers.size,
					timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS
				})
			);
			return;
		}
		this.logger.log(
			JSON.stringify({ event: 'notification_delivery.shutdown_complete' })
		);
	}

	private trackHandler(
		handler: () => Promise<void>,
		kind: NotificationDeliveryKind
	): Promise<void> {
		const promise = handler().catch(error => {
			this.logger.error(
				`Unhandled notification delivery error kind=${kind}: ${
					error instanceof Error ? error.stack : String(error)
				}`
			);
			throw error;
		});
		this.activeHandlers.add(promise);
		void promise.then(
			() => this.activeHandlers.delete(promise),
			() => this.activeHandlers.delete(promise)
		);
		return promise;
	}

	private async handle(
		kind: NotificationDeliveryKind,
		message: ConsumeMessage
	): Promise<void> {
		let parsed: ReturnType<typeof parseNotificationDeliveryMessage>;
		try {
			parsed = parseNotificationDeliveryMessage(kind, message);
		} catch {
			await this.deadLetterMalformed(kind, message);
			return;
		}

		const {
			eventId,
			eventType,
			payload,
			retryAttempt,
			firstFailedAt,
			deliveryToken
		} = parsed;
		let claim: Extract<DeliveryClaim, { state: 'claimed' }> | null = null;

		try {
			const result = await this.claimDelivery(
				eventId,
				kind,
				retryAttempt,
				deliveryToken
			);
			if (result.state === 'delivered') {
				this.ackMessage(message);
				this.logger.warn(
					`Duplicate notification skipped eventId=${eventId} kind=${kind}`
				);
				return;
			}
			if (
				result.state === 'closed' ||
				result.state === 'dead-lettered' ||
				result.state === 'deferred'
			) {
				this.ackMessage(message);
				this.logger.warn(
					`Notification skipped by receipt state=${result.state} eventId=${eventId} kind=${kind}`
				);
				return;
			}
			if (result.state === 'processing') {
				await this.scheduleClaimRecovery(
					kind,
					payload,
					eventId,
					eventType,
					result,
					message
				);
				this.ackMessage(message);
				this.logger.warn(
					`Notification recovery scheduled for active claim eventId=${eventId} kind=${kind}`
				);
				return;
			}
			claim = result;
		} catch (error) {
			this.logger.error(
				`Failed to claim notification eventId=${eventId} kind=${kind}: ${this.errorMessage(
					error
				)}`
			);
			this.rabbitMq.nack(message, true);
			return;
		}

		try {
			await this.adapter.deliver(kind, payload, eventId);
		} catch (deliveryError) {
			await this.handleDeliveryFailure({
				kind,
				message,
				eventId,
				eventType,
				payload,
				retryAttempt,
				firstFailedAt,
				claim,
				error: deliveryError
			});
			return;
		}

		try {
			await this.markDelivered(eventId, kind, claim.lockToken);
			this.ackMessage(message);
			this.logger.log(
				`Notification delivered eventId=${eventId} kind=${kind}`
			);
		} catch (error) {
			this.logger.error(
				`Provider succeeded but delivery receipt finalization failed eventId=${eventId} kind=${kind}: ${this.errorMessage(
					error
				)}`
			);
			this.rabbitMq.nack(message, true);
		}
	}

	private async handleDeliveryFailure(input: {
		kind: NotificationDeliveryKind;
		message: ConsumeMessage;
		eventId: string;
		eventType: string;
		payload: NotificationDeliveryEventPayload;
		retryAttempt: number;
		firstFailedAt: Date;
		claim: Extract<DeliveryClaim, { state: 'claimed' }>;
		error: unknown;
	}): Promise<void> {
		const nextAttempt = input.retryAttempt + 1;
		let classification = classifyIntegrationError(input.kind, input.error);
		const retryDelayMs = this.getRetryDelayMs(classification, nextAttempt);
		const retryBudgetAvailable =
			nextAttempt <= this.getMaxRetryPublications(classification);
		const retryWindowAvailable =
			Date.now() + retryDelayMs <=
			input.firstFailedAt.getTime() + AUTOMATIC_RETRY_WINDOW_MS;

		try {
			if (
				classification.retryable &&
				retryBudgetAvailable &&
				retryWindowAvailable
			) {
				const availableAt = await this.scheduleRetry({
					...input,
					attempt: nextAttempt,
					classification,
					delayMs: retryDelayMs
				});
				this.ackMessage(input.message);
				this.logger.warn(
					`Notification retry scheduled eventId=${input.eventId} kind=${input.kind} attempt=${nextAttempt} category=${classification.category} code=${classification.normalizedCode} availableAt=${availableAt.toISOString()}`
				);
				return;
			}

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

			await this.moveToDeadLetter({
				...input,
				attempt: nextAttempt,
				classification
			});
			this.ackMessage(input.message);
			this.logger.error(
				`Notification moved to dead-letter eventId=${input.eventId} kind=${input.kind} category=${classification.category} code=${classification.normalizedCode}: ${classification.safeReason}`
			);
		} catch (finalizationError) {
			this.logger.error(
				`Failed to finalize notification failure eventId=${input.eventId} kind=${input.kind}: ${this.errorMessage(
					finalizationError
				)}`
			);
			await this.releaseClaim(
				input.eventId,
				input.kind,
				input.claim.lockToken
			).catch(releaseError => {
				this.logger.error(
					`Failed to release notification claim eventId=${input.eventId} kind=${input.kind}: ${this.errorMessage(
						releaseError
					)}`
				);
			});
			this.rabbitMq.nack(input.message, true);
		}
	}

	private async claimDelivery(
		eventId: string,
		consumer: NotificationDeliveryKind,
		retryAttempt: number,
		deliveryToken: string | null
	): Promise<DeliveryClaim> {
		const now = new Date();
		const lockToken = randomUUID();
		const leaseExpiresAt = new Date(
			now.getTime() + DELIVERY_RECEIPT_LEASE_MS
		);

		try {
			await this.prisma.notificationDeliveryReceipt.create({
				data: {
					eventId,
					consumer,
					status: NotificationDeliveryReceiptStatus.PROCESSING,
					lockedAt: now,
					lockedBy: this.workerId,
					lockToken,
					leaseExpiresAt
				}
			});
			return { state: 'claimed', lockToken };
		} catch (error) {
			if (!this.isUniqueConstraintError(error)) throw error;
		}

		const receipt =
			await this.prisma.notificationDeliveryReceipt.findUnique({
				where: {
					eventId_consumer: { eventId, consumer }
				}
			});
		if (!receipt) {
			throw new Error(
				`Notification receipt disappeared eventId=${eventId} kind=${consumer}`
			);
		}
		if (receipt.status === NotificationDeliveryReceiptStatus.DELIVERED) {
			return { state: 'delivered' };
		}
		if (
			receipt.status === NotificationDeliveryReceiptStatus.CLOSED_NO_RETRY
		) {
			return { state: 'closed' };
		}
		if (
			receipt.status === NotificationDeliveryReceiptStatus.DEAD_LETTERED
		) {
			return { state: 'dead-lettered' };
		}

		if (
			receipt.status === NotificationDeliveryReceiptStatus.RETRY_SCHEDULED
		) {
			if (
				receipt.retryAttempt !== retryAttempt ||
				!deliveryToken ||
				receipt.retryToken !== deliveryToken ||
				!receipt.retryAvailableAt ||
				receipt.retryAvailableAt > now
			) {
				return { state: 'deferred' };
			}

			const activated =
				await this.prisma.notificationDeliveryReceipt.updateMany({
					where: {
						eventId,
						consumer,
						status: NotificationDeliveryReceiptStatus.RETRY_SCHEDULED,
						retryAttempt,
						retryAvailableAt: receipt.retryAvailableAt,
						retryToken: deliveryToken
					},
					data: {
						status: NotificationDeliveryReceiptStatus.PROCESSING,
						lockedAt: now,
						lockedBy: this.workerId,
						lockToken,
						leaseExpiresAt,
						deliveredAt: null,
						retryAttempt: null,
						retryAvailableAt: null,
						retryToken: null
					}
				});
			return activated.count === 1
				? { state: 'claimed', lockToken }
				: { state: 'deferred' };
		}

		if (
			!receipt.lockToken ||
			!receipt.leaseExpiresAt ||
			receipt.leaseExpiresAt > now
		) {
			if (!receipt.lockToken || !receipt.leaseExpiresAt) {
				throw new Error(
					`Notification PROCESSING receipt is missing lease fields eventId=${eventId} kind=${consumer}`
				);
			}
			return {
				state: 'processing',
				lockToken: receipt.lockToken,
				leaseExpiresAt: receipt.leaseExpiresAt
			};
		}

		const reclaimed =
			await this.prisma.notificationDeliveryReceipt.updateMany({
				where: {
					eventId,
					consumer,
					status: NotificationDeliveryReceiptStatus.PROCESSING,
					lockToken: receipt.lockToken,
					leaseExpiresAt: { lte: now }
				},
				data: {
					lockedAt: now,
					lockedBy: this.workerId,
					lockToken,
					leaseExpiresAt,
					deliveredAt: null,
					retryAttempt: null,
					retryAvailableAt: null,
					retryToken: null
				}
			});
		return reclaimed.count === 1
			? { state: 'claimed', lockToken }
			: { state: 'deferred' };
	}

	private async markDelivered(
		eventId: string,
		consumer: NotificationDeliveryKind,
		lockToken: string
	): Promise<void> {
		await this.prisma.$transaction(async transaction => {
			const now = new Date();
			const delivered =
				await transaction.notificationDeliveryReceipt.updateMany({
					where: {
						eventId,
						consumer,
						status: NotificationDeliveryReceiptStatus.PROCESSING,
						lockedBy: this.workerId,
						lockToken
					},
					data: {
						status: NotificationDeliveryReceiptStatus.DELIVERED,
						lockedAt: null,
						lockedBy: null,
						lockToken: null,
						leaseExpiresAt: null,
						deliveredAt: now,
						retryAttempt: null,
						retryAvailableAt: null,
						retryToken: null
					}
				});
			if (delivered.count !== 1) {
				throw new Error(
					`Notification delivery claim was lost eventId=${eventId} kind=${consumer}`
				);
			}
			await transaction.notificationDeliveryFailure.updateMany({
				where: { eventId, consumer, resolvedAt: null },
				data: {
					resolvedAt: now,
					resolution: NotificationDeliveryFailureResolution.DELIVERED,
					resolutionComment: null,
					resolvedById: null,
					retryingAt: null,
					activeRetryToken: null
				}
			});
		});
	}

	private async scheduleRetry(input: {
		kind: NotificationDeliveryKind;
		message: ConsumeMessage;
		eventId: string;
		eventType: string;
		payload: NotificationDeliveryEventPayload;
		firstFailedAt: Date;
		claim: Extract<DeliveryClaim, { state: 'claimed' }>;
		error: unknown;
		attempt: number;
		classification: IntegrationErrorClassification;
		delayMs: number;
	}): Promise<Date> {
		const availableAt = new Date(Date.now() + input.delayMs);
		const retryToken = randomUUID();
		const failureMetadata = this.getFailureMetadata(input.error);
		const headers = this.getFailureHeaders(
			input.message,
			input.eventId,
			input.attempt,
			input.firstFailedAt,
			input.classification,
			failureMetadata,
			retryToken
		);

		await this.prisma.$transaction(async transaction => {
			const scheduled =
				await transaction.notificationDeliveryReceipt.updateMany({
					where: {
						eventId: input.eventId,
						consumer: input.kind,
						status: NotificationDeliveryReceiptStatus.PROCESSING,
						lockedBy: this.workerId,
						lockToken: input.claim.lockToken
					},
					data: {
						status: NotificationDeliveryReceiptStatus.RETRY_SCHEDULED,
						lockedAt: null,
						lockedBy: null,
						lockToken: null,
						leaseExpiresAt: null,
						deliveredAt: null,
						retryAttempt: input.attempt,
						retryAvailableAt: availableAt,
						retryToken
					}
				});
			if (scheduled.count !== 1) {
				throw new Error(
					`Notification claim was lost before retry eventId=${input.eventId} kind=${input.kind}`
				);
			}

			await this.upsertFailure(transaction, {
				...input,
				headers,
				failureMetadata,
				retryingAt: availableAt,
				activeRetryToken: retryToken
			});
			await transaction.notificationDeliveryOutboxEvent.create({
				data: {
					messageId: input.eventId,
					deduplicationKey: `notification:${input.eventId}:${input.kind}:retry:${input.attempt}:${retryToken}`,
					exchange: NotificationDeliveryExchange.EVENTS,
					eventType: input.eventType,
					routingKey: getManualRetryRoutingKey(input.kind),
					payload: input.payload as unknown as Prisma.InputJsonValue,
					headers,
					availableAt
				}
			});
		});

		return availableAt;
	}

	private async moveToDeadLetter(input: {
		kind: NotificationDeliveryKind;
		message: ConsumeMessage;
		eventId: string;
		eventType: string;
		payload: NotificationDeliveryEventPayload;
		firstFailedAt: Date;
		claim: Extract<DeliveryClaim, { state: 'claimed' }>;
		error: unknown;
		attempt: number;
		classification: IntegrationErrorClassification;
	}): Promise<void> {
		const failureMetadata = this.getFailureMetadata(input.error);
		const headers = this.getFailureHeaders(
			input.message,
			input.eventId,
			input.attempt,
			input.firstFailedAt,
			input.classification,
			failureMetadata
		);

		await this.prisma.$transaction(async transaction => {
			const marked =
				await transaction.notificationDeliveryReceipt.updateMany({
					where: {
						eventId: input.eventId,
						consumer: input.kind,
						status: NotificationDeliveryReceiptStatus.PROCESSING,
						lockedBy: this.workerId,
						lockToken: input.claim.lockToken
					},
					data: {
						status: NotificationDeliveryReceiptStatus.DEAD_LETTERED,
						lockedAt: null,
						lockedBy: null,
						lockToken: null,
						leaseExpiresAt: null,
						deliveredAt: null,
						retryAttempt: null,
						retryAvailableAt: null,
						retryToken: null
					}
				});
			if (marked.count !== 1) {
				throw new Error(
					`Notification claim was lost before dead-letter eventId=${input.eventId} kind=${input.kind}`
				);
			}

			await this.upsertFailure(transaction, {
				...input,
				headers,
				failureMetadata,
				retryingAt: null,
				activeRetryToken: null
			});
			await transaction.notificationDeliveryOutboxEvent.create({
				data: {
					messageId: input.eventId,
					deduplicationKey: `notification:${input.eventId}:${input.kind}:dead-letter:${input.attempt}:${input.claim.lockToken}`,
					exchange: NotificationDeliveryExchange.DEAD_LETTER,
					eventType: input.eventType,
					routingKey: getDeadLetterRoutingKey(input.kind),
					payload: input.payload as unknown as Prisma.InputJsonValue,
					headers
				}
			});
		});
	}

	private async scheduleClaimRecovery(
		kind: NotificationDeliveryKind,
		payload: NotificationDeliveryEventPayload,
		eventId: string,
		eventType: string,
		claim: Extract<DeliveryClaim, { state: 'processing' }>,
		message: ConsumeMessage
	): Promise<void> {
		const availableAt = new Date(
			Math.max(
				Date.now() + 1000,
				claim.leaseExpiresAt.getTime() + DELIVERY_RECOVERY_GRACE_MS
			)
		);
		const incoming = getScalarMessageHeaders(message);
		const headers = createMessagingHeaders({
			messageId: eventId,
			causationId: eventId,
			headers: this.filterSafeHeaders(incoming)
		}) as Prisma.InputJsonObject;

		await this.prisma.notificationDeliveryOutboxEvent.createMany({
			data: [
				{
					messageId: eventId,
					deduplicationKey: `notification:${eventId}:${kind}:claim:${claim.lockToken}`,
					exchange: NotificationDeliveryExchange.EVENTS,
					eventType,
					routingKey: getManualRetryRoutingKey(kind),
					payload: payload as unknown as Prisma.InputJsonValue,
					headers,
					availableAt
				}
			],
			skipDuplicates: true
		});
	}

	private async deadLetterMalformed(
		kind: NotificationDeliveryKind,
		message: ConsumeMessage
	): Promise<void> {
		const eventId = getStableMessageId(message, kind);
		const attempt = this.getRetryAttempt(message) + 1;
		const rawEventType =
			typeof message.properties.type === 'string'
				? message.properties.type.trim()
				: '';
		const eventType = rawEventType
			? rawEventType.slice(0, 255)
			: 'unknown';
		const payload = {
			malformed: true,
			contentLength: message.content.length
		};
		const classification: IntegrationErrorClassification = {
			category: 'PERMANENT',
			normalizedCode: INVALID_EVENT_PAYLOAD_CODE,
			retryable: false,
			retryDelayMs: null,
			safeReason: INVALID_EVENT_PAYLOAD_SAFE_REASON,
			recognized: true,
			mayDisableDestination: false,
			classificationVersion: 1
		};
		const firstFailedAt = new Date();
		const headers = this.getFailureHeaders(
			message,
			eventId,
			attempt,
			firstFailedAt,
			classification,
			{ httpStatus: null, providerCode: null }
		);

		try {
			const persisted = await this.prisma.$transaction(
				async transaction => {
					const existingReceipt =
						await transaction.notificationDeliveryReceipt.findUnique({
							where: {
								eventId_consumer: { eventId, consumer: kind }
							},
							select: { status: true }
						});
					if (
						existingReceipt &&
						existingReceipt.status !==
							NotificationDeliveryReceiptStatus.DEAD_LETTERED
					) {
						return false;
					}

					if (!existingReceipt) {
						await transaction.notificationDeliveryReceipt.createMany({
							data: [
								{
									eventId,
									consumer: kind,
									status: NotificationDeliveryReceiptStatus.DEAD_LETTERED
								}
							],
							skipDuplicates: true
						});
					}
					const claimed =
						await transaction.notificationDeliveryReceipt.updateMany({
							where: {
								eventId,
								consumer: kind,
								status: NotificationDeliveryReceiptStatus.DEAD_LETTERED
							},
							data: {
								lockedAt: null,
								lockedBy: null,
								lockToken: null,
								leaseExpiresAt: null,
								deliveredAt: null,
								retryAttempt: null,
								retryAvailableAt: null,
								retryToken: null
							}
						});
					if (claimed.count !== 1) return false;

					const existingFailure =
						await transaction.notificationDeliveryFailure.findUnique({
							where: {
								eventId_consumer: { eventId, consumer: kind }
							},
							select: { resolvedAt: true }
						});
					if (existingFailure?.resolvedAt) return false;

					await transaction.notificationDeliveryFailure.upsert({
						where: {
							eventId_consumer: { eventId, consumer: kind }
						},
						create: {
							eventId,
							consumer: kind,
							routingKey: message.fields.routingKey || kind,
							payload,
							headers,
							attempts: attempt,
							lastError: classification.safeReason,
							category: NotificationDeliveryErrorCategory.PERMANENT,
							normalizedCode: classification.normalizedCode,
							safeReason: classification.safeReason,
							retryable: false,
							classificationVersion: classification.classificationVersion,
							firstFailedAt
						},
						update: {
							routingKey: message.fields.routingKey || kind,
							payload,
							headers,
							attempts: attempt,
							lastError: classification.safeReason,
							category: NotificationDeliveryErrorCategory.PERMANENT,
							normalizedCode: classification.normalizedCode,
							safeReason: classification.safeReason,
							httpStatus: null,
							providerCode: null,
							retryable: false,
							classificationVersion: classification.classificationVersion,
							firstFailedAt,
							failedAt: new Date(),
							retryingAt: null,
							activeRetryToken: null,
							resolvedAt: null,
							resolution: null,
							resolutionComment: null,
							resolvedById: null
						}
					});
					await transaction.notificationDeliveryOutboxEvent.createMany({
						data: [
							{
								messageId: eventId,
								deduplicationKey: `notification:${eventId}:${kind}:malformed`,
								exchange: NotificationDeliveryExchange.DEAD_LETTER,
								eventType,
								routingKey: getDeadLetterRoutingKey(kind),
								payload,
								headers
							}
						],
						skipDuplicates: true
					});
					return true;
				}
			);
			this.ackMessage(message);
			if (persisted) {
				this.logger.error(
					`Malformed notification persisted for dead-letter eventId=${eventId} kind=${kind}: ${classification.safeReason}`
				);
			} else {
				this.logger.warn(
					`Conflicting malformed notification skipped eventId=${eventId} kind=${kind}`
				);
			}
		} catch (error) {
			this.logger.error(
				`Failed to persist malformed notification eventId=${eventId} kind=${kind}: ${this.errorMessage(
					error
				)}`
			);
			this.rabbitMq.nack(message, true);
		}
	}

	private async collectDeadLetter(
		kind: NotificationDeliveryKind,
		message: ConsumeMessage
	): Promise<void> {
		const eventId = getStableMessageId(message, kind);
		const attempt = Math.max(1, this.getRetryAttempt(message));
		const now = new Date();
		const firstFailedAt = this.getHeaderDate(
			message,
			'x-first-failed-at',
			now
		);
		const categoryHeader = this.getStringHeader(
			message,
			'x-error-category'
		);
		const category = Object.values(
			NotificationDeliveryErrorCategory
		).includes(categoryHeader as NotificationDeliveryErrorCategory)
			? (categoryHeader as NotificationDeliveryErrorCategory)
			: NotificationDeliveryErrorCategory.PERMANENT;
		const normalizedCode =
			this.getStringHeader(message, 'x-error-code')?.slice(0, 255) ||
			'DEAD_LETTERED_NOTIFICATION';
		const safeReason = (
			this.getStringHeader(message, 'x-safe-reason') ||
			this.getStringHeader(message, 'x-last-error') ||
			'Notification delivery failed'
		).slice(0, MAX_SAFE_REASON_LENGTH);
		const retryable =
			this.getBooleanHeader(message, 'x-error-retryable') ?? false;
		const classificationVersion =
			this.getNumberHeader(message, 'x-classification-version') || 1;
		const httpStatus = this.getNumberHeader(message, 'x-http-status');
		const failureMetadata = {
			httpStatus:
				httpStatus !== null && httpStatus >= 100 && httpStatus <= 599
					? httpStatus
					: null,
			providerCode:
				this.getStringHeader(message, 'x-provider-code')?.slice(0, 255) ||
				null
		};
		const headers = createMessagingHeaders({
			messageId: eventId,
			causationId: eventId,
			headers: this.filterSafeHeaders(getScalarMessageHeaders(message))
		}) as Prisma.InputJsonObject;
		let payload: Prisma.InputJsonValue = {
			malformed: true,
			contentLength: message.content.length
		};
		try {
			payload = parseNotificationDeliveryMessage(kind, message)
				.payload as unknown as Prisma.InputJsonValue;
		} catch {}

		try {
			const persisted = await this.prisma.$transaction(
				async transaction => {
					const receipt =
						await transaction.notificationDeliveryReceipt.findUnique({
							where: {
								eventId_consumer: {
									eventId,
									consumer: kind
								}
							},
							select: {
								status: true
							}
						});
					if (
						receipt &&
						receipt.status !==
							NotificationDeliveryReceiptStatus.DEAD_LETTERED
					) {
						return false;
					}

					if (!receipt) {
						await transaction.notificationDeliveryReceipt.createMany({
							data: [
								{
									eventId,
									consumer: kind,
									status: NotificationDeliveryReceiptStatus.DEAD_LETTERED
								}
							],
							skipDuplicates: true
						});
					}
					const claimed =
						await transaction.notificationDeliveryReceipt.updateMany({
							where: {
								eventId,
								consumer: kind,
								status: NotificationDeliveryReceiptStatus.DEAD_LETTERED
							},
							data: {
								lockedAt: null,
								lockedBy: null,
								lockToken: null,
								leaseExpiresAt: null,
								deliveredAt: null,
								retryAttempt: null,
								retryAvailableAt: null,
								retryToken: null
							}
						});
					if (claimed.count !== 1) return false;

					const existingFailure =
						await transaction.notificationDeliveryFailure.findUnique({
							where: {
								eventId_consumer: {
									eventId,
									consumer: kind
								}
							},
							select: {
								attempts: true,
								firstFailedAt: true,
								resolvedAt: true,
								retryingAt: true,
								activeRetryToken: true
							}
						});
					if (
						existingFailure?.resolvedAt ||
						existingFailure?.retryingAt ||
						existingFailure?.activeRetryToken
					) {
						return false;
					}

					const failureData = {
						routingKey: MESSAGING_ROUTING_KEYS[kind],
						payload,
						headers,
						attempts: Math.max(attempt, existingFailure?.attempts || 0),
						lastError: safeReason,
						category,
						normalizedCode,
						safeReason,
						httpStatus: failureMetadata.httpStatus,
						providerCode: failureMetadata.providerCode,
						retryable,
						classificationVersion,
						firstFailedAt: existingFailure?.firstFailedAt || firstFailedAt,
						failedAt: now,
						retryingAt: null,
						activeRetryToken: null,
						resolvedAt: null,
						resolution: null,
						resolutionComment: null,
						resolvedById: null
					};
					await transaction.notificationDeliveryFailure.upsert({
						where: {
							eventId_consumer: {
								eventId,
								consumer: kind
							}
						},
						create: {
							eventId,
							consumer: kind,
							...failureData
						},
						update: failureData
					});
					return true;
				}
			);

			this.ackMessage(message);
			if (persisted) {
				this.logger.error(
					`Dead-letter notification persisted eventId=${eventId} kind=${kind}`
				);
			} else {
				this.logger.warn(
					`Resolved dead-letter notification skipped eventId=${eventId} kind=${kind}`
				);
			}
		} catch (error) {
			this.logger.error(
				`Failed to persist dead-letter notification eventId=${eventId} kind=${kind}: ${this.errorMessage(
					error
				)}`
			);
			this.rabbitMq.nack(message, true);
		}
	}

	private async upsertFailure(
		transaction: Prisma.TransactionClient,
		input: {
			kind: NotificationDeliveryKind;
			eventId: string;
			eventType: string;
			payload: NotificationDeliveryEventPayload;
			firstFailedAt: Date;
			attempt: number;
			classification: IntegrationErrorClassification;
			headers: Prisma.InputJsonObject;
			failureMetadata: FailureMetadata;
			retryingAt: Date | null;
			activeRetryToken: string | null;
		}
	): Promise<void> {
		const now = new Date();
		const data = {
			routingKey: MESSAGING_ROUTING_KEYS[input.kind],
			payload: input.payload as unknown as Prisma.InputJsonValue,
			headers: input.headers,
			attempts: input.attempt,
			lastError: input.classification.safeReason.slice(
				0,
				MAX_FAILURE_TEXT_LENGTH
			),
			category: this.getErrorCategory(input.classification.category),
			normalizedCode: input.classification.normalizedCode.slice(0, 255),
			safeReason: input.classification.safeReason.slice(
				0,
				MAX_SAFE_REASON_LENGTH
			),
			httpStatus: input.failureMetadata.httpStatus,
			providerCode: input.failureMetadata.providerCode,
			retryable: input.classification.retryable,
			classificationVersion: input.classification.classificationVersion,
			firstFailedAt: input.firstFailedAt,
			failedAt: now,
			retryingAt: input.retryingAt,
			activeRetryToken: input.activeRetryToken,
			resolvedAt: null,
			resolution: null,
			resolutionComment: null,
			resolvedById: null
		};

		await transaction.notificationDeliveryFailure.upsert({
			where: {
				eventId_consumer: {
					eventId: input.eventId,
					consumer: input.kind
				}
			},
			create: {
				eventId: input.eventId,
				consumer: input.kind,
				...data
			},
			update: data
		});
	}

	private async releaseClaim(
		eventId: string,
		consumer: NotificationDeliveryKind,
		lockToken: string
	): Promise<void> {
		await this.prisma.notificationDeliveryReceipt.deleteMany({
			where: {
				eventId,
				consumer,
				status: NotificationDeliveryReceiptStatus.PROCESSING,
				lockedBy: this.workerId,
				lockToken
			}
		});
	}

	private ackMessage(message: ConsumeMessage): void {
		this.rabbitMq.ack(message);
		this.heartbeat.markSuccessfulConsume();
	}

	private getFailureHeaders(
		message: ConsumeMessage,
		eventId: string,
		attempt: number,
		firstFailedAt: Date,
		classification: IntegrationErrorClassification,
		metadata: FailureMetadata,
		deliveryToken?: string
	): Prisma.InputJsonObject {
		return createMessagingHeaders({
			messageId: eventId,
			causationId: eventId,
			headers: {
				...this.filterSafeHeaders(getScalarMessageHeaders(message)),
				'x-retry-attempt': attempt,
				'x-first-failed-at': firstFailedAt.toISOString(),
				'x-last-error': classification.safeReason.slice(0, 1000),
				'x-error-category': classification.category,
				'x-error-code': classification.normalizedCode.slice(0, 255),
				'x-safe-reason': classification.safeReason.slice(0, 1000),
				'x-error-retryable': classification.retryable,
				'x-classification-version': classification.classificationVersion,
				...(metadata.httpStatus
					? { 'x-http-status': metadata.httpStatus }
					: {}),
				...(metadata.providerCode
					? { 'x-provider-code': metadata.providerCode }
					: {}),
				...(deliveryToken ? { 'x-delivery-token': deliveryToken } : {})
			}
		}) as Prisma.InputJsonObject;
	}

	private filterSafeHeaders(
		headers: Record<string, string | number | boolean>
	): Record<string, string | number | boolean> {
		return Object.fromEntries(
			Object.entries(headers).filter(([name]) =>
				SAFE_HEADER_NAMES.has(name)
			)
		);
	}

	private getFailureMetadata(error: unknown): FailureMetadata {
		const details =
			error && typeof error === 'object'
				? (error as Record<string, unknown>)
				: null;
		const status = Number(
			details?.httpStatus || details?.status || details?.responseCode
		);
		const rawProviderCode =
			typeof details?.providerCode === 'string'
				? details.providerCode
				: typeof details?.errorCode === 'string' ||
					  typeof details?.errorCode === 'number'
					? String(details.errorCode)
					: typeof details?.code === 'string'
						? details.code
						: null;
		return {
			httpStatus:
				Number.isInteger(status) && status >= 100 && status <= 599
					? status
					: null,
			providerCode: rawProviderCode?.slice(0, 255) || null
		};
	}

	private getErrorCategory(
		category: IntegrationErrorClassification['category']
	): NotificationDeliveryErrorCategory {
		return NotificationDeliveryErrorCategory[category];
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

	private getRetryAttempt(message: ConsumeMessage): number {
		const value = Number(message.properties.headers?.['x-retry-attempt']);
		return Number.isInteger(value) && value >= 0 && value <= 1_000_000
			? value
			: 0;
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
		return Number.isInteger(value) && value >= 0 && value <= 1_000_000
			? value
			: null;
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

	private getHeaderDate(
		message: ConsumeMessage,
		name: string,
		fallback: Date
	): Date {
		const value = this.getStringHeader(message, name);
		const timestamp = value ? Date.parse(value) : Number.NaN;
		return Number.isFinite(timestamp) &&
			timestamp <= fallback.getTime() + 60_000
			? new Date(timestamp)
			: fallback;
	}

	private getPrefetch(): number {
		const value = Number(
			this.configService.get<string>('NOTIFICATION_DELIVERY_PREFETCH') || 5
		);
		return Number.isInteger(value) && value >= 1
			? Math.min(value, 100)
			: 5;
	}

	private isUniqueConstraintError(error: unknown): boolean {
		return (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === 'P2002'
		);
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
