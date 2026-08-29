import {
	getDeadLetterRoutingKey,
	getManualRetryRoutingKey,
	MESSAGING_ROUTING_KEYS,
	NotificationDeliveryKind
} from '../messaging/messaging.constants';
import { createMessagingHeaders } from '../messaging/messaging-context';
import {
	classifyIntegrationError,
	IntegrationErrorClassification
} from '../messaging/integration-error-classifier';
import { Injectable } from '@nestjs/common';
import {
	NotificationDeliveryErrorCategory,
	NotificationDeliveryExchange,
	NotificationDeliveryReceiptStatus,
	Prisma
} from '@prisma/notification-delivery-client';
import type { ConsumeMessage } from 'amqplib';
import { randomUUID } from 'node:crypto';
import {
	NotificationDeliveryEventPayload,
	getScalarMessageHeaders,
	parseNotificationDeliveryMessage
} from './notification-delivery-contract';
import {
	NotificationDeliveryFailureMetadata,
	NotificationDeliveryMessageMetadataService
} from './notification-delivery-message-metadata.service';
import { NotificationDeliveryOutcomeService } from './notification-delivery-outcome.service';
import {
	NotificationDeliveryClaim,
	NotificationDeliveryReceiptService
} from './notification-delivery-receipt.service';
import { NotificationDeliveryPrismaService } from './prisma/notification-delivery-prisma.service';

const AUTOMATIC_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_FAILURE_TEXT_LENGTH = 10_000;
const MAX_SAFE_REASON_LENGTH = 2_000;
const INVALID_EVENT_PAYLOAD_CODE = 'INVALID_EVENT_PAYLOAD';
export const INVALID_EVENT_PAYLOAD_SAFE_REASON =
	'Notification payload failed contract validation';

export interface NotificationDeliveryFailureInput {
	kind: NotificationDeliveryKind;
	message: ConsumeMessage;
	eventId: string;
	eventType: string;
	payload: NotificationDeliveryEventPayload;
	retryAttempt: number;
	firstFailedAt: Date;
	claim: Extract<NotificationDeliveryClaim, { state: 'claimed' }>;
	error: unknown;
}

export type NotificationDeliveryFailureFinalization =
	| {
			state: 'retry-scheduled';
			attempt: number;
			classification: IntegrationErrorClassification;
			availableAt: Date;
	  }
	| {
			state: 'dead-lettered';
			attempt: number;
			classification: IntegrationErrorClassification;
	  };

@Injectable()
export class NotificationDeliveryFailureService {
	constructor(
		private readonly prisma: NotificationDeliveryPrismaService,
		private readonly receipts: NotificationDeliveryReceiptService,
		private readonly outcomes: NotificationDeliveryOutcomeService,
		private readonly metadata: NotificationDeliveryMessageMetadataService
	) {}

	async finalizeDeliveryFailure(
		input: NotificationDeliveryFailureInput
	): Promise<NotificationDeliveryFailureFinalization> {
		const nextAttempt = input.retryAttempt + 1;
		let classification = classifyIntegrationError(input.kind, input.error);
		const retryDelayMs = this.getRetryDelayMs(classification, nextAttempt);
		const retryBudgetAvailable =
			nextAttempt <= this.getMaxRetryPublications(classification);
		const retryWindowAvailable =
			Date.now() + retryDelayMs <=
			input.firstFailedAt.getTime() + AUTOMATIC_RETRY_WINDOW_MS;

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
			return {
				state: 'retry-scheduled',
				attempt: nextAttempt,
				classification,
				availableAt
			};
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
		return {
			state: 'dead-lettered',
			attempt: nextAttempt,
			classification
		};
	}

	async persistMalformed(
		kind: NotificationDeliveryKind,
		message: ConsumeMessage,
		eventId: string
	): Promise<boolean> {
		const attempt = this.metadata.retryAttempt(message) + 1;
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
		const headers = this.metadata.failureHeaders(
			message,
			eventId,
			attempt,
			firstFailedAt,
			classification,
			{ httpStatus: null, providerCode: null }
		);

		return this.prisma.$transaction(async transaction => {
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
		});
	}

