import { createReportingCorrelationId } from '../common/reporting-context';
import {
	ADMIN_AUDIT_EVENT_TYPE,
	REPORTING_ADMIN_AUDIT_ROUTING_KEY,
	REPORTING_CONSUMERS,
	REPORTING_CONSUMER_KINDS,
	REPORTING_ROUTING_KEYS,
	ReportingConsumerKind,
	getReportingManualRetryRoutingKey
} from '../messaging/reporting-messaging.constants';
import {
	ReportingDeliveryRetryAdminAuditEvent,
	assertReportingAdminAuditEvent
} from '../messaging/reporting-published-event.contract';
import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import {
	NotificationDeliveryOutcomeEvent,
	ReportingSourceEvent,
	parseNotificationDeliveryOutcome,
	parseReportingSourceEvent,
	reportingPayloadHash
} from '../projections/reporting-event.contract';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import {
	Prisma,
	ReportingConsumerFailureStatus,
	ReportingConsumerReceiptStatus,
	ReportingOutboxExchange,
	ReportingOutboxStatus
} from '@prisma/reporting-client';
import { randomUUID } from 'node:crypto';

const MAX_MANUAL_RETRY_CYCLES = 1_000_000;

@Injectable()
export class ReportingDeliveryFailuresService {
	constructor(private readonly prisma: ReportingPrismaService) {}

	async retryFailure(
		eventId: string,
		consumerKindValue: string,
		actorId: string
	) {
		const consumerKind = this.consumerKind(consumerKindValue);
		const consumer = REPORTING_CONSUMERS[consumerKind];
		const correlationId = createReportingCorrelationId();

		return this.prisma.$transaction(async transaction => {
			const failure =
				await transaction.reportingConsumerFailure.findUnique({
					where: { eventId_consumer: { eventId, consumer } }
				});
			if (!failure || failure.consumerKind !== consumerKind) {
				throw new NotFoundException(
					'Reporting delivery failure was not found'
				);
			}
			if (failure.status === ReportingConsumerFailureStatus.RESOLVED) {
				throw new ConflictException(
					'Reporting delivery failure is already resolved'
				);
			}
			if (
				failure.status === ReportingConsumerFailureStatus.RETRY_REQUESTED
			) {
				return this.response(
					eventId,
					consumerKind,
					failure.manualRetryCount,
					failure.retryRequestedAt
				);
			}
			if (failure.manualRetryCount >= MAX_MANUAL_RETRY_CYCLES) {
				throw new ConflictException(
					'Manual retry cycle limit is exhausted'
				);
			}
			const retryPayload = this.validateFailurePayload(
				failure.payload,
				failure.eventType,
				failure.payloadHash,
				eventId,
				consumerKind
			);

			const receipt = await transaction.consumerReceipt.findUnique({
				where: { eventId_consumer: { eventId, consumer } }
			});
			if (
				!receipt ||
				receipt.status !== ReportingConsumerReceiptStatus.DEAD_LETTERED ||
				receipt.payloadHash !== failure.payloadHash ||
				receipt.retryCycle !== failure.manualRetryCount
			) {
				throw new ConflictException(
					'Reporting delivery receipt is not retryable'
				);
			}

			const retryCycle = failure.manualRetryCount + 1;
			const requestedAt = new Date();
			const claimed =
				await transaction.reportingConsumerFailure.updateMany({
					where: {
						id: failure.id,
						status: ReportingConsumerFailureStatus.OPEN,
						manualRetryCount: failure.manualRetryCount
					},
					data: {
						status: ReportingConsumerFailureStatus.RETRY_REQUESTED,
						manualRetryCount: retryCycle,
						retryRequestedAt: requestedAt,
						resolvedAt: null
					}
				});
			if (claimed.count !== 1) {
				const current =
					await transaction.reportingConsumerFailure.findUnique({
						where: { id: failure.id }
					});
				if (
					current?.status ===
					ReportingConsumerFailureStatus.RETRY_REQUESTED
				) {
					return this.response(
						eventId,
						consumerKind,
						current.manualRetryCount,
						current.retryRequestedAt
					);
				}
				throw new ConflictException(
					'Reporting delivery failure state changed concurrently'
				);
			}

			const receiptUpdated = await transaction.consumerReceipt.updateMany({
				where: {
					id: receipt.id,
					status: ReportingConsumerReceiptStatus.DEAD_LETTERED,
					payloadHash: failure.payloadHash,
					retryCycle: failure.manualRetryCount
				},
				data: {
					status: ReportingConsumerReceiptStatus.RETRY_SCHEDULED,
					retryAttempt: 0,
					retryCycle,
					deliveredAt: null,
					lastError: null
				}
			});
			if (receiptUpdated.count !== 1) {
				throw new ConflictException(
					'Reporting delivery receipt state changed concurrently'
				);
			}

			await transaction.reportingOutboxEvent.create({
				data: {
					messageId: eventId,
					deduplicationKey: `consumer-manual-retry:${consumer}:${eventId}:${retryCycle}`,
					exchange: ReportingOutboxExchange.MANUAL_RETRY,
					eventType: failure.eventType,
					routingKey: getReportingManualRetryRoutingKey(consumerKind),
					payload: retryPayload as unknown as Prisma.InputJsonValue,
					headers: {
						'x-correlation-id': correlationId,
						'x-causation-id': eventId,
						'x-retry-attempt': 0,
						'x-retry-cycle': retryCycle,
						'x-manual-retry': true
					},
					status: ReportingOutboxStatus.PENDING
				}
			});

			const auditEventId = randomUUID();
			const auditPayload: ReportingDeliveryRetryAdminAuditEvent = {
				schemaVersion: 1,
				eventType: ADMIN_AUDIT_EVENT_TYPE,
				eventId: auditEventId,
				occurredAt: requestedAt.toISOString(),
				correlationId,
				actorId,
				action: 'REPORTING_DELIVERY_RETRY',
				target: { eventId, consumerKind },
				metadata: {}
			};
			assertReportingAdminAuditEvent(auditPayload, auditEventId);
			await transaction.reportingOutboxEvent.create({
				data: {
					messageId: auditEventId,
					deduplicationKey: `reporting-delivery-retry-audit:${auditEventId}`,
					exchange: ReportingOutboxExchange.EVENTS,
					eventType: ADMIN_AUDIT_EVENT_TYPE,
					routingKey: REPORTING_ADMIN_AUDIT_ROUTING_KEY,
					payload: auditPayload as unknown as Prisma.InputJsonObject,
					headers: {
						'x-correlation-id': correlationId,
						'x-causation-id': eventId
					},
					status: ReportingOutboxStatus.PENDING
				}
			});

			return this.response(eventId, consumerKind, retryCycle, requestedAt);
		});
	}

