import {
	CAMPAIGN_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	NotificationDeliveryKind,
	REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
	TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE
} from '../messaging/messaging.constants';
import { createMessagingHeaders } from '../messaging/messaging-context';
import { IntegrationErrorClassification } from '../messaging/integration-error-classifier';
import { Injectable } from '@nestjs/common';
import {
	NotificationDeliveryExchange,
	Prisma
} from '@prisma/notification-delivery-client';
import { randomUUID } from 'node:crypto';
import { NotificationDeliveryEventPayload } from './notification-delivery-contract';

@Injectable()
export class NotificationDeliveryOutcomeService {
	async createDeliveryOutcome(
		transaction: Prisma.TransactionClient,
		input: {
			kind: NotificationDeliveryKind;
			eventId: string;
			payload: NotificationDeliveryEventPayload;
			status: 'DELIVERED' | 'FAILED';
			failure: {
				normalizedCode: string;
				safeReason: string;
			} | null;
		}
	): Promise<void> {
		if (
			input.kind !== 'campaign-email' &&
			input.kind !== 'campaign-telegram' &&
			input.kind !== 'daily-summary-delivery-telegram' &&
			input.kind !== 'subscription-expiry-email' &&
			input.kind !== 'subscription-expiry-telegram'
		) {
			return;
		}
		if (
			input.kind === 'campaign-email' ||
			input.kind === 'campaign-telegram'
		) {
			const request = input.payload as {
				correlationId: string;
				campaignId: string;
				deliveryId: string;
				dispatchGeneration: number;
			};
			const messageId = randomUUID();
			const payload = {
				schemaVersion: 2 as const,
				eventType: CAMPAIGN_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
				eventId: messageId,
				occurredAt: new Date().toISOString(),
				correlationId: request.correlationId,
				sourceEventId: input.eventId,
				sourceKind: input.kind,
				campaignId: request.campaignId,
				deliveryId: request.deliveryId,
				dispatchGeneration: request.dispatchGeneration,
				status: input.status,
				failure: input.failure
					? {
							normalizedCode: input.failure.normalizedCode.slice(0, 255),
							safeReason: input.failure.safeReason.slice(0, 2000)
						}
					: null
			};
			await transaction.notificationDeliveryOutboxEvent.createMany({
				data: [
					{
						messageId,
						deduplicationKey: `notification:${input.eventId}:${input.kind}:generation:${request.dispatchGeneration}:outcome:${input.status.toLowerCase()}:v2`,
						exchange: NotificationDeliveryExchange.EVENTS,
						eventType: CAMPAIGN_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
						routingKey: CAMPAIGN_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE,
						payload: payload as unknown as Prisma.InputJsonValue,
						headers: createMessagingHeaders({
							messageId,
							causationId: input.eventId,
							headers: {
								'x-correlation-id': request.correlationId
							}
						}) as Prisma.InputJsonObject
					}
				],
				skipDuplicates: true
			});
			return;
		}
		const reference = (
			input.payload as {
				reference?: unknown;
			}
		).reference;
		if (!reference || typeof reference !== 'object') return;

		const messageId = randomUUID();
		const outcomeEventType =
			input.kind === 'daily-summary-delivery-telegram'
				? REPORTING_NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE
				: NOTIFICATION_DELIVERY_OUTCOME_EVENT_TYPE;
		const payload = {
			schemaVersion: 1 as const,
			eventType: outcomeEventType,
			sourceEventId: input.eventId,
			sourceKind: input.kind,
			reference,
			status: input.status,
			failure: input.failure
				? {
						normalizedCode: input.failure.normalizedCode.slice(0, 255),
						safeReason: input.failure.safeReason.slice(0, 2000)
					}
				: null,
			occurredAt: new Date().toISOString()
		};
		await transaction.notificationDeliveryOutboxEvent.createMany({
			data: [
				{
					messageId,
					deduplicationKey: `notification:${input.eventId}:${input.kind}:outcome:${input.status.toLowerCase()}:v1`,
					exchange: NotificationDeliveryExchange.EVENTS,
					eventType: outcomeEventType,
					routingKey: outcomeEventType,
					payload: payload as unknown as Prisma.InputJsonValue,
					headers: createMessagingHeaders({
						messageId,
						causationId: input.eventId
					}) as Prisma.InputJsonObject
				}
			],
			skipDuplicates: true
		});
	}

	async createTelegramDestinationUnavailableOutcome(
		transaction: Prisma.TransactionClient,
		input: {
			kind: NotificationDeliveryKind;
			eventId: string;
			payload: NotificationDeliveryEventPayload;
			classification: IntegrationErrorClassification;
		}
	): Promise<void> {
		if (
			!input.classification.mayDisableDestination ||
			(input.kind !== 'telegram' &&
				input.kind !== 'limit-telegram' &&
				input.kind !== 'campaign-telegram' &&
				input.kind !== 'subscription-expiry-telegram')
		) {
			return;
		}

		const destination = (
			input.payload as {
				destination?: { telegramChatId?: unknown };
			}
		).destination;
		const telegramChatId =
			typeof destination?.telegramChatId === 'string'
				? destination.telegramChatId.trim()
				: '';
		if (!telegramChatId) return;

		const messageId = randomUUID();
		const occurredAt = new Date().toISOString();
		const payload = {
			schemaVersion: 1 as const,
			eventType: TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE,
			sourceEventId: input.eventId,
			sourceKind: input.kind,
			destination: { telegramChatId },
			normalizedCode: input.classification.normalizedCode,
			occurredAt
		};
		await transaction.notificationDeliveryOutboxEvent.createMany({
			data: [
				{
					messageId,
					deduplicationKey: `notification:${input.eventId}:${input.kind}:telegram-destination-unavailable:v1`,
					exchange: NotificationDeliveryExchange.EVENTS,
					eventType: TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE,
					routingKey: TELEGRAM_DESTINATION_UNAVAILABLE_EVENT_TYPE,
					payload: payload as unknown as Prisma.InputJsonValue,
					headers: createMessagingHeaders({
						messageId,
						causationId: input.eventId
					}) as Prisma.InputJsonObject
				}
			],
			skipDuplicates: true
		});
	}
}