	async collectDeadLetter(
		kind: NotificationDeliveryKind,
		message: ConsumeMessage,
		eventId: string
	): Promise<boolean> {
		const attempt = Math.max(1, this.metadata.retryAttempt(message));
		const now = new Date();
		const firstFailedAt = this.metadata.headerDate(
			message,
			'x-first-failed-at',
			now
		);
		const categoryHeader = this.metadata.stringHeader(
			message,
			'x-error-category'
		);
		const category = Object.values(
			NotificationDeliveryErrorCategory
		).includes(categoryHeader as NotificationDeliveryErrorCategory)
			? (categoryHeader as NotificationDeliveryErrorCategory)
			: NotificationDeliveryErrorCategory.PERMANENT;
		const normalizedCode =
			this.metadata.stringHeader(message, 'x-error-code')?.slice(0, 255) ||
			'DEAD_LETTERED_NOTIFICATION';
		const safeReason = (
			this.metadata.stringHeader(message, 'x-safe-reason') ||
			this.metadata.stringHeader(message, 'x-last-error') ||
			'Notification delivery failed'
		).slice(0, MAX_SAFE_REASON_LENGTH);
		const retryable =
			this.metadata.booleanHeader(message, 'x-error-retryable') ?? false;
		const classificationVersion =
			this.metadata.numberHeader(message, 'x-classification-version') || 1;
		const httpStatus = this.metadata.numberHeader(
			message,
			'x-http-status'
		);
		const failureMetadata = {
			httpStatus:
				httpStatus !== null && httpStatus >= 100 && httpStatus <= 599
					? httpStatus
					: null,
			providerCode:
				this.metadata
					.stringHeader(message, 'x-provider-code')
					?.slice(0, 255) || null
		};
		const headers = createMessagingHeaders({
			messageId: eventId,
			causationId: eventId,
			headers: this.metadata.filterSafeHeaders(
				getScalarMessageHeaders(message)
			)
		}) as Prisma.InputJsonObject;
		let payload: Prisma.InputJsonValue = {
			malformed: true,
			contentLength: message.content.length
		};
		let notificationPayload: NotificationDeliveryEventPayload | null =
			null;
		try {
			notificationPayload = parseNotificationDeliveryMessage(
				kind,
				message
			).payload;
			payload = notificationPayload as unknown as Prisma.InputJsonValue;
		} catch {}

		return this.prisma.$transaction(async transaction => {
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
				receipt.status !== NotificationDeliveryReceiptStatus.DEAD_LETTERED
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
			if (notificationPayload) {
				await this.outcomes.createDeliveryOutcome(transaction, {
					kind,
					eventId,
					payload: notificationPayload,
					status: 'FAILED',
					failure: {
						normalizedCode,
						safeReason
					}
				});
			}
			return true;
		});
	}

	private async scheduleRetry(
		input: NotificationDeliveryFailureInput & {
			attempt: number;
			classification: IntegrationErrorClassification;
			delayMs: number;
		}
	): Promise<Date> {
		const availableAt = new Date(Date.now() + input.delayMs);
		const retryToken = randomUUID();
		const failureMetadata = this.metadata.failureMetadata(input.error);
		const headers = this.metadata.failureHeaders(
			input.message,
			input.eventId,
			input.attempt,
			input.firstFailedAt,
			input.classification,
			failureMetadata,
			retryToken
		);

		await this.prisma.$transaction(async transaction => {
			await this.receipts.markRetryScheduled(transaction, {
				eventId: input.eventId,
				kind: input.kind,
				lockToken: input.claim.lockToken,
				attempt: input.attempt,
				availableAt,
				retryToken
			});
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

	private async moveToDeadLetter(
		input: NotificationDeliveryFailureInput & {
			attempt: number;
			classification: IntegrationErrorClassification;
		}
	): Promise<void> {
		const failureMetadata = this.metadata.failureMetadata(input.error);
		const headers = this.metadata.failureHeaders(
			input.message,
			input.eventId,
			input.attempt,
			input.firstFailedAt,
			input.classification,
			failureMetadata
		);

		await this.prisma.$transaction(async transaction => {
			await this.receipts.markDeadLettered(transaction, {
				eventId: input.eventId,
				kind: input.kind,
				lockToken: input.claim.lockToken
			});
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
			await this.outcomes.createTelegramDestinationUnavailableOutcome(
				transaction,
				input
			);
			await this.outcomes.createDeliveryOutcome(transaction, {
				kind: input.kind,
				eventId: input.eventId,
				payload: input.payload,
				status: 'FAILED',
				failure: {
					normalizedCode: input.classification.normalizedCode,
					safeReason: input.classification.safeReason
				}
			});
		});
	}

	private async upsertFailure(
		transaction: Prisma.TransactionClient,
		input: {
			kind: NotificationDeliveryKind;
			eventId: string;
			payload: NotificationDeliveryEventPayload;
			firstFailedAt: Date;
			attempt: number;
			classification: IntegrationErrorClassification;
			headers: Prisma.InputJsonObject;
			failureMetadata: NotificationDeliveryFailureMetadata;
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
}