	private consumerKind(value: string): ReportingConsumerKind {
		if (
			!REPORTING_CONSUMER_KINDS.includes(value as ReportingConsumerKind)
		) {
			throw new BadRequestException(
				'consumerKind is not a Reporting consumer'
			);
		}
		return value as ReportingConsumerKind;
	}

	private validateFailurePayload(
		value: Prisma.JsonValue,
		eventType: string,
		payloadHash: string,
		eventId: string,
		consumerKind: ReportingConsumerKind
	): ReportingSourceEvent | NotificationDeliveryOutcomeEvent {
		const expectedEventType = REPORTING_ROUTING_KEYS[consumerKind];
		if (eventType !== expectedEventType) {
			throw new ConflictException(
				'Reporting delivery failure event contract is invalid'
			);
		}
		let payload: ReportingSourceEvent | NotificationDeliveryOutcomeEvent;
		try {
			payload =
				consumerKind === 'deliveryOutcome'
					? parseNotificationDeliveryOutcome(value)
					: parseReportingSourceEvent(
							value,
							expectedEventType as ReportingSourceEvent['eventType']
						);
		} catch {
			throw new ConflictException(
				'Reporting delivery failure payload contract is invalid'
			);
		}
		if (
			('eventId' in payload && payload.eventId !== eventId) ||
			reportingPayloadHash(payload) !== payloadHash
		) {
			throw new ConflictException(
				'Reporting delivery failure payload identity is invalid'
			);
		}
		return payload;
	}

	private response(
		eventId: string,
		consumerKind: ReportingConsumerKind,
		manualRetryCount: number,
		retryRequestedAt: Date | null
	) {
		return {
			eventId,
			consumerKind,
			status: 'retry-requested' as const,
			manualRetryCount,
			retryRequestedAt: retryRequestedAt?.toISOString() || null
		};
	}
}
