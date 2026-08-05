import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	Prisma,
	WidgetsConsumerFailureStatus,
	WidgetsConsumerReceiptStatus,
	WidgetsOutboxExchange,
	WidgetsOutboxStatus
} from '@prisma/widgets-client';
import type { ConsumeMessage } from 'amqplib';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import {
	InvalidWidgetsProjectionEventError,
	parseWidgetsProjectionMessage,
	projectionPayloadHash,
	WidgetsProjectionKind
} from '../projections/widgets-projection.contract';
import { WidgetsProjectionService } from '../projections/widgets-projection.service';
import { WidgetsRuntimeService } from '../runtime/widgets-runtime.service';
import {
	getWidgetsDeadLetterRoutingKey,
	getWidgetsManualRetryRoutingKey,
	getWidgetsRetryRoutingKey,
	WIDGETS_CONSUMERS,
	WIDGETS_DEAD_LETTER_EXCHANGE,
	WIDGETS_PROJECTION_KINDS,
	WIDGETS_RETRY_DELAYS_MS
} from './widgets-messaging.constants';
import { WidgetsRabbitMqService } from './widgets-rabbitmq.service';

const LEASE_MS = 5 * 60_000;
type Claim =
	| { state: 'claimed'; token: string }
	| { state: 'done' }
	| { state: 'active'; availableAt: Date };

