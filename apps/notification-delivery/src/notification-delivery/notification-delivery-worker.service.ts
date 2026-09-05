import {
	NotificationDeliveryKind,
	DEFAULT_NOTIFICATION_DELIVERY_KINDS,
	NOTIFICATION_DELIVERY_KINDS
} from '../messaging/messaging.constants';
import { getStableMessageId } from '../messaging/poison-message-id';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConsumeMessage } from 'amqplib';
import {
	NotificationDeliveryAdapterService,
	NotificationDeliveryResult
} from './notification-delivery-adapter.service';
import {
	NotificationDeliveryEventPayload,
	parseNotificationDeliveryMessage
} from './notification-delivery-contract';
import {
	INVALID_EVENT_PAYLOAD_SAFE_REASON,
	NotificationDeliveryFailureService
} from './notification-delivery-failure.service';
import { NotificationDeliveryHeartbeatService } from './notification-delivery-heartbeat.service';
import {
	NotificationDeliveryClaim,
	NotificationDeliveryReceiptService
} from './notification-delivery-receipt.service';

const SHUTDOWN_DRAIN_TIMEOUT_MS = 20_000;

export function parseNotificationDeliveryKinds(
	value: string | undefined
): readonly NotificationDeliveryKind[] {
	if (value === undefined) return [...DEFAULT_NOTIFICATION_DELIVERY_KINDS];

	const configured = value
		.split(',')
		.map(kind => kind.trim())
		.filter(Boolean);
	if (!configured.length) {
		throw new Error('NOTIFICATION_DELIVERY_KINDS must not be empty');
	}

	const unknown = configured.filter(
		kind =>
			!NOTIFICATION_DELIVERY_KINDS.includes(
				kind as NotificationDeliveryKind
			)
	);
	if (unknown.length) {
		throw new Error(
			`NOTIFICATION_DELIVERY_KINDS contains unsupported kinds: ${Array.from(
				new Set(unknown)
			).join(',')}`
		);
	}

	return Array.from(new Set(configured as NotificationDeliveryKind[]));
}

@Injectable()
export class NotificationDeliveryWorkerService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(
		NotificationDeliveryWorkerService.name
	);
	private readonly activeHandlers = new Set<Promise<void>>();
	private shutdownPromise: Promise<void> | null = null;
	private effectiveKinds: readonly NotificationDeliveryKind[] = [];
	private ready = false;
	private shuttingDown = false;

	constructor(
		private readonly rabbitMq: RabbitMqService,
		private readonly adapter: NotificationDeliveryAdapterService,
		private readonly configService: ConfigService,
		private readonly heartbeat: NotificationDeliveryHeartbeatService,
		private readonly receipts: NotificationDeliveryReceiptService,
		private readonly failures: NotificationDeliveryFailureService
	) {}

	async onModuleInit(): Promise<void> {
		const prefetch = this.getPrefetch();
		this.effectiveKinds = parseNotificationDeliveryKinds(
			this.configService.get<string>('NOTIFICATION_DELIVERY_KINDS')
		);
		this.heartbeat.setConsumerKinds(this.effectiveKinds);
		for (const kind of this.effectiveKinds) {
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
			`Notification delivery consumers started kinds=${this.effectiveKinds.join(',')} prefetch=${prefetch}`
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
		let claim: Extract<
			NotificationDeliveryClaim,
			{ state: 'claimed' }
		> | null = null;

		try {
			const result = await this.receipts.claimDelivery(
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
				await this.receipts.scheduleClaimRecovery(
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

		let deliveryResult: NotificationDeliveryResult;
		try {
			deliveryResult = await this.adapter.deliver(
				kind,
				payload,
				eventId,
				claim.lockToken
			);
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
			if (deliveryResult?.status === 'SKIPPED') {
				await this.receipts.markSkipped(
					eventId,
					kind,
					claim.lockToken,
					deliveryResult.reason
				);
				this.ackMessage(message);
				this.logger.log(
					`Notification skipped eventId=${eventId} kind=${kind} reason=${deliveryResult.reason}`
				);
				return;
			}
			await this.receipts.markDelivered(
				eventId,
				kind,
				claim.lockToken,
				payload
			);
			this.ackMessage(message);
			this.logger.log(
				`Notification delivered eventId=${eventId} kind=${kind}`
			);
		} catch (error) {
			this.logger.error(
				`Notification receipt finalization failed eventId=${eventId} kind=${kind}: ${this.errorMessage(
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
		claim: Extract<NotificationDeliveryClaim, { state: 'claimed' }>;
		error: unknown;
	}): Promise<void> {
		try {
			const result = await this.failures.finalizeDeliveryFailure(input);
			this.ackMessage(input.message);
			if (result.state === 'retry-scheduled') {
				this.logger.warn(
					`Notification retry scheduled eventId=${input.eventId} kind=${input.kind} attempt=${result.attempt} category=${result.classification.category} code=${result.classification.normalizedCode} availableAt=${result.availableAt.toISOString()}`
				);
				return;
			}
			this.logger.error(
				`Notification moved to dead-letter eventId=${input.eventId} kind=${input.kind} category=${result.classification.category} code=${result.classification.normalizedCode}: ${result.classification.safeReason}`
			);
		} catch (finalizationError) {
			this.logger.error(
				`Failed to finalize notification failure eventId=${input.eventId} kind=${input.kind}: ${this.errorMessage(
					finalizationError
				)}`
			);
			await this.receipts
				.releaseClaim(input.eventId, input.kind, input.claim.lockToken)
				.catch(releaseError => {
					this.logger.error(
						`Failed to release notification claim eventId=${input.eventId} kind=${input.kind}: ${this.errorMessage(
							releaseError
						)}`
					);
				});
			this.rabbitMq.nack(input.message, true);
		}
	}

	private async deadLetterMalformed(
		kind: NotificationDeliveryKind,
		message: ConsumeMessage
	): Promise<void> {
		const eventId = getStableMessageId(message, kind);
		try {
			const persisted = await this.failures.persistMalformed(
				kind,
				message,
				eventId
			);
			this.ackMessage(message);
			if (persisted) {
				this.logger.error(
					`Malformed notification persisted for dead-letter eventId=${eventId} kind=${kind}: ${INVALID_EVENT_PAYLOAD_SAFE_REASON}`
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
		try {
			const persisted = await this.failures.collectDeadLetter(
				kind,
				message,
				eventId
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

	private ackMessage(message: ConsumeMessage): void {
		this.rabbitMq.ack(message);
		this.heartbeat.markSuccessfulConsume();
	}

	private getPrefetch(): number {
		const value = Number(
			this.configService.get<string>('NOTIFICATION_DELIVERY_PREFETCH') || 5
		);
		return Number.isInteger(value) && value >= 1
			? Math.min(value, 100)
			: 5;
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
