import {
	getManualRetryRoutingKey,
	NotificationDeliveryKind
} from '../messaging/messaging.constants';
import { createMessagingHeaders } from '../messaging/messaging-context';
import { Injectable } from '@nestjs/common';
import {
	NotificationDeliveryExchange,
	NotificationDeliveryFailureResolution,
	NotificationDeliveryReceiptStatus,
	Prisma
} from '@prisma/notification-delivery-client';
import type { ConsumeMessage } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
	NotificationDeliveryEventPayload,
	getScalarMessageHeaders
} from './notification-delivery-contract';
import { NotificationDeliveryMessageMetadataService } from './notification-delivery-message-metadata.service';
import { NotificationDeliveryOutcomeService } from './notification-delivery-outcome.service';
import { NotificationDeliveryPrismaService } from './prisma/notification-delivery-prisma.service';

const DELIVERY_RECEIPT_LEASE_MS = 10 * 60 * 1000;
const DELIVERY_RECOVERY_GRACE_MS = 5_000;

export type NotificationDeliveryClaim =
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

@Injectable()
export class NotificationDeliveryReceiptService {
	private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;

	constructor(
		private readonly prisma: NotificationDeliveryPrismaService,
		private readonly metadata: NotificationDeliveryMessageMetadataService,
		private readonly outcomes: NotificationDeliveryOutcomeService
	) {}

	async claimDelivery(
		eventId: string,
		consumer: NotificationDeliveryKind,
		retryAttempt: number,
		deliveryToken: string | null
	): Promise<NotificationDeliveryClaim> {
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

	async markDelivered(
		eventId: string,
		consumer: NotificationDeliveryKind,
		lockToken: string,
		payload: NotificationDeliveryEventPayload
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
			await this.outcomes.createDeliveryOutcome(transaction, {
				kind: consumer,
				eventId,
				payload,
				status: 'DELIVERED',
				failure: null
			});
		});
	}

	async markRetryScheduled(
		transaction: Prisma.TransactionClient,
		input: {
			eventId: string;
			kind: NotificationDeliveryKind;
			lockToken: string;
			attempt: number;
			availableAt: Date;
			retryToken: string;
		}
	): Promise<void> {
		const scheduled =
			await transaction.notificationDeliveryReceipt.updateMany({
				where: {
					eventId: input.eventId,
					consumer: input.kind,
					status: NotificationDeliveryReceiptStatus.PROCESSING,
					lockedBy: this.workerId,
					lockToken: input.lockToken
				},
				data: {
					status: NotificationDeliveryReceiptStatus.RETRY_SCHEDULED,
					lockedAt: null,
					lockedBy: null,
					lockToken: null,
					leaseExpiresAt: null,
					deliveredAt: null,
					retryAttempt: input.attempt,
					retryAvailableAt: input.availableAt,
					retryToken: input.retryToken
				}
			});
		if (scheduled.count !== 1) {
			throw new Error(
				`Notification claim was lost before retry eventId=${input.eventId} kind=${input.kind}`
			);
		}
	}

	async markDeadLettered(
		transaction: Prisma.TransactionClient,
		input: {
			eventId: string;
			kind: NotificationDeliveryKind;
			lockToken: string;
		}
	): Promise<void> {
		const marked =
			await transaction.notificationDeliveryReceipt.updateMany({
				where: {
					eventId: input.eventId,
					consumer: input.kind,
					status: NotificationDeliveryReceiptStatus.PROCESSING,
					lockedBy: this.workerId,
					lockToken: input.lockToken
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
	}

	async scheduleClaimRecovery(
		kind: NotificationDeliveryKind,
		payload: NotificationDeliveryEventPayload,
		eventId: string,
		eventType: string,
		claim: Extract<NotificationDeliveryClaim, { state: 'processing' }>,
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
			headers: this.metadata.filterSafeHeaders(incoming)
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

	async releaseClaim(
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

	private isUniqueConstraintError(error: unknown): boolean {
		return (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === 'P2002'
		);
	}
}