@Injectable()
export class WidgetsProjectionWorkerService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(
		WidgetsProjectionWorkerService.name
	);
	private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private readonly active = new Set<Promise<void>>();
	private ready = false;
	private stopping = false;

	constructor(
		private readonly rabbit: WidgetsRabbitMqService,
		private readonly prisma: WidgetsPrismaService,
		private readonly projections: WidgetsProjectionService,
		private readonly runtime: WidgetsRuntimeService,
		private readonly config: ConfigService
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.runtime.workerEnabled) return;
		for (const kind of WIDGETS_PROJECTION_KINDS) {
			await this.rabbit.consume(
				kind,
				message => this.track(this.handle(kind, message)),
				this.prefetch()
			);
		}
		this.ready = true;
	}

	isReady(): boolean {
		return !this.runtime.workerEnabled || (this.ready && !this.stopping);
	}

	async beforeApplicationShutdown(): Promise<void> {
		this.ready = false;
		this.stopping = true;
		if (this.active.size)
			await Promise.race([
				Promise.allSettled([...this.active]),
				new Promise(resolve => setTimeout(resolve, 20_000).unref())
			]);
	}

	private track(promise: Promise<void>): Promise<void> {
		this.active.add(promise);
		void promise.finally(() => this.active.delete(promise));
		return promise;
	}

	private async handle(
		kind: WidgetsProjectionKind,
		message: ConsumeMessage
	): Promise<void> {
		let parsed: ReturnType<typeof parseWidgetsProjectionMessage>;
		try {
			parsed = parseWidgetsProjectionMessage(kind, message);
		} catch (error) {
			await this.poison(kind, message, error);
			return;
		}
		const consumer = WIDGETS_CONSUMERS[kind];
		const hash = projectionPayloadHash(parsed.event);
		let claim: Claim;
		try {
			claim = await this.claim(
				parsed.event.eventId,
				consumer,
				hash,
				parsed.retryAttempt,
				parsed.manualRetryCycle
			);
		} catch (error) {
			if (error instanceof InvalidWidgetsProjectionEventError) {
				await this.poison(kind, message, error);
				return;
			}
			this.rabbit.nack(message, true);
			return;
		}
		if (claim.state === 'done') {
			this.rabbit.ack(message);
			return;
		}
		if (claim.state === 'active') {
			try {
				await this.deferActive(
					kind,
					parsed,
					consumer,
					claim.availableAt,
					message
				);
				this.rabbit.ack(message);
			} catch {
				this.rabbit.nack(message, true);
			}
			return;
		}
		try {
			await this.prisma.$transaction(async transaction => {
				await this.projections.applyInTransaction(
					transaction,
					parsed.event
				);
				const delivered =
					await transaction.widgetsConsumerReceipt.updateMany({
						where: {
							eventId: parsed.event.eventId,
							consumer,
							status: WidgetsConsumerReceiptStatus.PROCESSING,
							lockedBy: this.workerId,
							lockToken: claim.token
						},
						data: {
							status: WidgetsConsumerReceiptStatus.DELIVERED,
							deliveredAt: new Date(),
							lockedAt: null,
							lockedBy: null,
							lockToken: null,
							leaseExpiresAt: null,
							retryAttempt: null,
							lastError: null
						}
					});
				if (delivered.count !== 1)
					throw new Error('Projection receipt lease was lost');
				await transaction.widgetsConsumerFailure.updateMany({
					where: { eventId: parsed.event.eventId, consumer },
					data: {
						status: WidgetsConsumerFailureStatus.RESOLVED,
						resolvedAt: new Date(),
						retryRequestedAt: null,
						retryRequestedById: null,
						retryToken: null,
						retryLeaseExpiresAt: null
					}
				});
			});
			this.rabbit.ack(message);
		} catch (error) {
			try {
				await this.fail(
					kind,
					parsed,
					consumer,
					claim.token,
					error,
					message
				);
				this.rabbit.ack(message);
			} catch {
				this.rabbit.nack(message, true);
			}
		}
	}

	private async claim(
		eventId: string,
		consumer: string,
		payloadHash: string,
		attempt: number,
		cycle: number
	): Promise<Claim> {
		const now = new Date();
		const token = randomUUID();
		const lease = new Date(now.getTime() + LEASE_MS);
		try {
			await this.prisma.widgetsConsumerReceipt.create({
				data: {
					eventId,
					consumer,
					payloadHash,
					status: WidgetsConsumerReceiptStatus.PROCESSING,
					lockedAt: now,
					lockedBy: this.workerId,
					lockToken: token,
					leaseExpiresAt: lease,
					retryCycle: cycle
				}
			});
			return { state: 'claimed', token };
		} catch (error) {
			if (!this.unique(error)) throw error;
		}
		const receipt = await this.prisma.widgetsConsumerReceipt.findUnique({
			where: { eventId_consumer: { eventId, consumer } }
		});
		if (!receipt) throw new Error('Projection receipt disappeared');
		if (receipt.payloadHash !== payloadHash)
			throw new InvalidWidgetsProjectionEventError(
				'eventId was reused with another payload'
			);
		if (
			new Set<WidgetsConsumerReceiptStatus>([
				WidgetsConsumerReceiptStatus.DELIVERED,
				WidgetsConsumerReceiptStatus.DEAD_LETTERED
			]).has(receipt.status)
		)
			return { state: 'done' };
		if (cycle < receipt.retryCycle) return { state: 'done' };
		if (cycle > receipt.retryCycle) {
			throw new InvalidWidgetsProjectionEventError(
				'Projection retry cycle is ahead of receipt state'
			);
		}
		if (receipt.status === WidgetsConsumerReceiptStatus.RETRY_SCHEDULED) {
			const expectedAttempt = receipt.retryAttempt as number;
			if (attempt < expectedAttempt) return { state: 'done' };
			if (attempt > expectedAttempt) {
				throw new InvalidWidgetsProjectionEventError(
					'Projection retry attempt is ahead of receipt state'
				);
			}
		}
		const processing =
			receipt.status === WidgetsConsumerReceiptStatus.PROCESSING;
		if (
			processing &&
			receipt.leaseExpiresAt &&
			receipt.leaseExpiresAt > now
		) {
			return { state: 'active', availableAt: receipt.leaseExpiresAt };
		}
		const updated = await this.prisma.widgetsConsumerReceipt.updateMany({
			where: {
				id: receipt.id,
				payloadHash,
				retryCycle: cycle,
				...(processing
					? {
							status: WidgetsConsumerReceiptStatus.PROCESSING,
							leaseExpiresAt: { lte: now }
						}
					: {
							status: WidgetsConsumerReceiptStatus.RETRY_SCHEDULED,
							retryAttempt: attempt
						})
			},
			data: {
				status: WidgetsConsumerReceiptStatus.PROCESSING,
				lockedAt: now,
				lockedBy: this.workerId,
				lockToken: token,
				leaseExpiresAt: lease,
				retryAttempt: null,
				lastError: null
			}
		});
		if (updated.count === 1) return { state: 'claimed', token };
		throw new Error('Projection receipt state changed concurrently');
	}

	private async deferActive(
		kind: WidgetsProjectionKind,
		parsed: ReturnType<typeof parseWidgetsProjectionMessage>,
		consumer: string,
		availableAt: Date,
		message: ConsumeMessage
	): Promise<void> {
		try {
			// Identity/Billing own the shared event routes. Lease recovery stays on
			// the Widgets-local manual exchange instead of impersonating a producer.
			await this.prisma.widgetsOutboxEvent.create({
				data: {
					messageId: parsed.event.eventId,
					deduplicationKey: `projection-active-recovery:${consumer}:${parsed.event.eventId}:${parsed.manualRetryCycle}:${availableAt.toISOString()}`,
					exchange: WidgetsOutboxExchange.MANUAL_RETRY,
					eventType: parsed.event.eventType,
					routingKey: getWidgetsManualRetryRoutingKey(kind),
					payload: parsed.event as unknown as Prisma.InputJsonValue,
					headers: {
						'x-correlation-id': this.correlation(
							message,
							parsed.event.eventId
						),
						'x-retry-attempt': parsed.retryAttempt,
						'x-manual-retry-cycle': parsed.manualRetryCycle,
						'x-lease-recovery': true
					},
					availableAt: new Date(
						Math.max(Date.now() + 250, availableAt.getTime())
					)
				}
			});
		} catch (error) {
			if (!this.unique(error)) throw error;
		}
	}

	private async fail(
		kind: WidgetsProjectionKind,
		parsed: ReturnType<typeof parseWidgetsProjectionMessage>,
		consumer: string,
		token: string,
		error: unknown,
		message: ConsumeMessage
	): Promise<void> {
		const next = parsed.retryAttempt + 1;
		const retry =
			!(error instanceof InvalidWidgetsProjectionEventError) &&
			next <= WIDGETS_RETRY_DELAYS_MS.length;
		const reason = this.error(error).slice(0, 2000);
		const correlationId = this.correlation(message, parsed.event.eventId);
		await this.prisma.$transaction(async transaction => {
			const updated = await transaction.widgetsConsumerReceipt.updateMany({
				where: {
					eventId: parsed.event.eventId,
					consumer,
					status: WidgetsConsumerReceiptStatus.PROCESSING,
					lockedBy: this.workerId,
					lockToken: token
				},
				data: {
					status: retry
						? WidgetsConsumerReceiptStatus.RETRY_SCHEDULED
						: WidgetsConsumerReceiptStatus.DEAD_LETTERED,
					retryAttempt: retry ? next : null,
					lockedAt: null,
					lockedBy: null,
					lockToken: null,
					leaseExpiresAt: null,
					lastError: reason
				}
			});
			if (updated.count !== 1)
				throw new Error(
					'Projection receipt lease was lost during failure'
				);
			await transaction.widgetsOutboxEvent.create({
				data: {
					messageId: parsed.event.eventId,
					deduplicationKey: retry
						? `projection-retry:${consumer}:${parsed.event.eventId}:${parsed.manualRetryCycle}:${next}`
						: `projection-dead:${consumer}:${parsed.event.eventId}:${parsed.manualRetryCycle}`,
					exchange: retry
						? WidgetsOutboxExchange.RETRY
						: WidgetsOutboxExchange.DEAD_LETTER,
					eventType: parsed.event.eventType,
					routingKey: retry
						? getWidgetsRetryRoutingKey(kind, next - 1)
						: getWidgetsDeadLetterRoutingKey(kind),
					payload: parsed.event as unknown as Prisma.InputJsonValue,
					headers: {
						'x-correlation-id': correlationId,
						'x-retry-attempt': retry ? next : parsed.retryAttempt,
						'x-manual-retry-cycle': parsed.manualRetryCycle,
						'x-last-error': reason.slice(0, 1000)
					},
					status: WidgetsOutboxStatus.PENDING
				}
			});
			if (!retry)
				await transaction.widgetsConsumerFailure.upsert({
					where: {
						eventId_consumer: { eventId: parsed.event.eventId, consumer }
					},
					create: {
						eventId: parsed.event.eventId,
						consumer,
						eventType: parsed.event.eventType,
						routingKey: parsed.event.eventType,
						payload: parsed.event as unknown as Prisma.InputJsonValue,
						payloadHash: projectionPayloadHash(parsed.event),
						correlationId,
						status: WidgetsConsumerFailureStatus.OPEN,
						manualRetryCount: parsed.manualRetryCycle,
						lastError: reason
					},
					update: {
						payload: parsed.event as unknown as Prisma.InputJsonValue,
						payloadHash: projectionPayloadHash(parsed.event),
						status: WidgetsConsumerFailureStatus.OPEN,
						lastError: reason,
						lastFailedAt: new Date(),
						retryRequestedAt: null,
						retryRequestedById: null,
						retryToken: null,
						retryLeaseExpiresAt: null,
						resolvedAt: null,
						detailsPurgedAt: null
					}
				});
		});
	}

	private async poison(
		kind: WidgetsProjectionKind,
		message: ConsumeMessage,
		error: unknown
	): Promise<void> {
		const id =
			typeof message.properties.messageId === 'string'
				? message.properties.messageId
				: randomUUID();
		try {
			await this.rabbit.publish(
				WIDGETS_DEAD_LETTER_EXCHANGE,
				getWidgetsDeadLetterRoutingKey(kind),
				{
					schemaVersion: 1,
					eventType: 'widgets.poison.v1',
					poisonId: id,
					contentSha256: createHash('sha256')
						.update(message.content)
						.digest('hex'),
					contentBytes: message.content.length,
					safeReason: this.error(error).slice(0, 1000),
					occurredAt: new Date().toISOString()
				},
				{
					messageId: id,
					type: 'widgets.poison.v1',
					correlationId: this.correlation(message, id)
				}
			);
			this.rabbit.ack(message);
		} catch {
			this.rabbit.nack(message, true);
		}
	}

	private correlation(message: ConsumeMessage, fallback: string): string {
		const value =
			message.properties.headers?.['x-correlation-id'] ||
			message.properties.correlationId;
		return typeof value === 'string' &&
			/^[A-Za-z0-9._:-]{1,128}$/.test(value)
			? value
			: fallback;
	}
	private unique(error: unknown): boolean {
		return (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === 'P2002'
		);
	}
	private prefetch(): number {
		const value = Number(
			this.config.get<string>('WIDGETS_PREFETCH') || 10
		);
		if (!Number.isInteger(value) || value < 1 || value > 100)
			throw new Error('WIDGETS_PREFETCH must be between 1 and 100');
		return value;
	}
	private error(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
