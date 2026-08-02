import { DailySummaryRunService } from '../daily-summary/daily-summary-run.service';
import { ReportingMetricsService } from '../metrics/reporting-metrics.service';
import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import {
	InvalidReportingEventError,
	NotificationDeliveryOutcomeEvent,
	ReportingSourceEvent,
	parseReportingConsumeMessage,
	reportingPayloadHash
} from '../projections/reporting-event.contract';
import { ProjectionService } from '../projections/projection.service';
import { ReportingRuntimeService } from '../runtime/reporting-runtime.service';
import {
	REPORTING_ACCEPTED_PROJECTION_EVENT_TYPES,
	REPORTING_CONSUMERS,
	REPORTING_CONSUMER_KINDS,
	REPORTING_DEAD_LETTER_EXCHANGE,
	REPORTING_RETRY_DELAYS_MS,
	REPORTING_ROUTING_KEYS,
	ReportingConsumerKind,
	getReportingDeadLetterRoutingKey,
	getReportingRetryRoutingKey,
	isProjectionConsumerKind
} from './reporting-messaging.constants';
import { ReportingRabbitMqService } from './reporting-rabbitmq.service';
import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	Prisma,
	ReportingConsumerFailureStatus,
	ReportingConsumerReceiptStatus,
	ReportingOutboxExchange,
	ReportingOutboxStatus
} from '@prisma/reporting-client';
import type { ConsumeMessage } from 'amqplib';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const RECEIPT_LEASE_MS = 5 * 60 * 1000;
const RECEIPT_RENEW_INTERVAL_MS = 60_000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 20_000;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CONTEXT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

type ReceiptClaim =
	| { state: 'claimed'; lockToken: string }
	| { state: 'done' }
	| { state: 'active' };

