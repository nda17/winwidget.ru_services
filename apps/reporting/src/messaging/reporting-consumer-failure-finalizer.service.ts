import { ReportingMetricsService } from '../metrics/reporting-metrics.service';
import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import {
	InvalidReportingEventError,
	OPERATIONS_NOTIFICATION_ROUTING_EVENT_TYPE,
	reportingPayloadHash
} from '../projections/reporting-event.contract';
import { ReportingConsumerReceiptService } from './reporting-consumer-receipt.service';
import { ParsedReportingConsumeMessage } from './reporting-consumer-router.service';
import {
	REPORTING_DEAD_LETTER_EXCHANGE,
	REPORTING_RETRY_DELAYS_MS,
	REPORTING_ROUTING_KEYS,
	ReportingConsumerKind,
	getReportingDeadLetterRoutingKey,
	getReportingRetryRoutingKey
} from './reporting-messaging.constants';
import { ReportingRabbitMqService } from './reporting-rabbitmq.service';
import { Injectable } from '@nestjs/common';
import {
	Prisma,
	ReportingConsumerFailureStatus,
	ReportingOutboxExchange,
	ReportingOutboxStatus
} from '@prisma/reporting-client';
import type { ConsumeMessage } from 'amqplib';
import { createHash, randomUUID } from 'node:crypto';

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CONTEXT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

@Injectable()
export class ReportingConsumerFailureFinalizerService {
	constructor(
		private readonly prisma: ReportingPrismaService,
		private readonly rabbitMq: ReportingRabbitMqService,
		private readonly receipts: ReportingConsumerReceiptService,
		private readonly metrics: ReportingMetricsService
	) {}

	async finalize(
		kind: ReportingConsumerKind,
		parsed: ParsedReportingConsumeMessage,
		consumer: string,
		lockToken: string,
		error: unknown,
		message: ConsumeMessage
	): Promise<void> {
		const nextAttempt = parsed.retryAttempt + 1;
		const shouldRetry =
			!(error instanceof InvalidReportingEventError) &&
			nextAttempt <= REPORTING_RETRY_DELAYS_MS.length;
		const errorMessage = this.error(error).slice(0, 2000);
		const correlationId = this.correlationId(message, parsed.eventId);
		const payloadHash = reportingPayloadHash(parsed.payload);
		await this.prisma.$transaction(async transaction => {
			await this.receipts.transitionAfterFailure(transaction, {
				eventId: parsed.eventId,
				consumer,
				lockToken,
				shouldRetry,
				nextAttempt,
				errorMessage
			});
			await transaction.reportingOutboxEvent.create({
				data: {
					messageId: parsed.eventId,
					deduplicationKey: shouldRetry
						? `consumer-retry:${consumer}:${parsed.eventId}:${parsed.retryCycle}:${nextAttempt}`
						: `consumer-dead-letter:${consumer}:${parsed.eventId}:${parsed.retryCycle}`,
					exchange: shouldRetry
						? ReportingOutboxExchange.RETRY
						: ReportingOutboxExchange.DEAD_LETTER,
					eventType: parsed.eventType,
					routingKey: shouldRetry
						? getReportingRetryRoutingKey(kind, nextAttempt - 1)
						: getReportingDeadLetterRoutingKey(kind),
					payload: parsed.payload as unknown as Prisma.InputJsonValue,
					headers: {
						'x-correlation-id': correlationId,
						'x-causation-id': parsed.eventId,
						'x-retry-attempt': shouldRetry
							? nextAttempt
							: parsed.retryAttempt,
						'x-retry-cycle': parsed.retryCycle,
						'x-last-error': errorMessage.slice(0, 1000),
						...(parsed.eventType ===
						OPERATIONS_NOTIFICATION_ROUTING_EVENT_TYPE
							? {
									'x-aggregate-type': 'telegram-bot-settings',
									'x-aggregate-id': 'singleton'
								}
							: {})
					},
					status: ReportingOutboxStatus.PENDING
				}
			});
			if (!shouldRetry) {
				await transaction.reportingConsumerFailure.upsert({
					where: {
						eventId_consumer: {
							eventId: parsed.eventId,
							consumer
						}
					},
					create: {
						eventId: parsed.eventId,
						consumer,
						consumerKind: kind,
						eventType: parsed.eventType,
						payload: parsed.payload as unknown as Prisma.InputJsonValue,
						payloadHash,
						correlationId,
						status: ReportingConsumerFailureStatus.OPEN,
						manualRetryCount: parsed.retryCycle,
						lastError: errorMessage
					},
					update: {
						consumerKind: kind,
						eventType: parsed.eventType,
						payload: parsed.payload as unknown as Prisma.InputJsonValue,
						payloadHash,
						correlationId,
						status: ReportingConsumerFailureStatus.OPEN,
						lastError: errorMessage,
						lastFailedAt: new Date(),
						retryRequestedAt: null,
						resolvedAt: null
					}
				});
			}
		});
		this.metrics.increment(
			shouldRetry
				? 'consumer_retries_scheduled_total'
				: 'consumer_dead_lettered_total'
		);
	}

	async publishPoison(
		kind: ReportingConsumerKind,
		message: ConsumeMessage,
		error: unknown
	): Promise<void> {
		const suppliedId = message.properties.messageId;
		const eventId =
			typeof suppliedId === 'string' && UUID_PATTERN.test(suppliedId)
				? suppliedId
				: randomUUID();
		const payload = {
			schemaVersion: 1,
			eventType: 'reporting.poison.v1',
			poisonId: eventId,
			sourceQueue: REPORTING_ROUTING_KEYS[kind],
			contentSha256: createHash('sha256')
				.update(message.content)
				.digest('hex'),
			contentBytes: message.content.length,
			safeReason: this.error(error).slice(0, 1000),
			occurredAt: new Date().toISOString()
		};
		await this.rabbitMq.publish(
			REPORTING_DEAD_LETTER_EXCHANGE,
			getReportingDeadLetterRoutingKey(kind),
			payload,
			{
				messageId: eventId,
				type: 'reporting.poison.v1',
				correlationId: this.correlationId(message, eventId),
				headers: { 'x-poison-message': true }
			}
		);
		this.metrics.increment('consumer_poison_messages_total');
	}

	private correlationId(
		message: ConsumeMessage,
		fallback: string
	): string {
		const header = message.properties.headers?.['x-correlation-id'];
		if (typeof header === 'string' && SAFE_CONTEXT_ID.test(header)) {
			return header;
		}
		if (
			typeof message.properties.correlationId === 'string' &&
			SAFE_CONTEXT_ID.test(message.properties.correlationId)
		) {
			return message.properties.correlationId;
		}
		return fallback;
	}

	private error(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
