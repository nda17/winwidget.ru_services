import { ReportingMetricsService } from '../metrics/reporting-metrics.service';
import {
	InvalidReportingEventError,
	reportingPayloadHash
} from '../projections/reporting-event.contract';
import { ReportingRuntimeService } from '../runtime/reporting-runtime.service';
import { ReportingConsumerFailureFinalizerService } from './reporting-consumer-failure-finalizer.service';
import {
	ReportingConsumerReceiptClaim,
	ReportingConsumerReceiptService
} from './reporting-consumer-receipt.service';
import {
	ParsedReportingConsumeMessage,
	ReportingConsumerRouterService
} from './reporting-consumer-router.service';
import {
	REPORTING_CONSUMERS,
	REPORTING_CONSUMER_KINDS,
	ReportingConsumerKind
} from './reporting-messaging.constants';
import { ReportingRabbitMqService } from './reporting-rabbitmq.service';
import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConsumeMessage } from 'amqplib';

const RECEIPT_RENEW_INTERVAL_MS = 60_000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 20_000;

@Injectable()
export class ReportingWorkerService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(ReportingWorkerService.name);
	private readonly activeHandlers = new Set<Promise<void>>();
	private ready = false;
	private shuttingDown = false;

	constructor(
		private readonly rabbitMq: ReportingRabbitMqService,
		private readonly runtime: ReportingRuntimeService,
		private readonly config: ConfigService,
		private readonly metrics: ReportingMetricsService,
		private readonly router: ReportingConsumerRouterService,
		private readonly receipts: ReportingConsumerReceiptService,
		private readonly failures: ReportingConsumerFailureFinalizerService
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
		let parsed: ParsedReportingConsumeMessage;
		try {
			parsed = this.router.parse(kind, message);
		} catch (error) {
			await this.deadLetterPoison(kind, message, error);
			return;
		}
		const consumer = REPORTING_CONSUMERS[kind];
		const payloadHash = reportingPayloadHash(parsed.payload);
		let claim: ReportingConsumerReceiptClaim;
		try {
			claim = await this.receipts.claim(
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

		const renewal = this.startRenewal(
			parsed.eventId,
			consumer,
			claim.lockToken
		);
		try {
			await this.router.dispatch(kind, parsed, {
				eventId: parsed.eventId,
				consumer,
				lockToken: claim.lockToken
			});
			this.metrics.increment('consumer_events_delivered_total');
			this.rabbitMq.ack(message);
		} catch (error) {
			try {
				await this.failures.finalize(
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

	private startRenewal(
		eventId: string,
		consumer: string,
		lockToken: string
	): NodeJS.Timeout {
		const renewal = setInterval(() => {
			void this.receipts
				.renew(eventId, consumer, lockToken)
				.then(renewed => {
					if (!renewed) {
						this.logger.warn(
							`Reporting consumer receipt lease lost eventId=${eventId}`
						);
					}
				})
				.catch(error => {
					this.metrics.increment('consumer_lease_renew_failures_total');
					this.logger.warn(
						`Reporting receipt lease renewal failed eventId=${eventId}: ${this.error(error)}`
					);
				});
		}, RECEIPT_RENEW_INTERVAL_MS);
		renewal.unref();
		return renewal;
	}

	private async deadLetterPoison(
		kind: ReportingConsumerKind,
		message: ConsumeMessage,
		error: unknown
	): Promise<void> {
		try {
			await this.failures.publishPoison(kind, message, error);
			this.rabbitMq.ack(message);
		} catch (publishError) {
			this.logger.error(
				`Could not dead-letter reporting poison message: ${this.error(publishError)}`
			);
			this.rabbitMq.nack(message, true);
		}
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

	private error(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