@Injectable()
export class ReportingWorkerService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(ReportingWorkerService.name);
	private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private readonly activeHandlers = new Set<Promise<void>>();
	private ready = false;
	private shuttingDown = false;

	constructor(
		private readonly rabbitMq: ReportingRabbitMqService,
		private readonly prisma: ReportingPrismaService,
		private readonly projections: ProjectionService,
		private readonly dailySummary: DailySummaryRunService,
		private readonly runtime: ReportingRuntimeService,
		private readonly config: ConfigService,
		private readonly metrics: ReportingMetricsService
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.runtime.workerEnabled) return;
		const prefetch = this.prefetch();
		for (const kind of REPORTING_CONSUMER_KINDS) {
			await this.rabbitMq.consume(
				kind,
				message => this.track(() => this.handle(kind, message)),
				prefetch
			);
		}
		this.ready = true;
	}

	isReady(): boolean {
		return (
			!this.runtime.workerEnabled || (this.ready && !this.shuttingDown)
		);
	}

	async beforeApplicationShutdown(): Promise<void> {
		if (!this.runtime.workerEnabled) return;
		this.ready = false;
		this.shuttingDown = true;
		await this.rabbitMq
			.cancelConsumers()
			.catch(error =>
				this.logger.error(
					`Could not cancel reporting consumers: ${this.error(error)}`
				)
			);
		if (!this.activeHandlers.size) return;
		await Promise.race([
			Promise.allSettled([...this.activeHandlers]).then(() => undefined),
			new Promise<void>(resolve =>
				setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS).unref()
			)
		]);
	}

	private track(handler: () => Promise<void>): Promise<void> {
		const promise = handler();
		this.activeHandlers.add(promise);
		void promise.then(
			() => this.activeHandlers.delete(promise),
			() => this.activeHandlers.delete(promise)
		);
		return promise;
	}

	private async handle(
		kind: ReportingConsumerKind,
		message: ConsumeMessage
	): Promise<void> {
		let parsed: ReturnType<typeof parseReportingConsumeMessage>;
		try {
			const expectedEventTypes = isProjectionConsumerKind(kind)
				? REPORTING_ACCEPTED_PROJECTION_EVENT_TYPES[kind]
				: REPORTING_ROUTING_KEYS.deliveryOutcome;
			parsed = parseReportingConsumeMessage(message, expectedEventTypes);
		} catch (error) {
			await this.deadLetterPoison(kind, message, error);
			return;
		}
		const consumer = REPORTING_CONSUMERS[kind];
		const payloadHash = reportingPayloadHash(parsed.payload);
		let claim: ReceiptClaim;
		try {
			claim = await this.claim(
				parsed.eventId,
				consumer,
				payloadHash,
				parsed.retryAttempt,
				parsed.retryCycle
			);
		} catch (error) {
			if (error instanceof InvalidReportingEventError) {
				await this.deadLetterPoison(kind, message, error);
				return;
			}
			this.logger.error(
				`Reporting event claim failed eventId=${parsed.eventId}: ${this.error(error)}`
			);
			this.rabbitMq.nack(message, true);
			return;
		}
		if (claim.state === 'done') {
			this.metrics.increment('consumer_duplicate_deliveries_total');
			this.rabbitMq.ack(message);
			return;
		}
		if (claim.state === 'active') {
			this.metrics.increment('consumer_active_redeliveries_total');
			await new Promise<void>(resolve => {
				setTimeout(resolve, 250).unref();
			});
			this.rabbitMq.nack(message, true);
			return;
		}

		const renewal = setInterval(() => {
			void this.renew(parsed.eventId, consumer, claim.lockToken).catch(
				error => {
					this.metrics.increment('consumer_lease_renew_failures_total');
					this.logger.warn(
						`Reporting receipt lease renewal failed eventId=${parsed.eventId}: ${this.error(error)}`
					);
				}
			);
		}, RECEIPT_RENEW_INTERVAL_MS);
		renewal.unref();
		try {
			if (isProjectionConsumerKind(kind)) {
				await this.projections.applyEvent(
					parsed.payload as ReportingSourceEvent,
					{
						eventId: parsed.eventId,
						consumer,
						lockToken: claim.lockToken
					}
				);
			} else {
				await this.dailySummary.applyOutcome(
					parsed.payload as NotificationDeliveryOutcomeEvent,
					parsed.eventId,
					{
						eventId: parsed.eventId,
						consumer,
						lockToken: claim.lockToken
					}
				);
			}
			this.metrics.increment('consumer_events_delivered_total');
			this.rabbitMq.ack(message);
		} catch (error) {
			try {
				await this.finalizeFailure(
					kind,
					parsed,
					consumer,
					claim.lockToken,
					error,
					message
				);
				this.rabbitMq.ack(message);
			} catch (finalizationError) {
				this.logger.error(
					`Reporting failure finalization failed eventId=${parsed.eventId}: ${this.error(finalizationError)}`
				);
				this.rabbitMq.nack(message, true);
			}
		} finally {
			clearInterval(renewal);
		}
	}

	private async claim(
		eventId: string,
		consumer: string,
		payloadHash: string,
		retryAttempt: number,
		retryCycle: number
	): Promise<ReceiptClaim> {
		const now = new Date();
		const lockToken = randomUUID();
		const leaseExpiresAt = new Date(now.getTime() + RECEIPT_LEASE_MS);
		try {
			await this.prisma.consumerReceipt.create({
				data: {
					eventId,
					consumer,
					payloadHash,
					status: ReportingConsumerReceiptStatus.PROCESSING,
					lockedAt: now,
					lockedBy: this.workerId,
					lockToken,
					leaseExpiresAt,
					retryCycle
				}
			});
			return { state: 'claimed', lockToken };
		} catch (error) {
			if (!this.isUniqueViolation(error)) throw error;
		}
		const receipt = await this.prisma.consumerReceipt.findUnique({
			where: { eventId_consumer: { eventId, consumer } }
		});
		if (!receipt) throw new Error('Consumer receipt disappeared');
		if (receipt.payloadHash !== payloadHash) {
			throw new InvalidReportingEventError(
				'eventId was reused with another payload'
			);
		}
		if (
			receipt.status === ReportingConsumerReceiptStatus.DELIVERED ||
			receipt.status === ReportingConsumerReceiptStatus.DEAD_LETTERED
		) {
			return { state: 'done' };
		}
		if (receipt.retryCycle !== retryCycle) {
			return retryCycle < receipt.retryCycle
				? { state: 'done' }
				: { state: 'active' };
		}
		const reclaimable =
			(receipt.status === ReportingConsumerReceiptStatus.RETRY_SCHEDULED &&
				receipt.retryAttempt === retryAttempt) ||
			(receipt.status === ReportingConsumerReceiptStatus.PROCESSING &&
				receipt.leaseExpiresAt !== null &&
				receipt.leaseExpiresAt <= now);
		if (!reclaimable) return { state: 'active' };
		const updated = await this.prisma.consumerReceipt.updateMany({
			where: {
				id: receipt.id,
				payloadHash,
				retryCycle,
				OR: [
					{
						status: ReportingConsumerReceiptStatus.RETRY_SCHEDULED,
						retryAttempt
					},
					{
						status: ReportingConsumerReceiptStatus.PROCESSING,
						leaseExpiresAt: { lte: now }
					}
				]
			},
			data: {
				status: ReportingConsumerReceiptStatus.PROCESSING,
				lockedAt: now,
				lockedBy: this.workerId,
				lockToken,
				leaseExpiresAt,
				retryAttempt: null,
				lastError: null
			}
		});
		return updated.count === 1
			? { state: 'claimed', lockToken }
			: { state: 'active' };
	}

	private async renew(
		eventId: string,
		consumer: string,
		lockToken: string
	): Promise<void> {
		const renewed = await this.prisma.consumerReceipt.updateMany({
			where: {
				eventId,
				consumer,
				status: ReportingConsumerReceiptStatus.PROCESSING,
				lockedBy: this.workerId,
				lockToken
			},
			data: {
				leaseExpiresAt: new Date(Date.now() + RECEIPT_LEASE_MS)
			}
		});
		if (renewed.count !== 1) {
			this.logger.warn(
				`Reporting consumer receipt lease lost eventId=${eventId}`
			);
		}
	}

	private async finalizeFailure(
		kind: ReportingConsumerKind,
		parsed: ReturnType<typeof parseReportingConsumeMessage>,
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
			const updated = await transaction.consumerReceipt.updateMany({
				where: {
					eventId: parsed.eventId,
					consumer,
					status: ReportingConsumerReceiptStatus.PROCESSING,
					lockedBy: this.workerId,
					lockToken
				},
				data: {
					status: shouldRetry
						? ReportingConsumerReceiptStatus.RETRY_SCHEDULED
						: ReportingConsumerReceiptStatus.DEAD_LETTERED,
					retryAttempt: shouldRetry ? nextAttempt : null,
					lockedAt: null,
					lockedBy: null,
					lockToken: null,
					leaseExpiresAt: null,
					lastError: errorMessage
				}
			});
			if (updated.count !== 1) {
				throw new Error('Consumer receipt lease was lost during failure');
			}
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
						'x-last-error': errorMessage.slice(0, 1000)
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

	private async deadLetterPoison(
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
		try {
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
			this.rabbitMq.ack(message);
		} catch (publishError) {
			this.logger.error(
				`Could not dead-letter reporting poison message: ${this.error(publishError)}`
			);
			this.rabbitMq.nack(message, true);
		}
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

	private prefetch(): number {
		const value = Number(
			this.config.get<string>('REPORTING_PREFETCH') || 10
		);
		if (!Number.isInteger(value) || value < 1 || value > 100) {
			throw new Error('REPORTING_PREFETCH must be between 1 and 100');
		}
		return value;
	}

	private isUniqueViolation(error: unknown): boolean {
		return (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === 'P2002'
		);
	}

	private error(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
