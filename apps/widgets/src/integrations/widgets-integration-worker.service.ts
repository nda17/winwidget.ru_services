import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	IntegrationDeliveryReceiptStatus,
	Prisma,
	WidgetsOutboxExchange,
	WidgetsOutboxStatus
} from '@prisma/widgets-client';
import type { ConsumeMessage } from 'amqplib';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import { WidgetsRuntimeService } from '../runtime/widgets-runtime.service';
import {
	getWidgetsDeadLetterRoutingKey,
	getWidgetsRetryRoutingKey,
	WIDGETS_PROVIDER_KINDS,
	WIDGETS_RETRY_DELAYS_MS,
	WidgetsProviderKind
} from '../messaging/widgets-messaging.constants';
import { WidgetsRabbitMqService } from '../messaging/widgets-rabbitmq.service';
import {
	assertWidgetsIntegrationMessageSize,
	WidgetsIntegrationDeliveryService
} from './widgets-integration-delivery.service';
import {
	classifyWidgetsIntegrationError,
	exhaustedWidgetsRetryClassification,
	expiredWidgetsRetryClassification,
	WidgetsIntegrationErrorClassification
} from './widgets-integration-error-classifier';
import { deleteTerminalWidgetsCredentialSnapshot } from './widgets-credential-snapshot-lifecycle';

const LEASE_MS = 5 * 60_000;
const AUTOMATIC_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
class InvalidWidgetsIntegrationMessageError extends Error {}
type Claim =
	| { state: 'claimed'; token: string }
	| { state: 'done' }
	| { state: 'active'; availableAt: Date; retryToken: string | null };

@Injectable()
export class WidgetsIntegrationWorkerService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(
		WidgetsIntegrationWorkerService.name
	);
	private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private readonly active = new Set<Promise<void>>();
	private ready = false;
	private stopping = false;

	constructor(
		private readonly rabbit: WidgetsRabbitMqService,
		private readonly prisma: WidgetsPrismaService,
		private readonly delivery: WidgetsIntegrationDeliveryService,
		private readonly runtime: WidgetsRuntimeService,
		private readonly config: ConfigService
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.runtime.workerEnabled) return;
		this.maxMessageBytes();
		for (const kind of WIDGETS_PROVIDER_KINDS) {
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
		void promise.then(
			() => this.active.delete(promise),
			() => this.active.delete(promise)
		);
		return promise;
	}

	private async handle(
		kind: WidgetsProviderKind,
		message: ConsumeMessage
	): Promise<void> {
		const rawEventId = message.properties.messageId;
		let eventId: string;
		let payload: ReturnType<WidgetsIntegrationDeliveryService['parse']>;
		let attempt: number;
		let cycle: number;
		let retryToken: string | null;
		try {
			assertWidgetsIntegrationMessageSize(
				message.content,
				this.maxMessageBytes()
			);
			if (
				typeof rawEventId !== 'string' ||
				!this.uuid(rawEventId) ||
				message.properties.type !== 'lead.integration.requested.v2'
			)
				throw new Error('AMQP envelope is invalid');
			eventId = rawEventId;
			payload = this.delivery.parse(
				JSON.parse(message.content.toString('utf8')),
				kind
			);
			attempt = this.nonNegativeHeader(message, 'x-retry-attempt');
			cycle = this.nonNegativeHeader(message, 'x-manual-retry-cycle');
			retryToken = this.uuidHeader(message, 'x-delivery-token');
			if ((attempt > 0 || cycle > 0) && !retryToken) {
				throw new InvalidWidgetsIntegrationMessageError(
					'Retry delivery token is required'
				);
			}
			if (attempt === 0 && cycle === 0 && retryToken) {
				throw new InvalidWidgetsIntegrationMessageError(
					'Initial delivery cannot contain a retry token'
				);
			}
		} catch (error) {
			await this.poison(kind, message, error);
			return;
		}
		const hash = createHash('sha256')
			.update(this.canonical(payload))
			.digest('hex');
		let claim: Claim;
		try {
			claim = await this.claim(
				eventId,
				kind,
				hash,
				attempt,
				cycle,
				retryToken
			);
		} catch (error) {
			if (error instanceof InvalidWidgetsIntegrationMessageError) {
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
					eventId,
					payload,
					attempt,
					cycle,
					claim,
					message
				);
				this.rabbit.ack(message);
			} catch {
				this.rabbit.nack(message, true);
			}
			return;
		}
		try {
			await this.delivery.deliver(kind, eventId, payload);
			await this.prisma.$transaction(async transaction => {
				const deliveredAt = new Date();
				const updated =
					await transaction.integrationDeliveryReceipt.updateMany({
						where: {
							eventId,
							integration: kind,
							status: IntegrationDeliveryReceiptStatus.PROCESSING,
							lockedBy: this.workerId,
							lockToken: claim.token
						},
						data: {
							status: IntegrationDeliveryReceiptStatus.DELIVERED,
							deliveredAt,
							lockedAt: null,
							lockedBy: null,
							lockToken: null,
							leaseExpiresAt: null,
							retryAttempt: null,
							retryAvailableAt: null,
							retryToken: null,
							lastError: null
						}
					});
				if (updated.count !== 1)
					throw new Error('Integration receipt lease was lost');
				await transaction.integrationDeliveryFailure.updateMany({
					where: { eventId, integration: kind, resolvedAt: null },
					data: {
						resolvedAt: deliveredAt,
						resolution: 'DELIVERED',
						resolutionComment: null,
						resolvedById: null,
						retryingAt: null,
						activeRetryToken: null,
						retryLeaseExpiresAt: null
					}
				});
				await deleteTerminalWidgetsCredentialSnapshot(transaction, {
					eventId,
					integration: kind
				});
			});
			this.rabbit.ack(message);
		} catch (error) {
			try {
				await this.fail(
					kind,
					eventId,
					payload,
					attempt,
					cycle,
					claim.token,
					error,
					message
				);
				this.rabbit.ack(message);
			} catch (failureError) {
				this.logger.error(
					`Integration failure finalization failed: ${this.error(failureError)}`
				);
				this.rabbit.nack(message, true);
			}
		}
	}

	private async claim(
		eventId: string,
		kind: WidgetsProviderKind,
		hash: string,
		attempt: number,
		cycle: number,
		retryToken: string | null
	): Promise<Claim> {
		const now = new Date();
		const token = randomUUID();
		const lease = new Date(now.getTime() + LEASE_MS);
		if (attempt === 0 && cycle === 0 && retryToken === null) {
			try {
				await this.prisma.integrationDeliveryReceipt.create({
					data: {
						eventId,
						integration: kind,
						payloadHash: hash,
						status: IntegrationDeliveryReceiptStatus.PROCESSING,
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
		}
		const receipt =
			await this.prisma.integrationDeliveryReceipt.findUnique({
				where: { eventId_integration: { eventId, integration: kind } }
			});
		if (!receipt) {
			throw new InvalidWidgetsIntegrationMessageError(
				'Retry delivery receipt is missing'
			);
		}
		if (receipt.payloadHash !== hash) {
			throw new InvalidWidgetsIntegrationMessageError(
				'eventId was reused with another integration payload'
			);
		}
		if (
			new Set<IntegrationDeliveryReceiptStatus>([
				IntegrationDeliveryReceiptStatus.DELIVERED,
				IntegrationDeliveryReceiptStatus.DEAD_LETTERED,
				IntegrationDeliveryReceiptStatus.CLOSED_NO_RETRY
			]).has(receipt.status)
		)
			return { state: 'done' };
		if (cycle < receipt.retryCycle) return { state: 'done' };
		if (cycle > receipt.retryCycle) {
			throw new InvalidWidgetsIntegrationMessageError(
				'Integration retry cycle is ahead of receipt state'
			);
		}
		const processing =
			receipt.status === IntegrationDeliveryReceiptStatus.PROCESSING;
		if (
			processing &&
			receipt.leaseExpiresAt &&
			receipt.leaseExpiresAt > now
		) {
			return {
				state: 'active',
				availableAt: receipt.leaseExpiresAt,
				retryToken
			};
		}
		if (
			receipt.status === IntegrationDeliveryReceiptStatus.RETRY_SCHEDULED
		) {
			const expectedAttempt = receipt.retryAttempt as number;
			if (attempt < expectedAttempt) return { state: 'done' };
			if (attempt > expectedAttempt) {
				throw new InvalidWidgetsIntegrationMessageError(
					'Integration retry attempt is ahead of receipt state'
				);
			}
			if (!retryToken || retryToken !== receipt.retryToken) {
				throw new InvalidWidgetsIntegrationMessageError(
					'Integration retry token does not match receipt state'
				);
			}
			if (receipt.retryAvailableAt && receipt.retryAvailableAt > now) {
				return {
					state: 'active',
					availableAt: receipt.retryAvailableAt,
					retryToken: receipt.retryToken
				};
			}
		}
		const updated =
			await this.prisma.integrationDeliveryReceipt.updateMany({
				where: {
					id: receipt.id,
					payloadHash: hash,
					retryCycle: cycle,
					...(processing
						? {
								status: IntegrationDeliveryReceiptStatus.PROCESSING,
								leaseExpiresAt: { lte: now }
							}
						: {
								status: IntegrationDeliveryReceiptStatus.RETRY_SCHEDULED,
								retryAttempt: attempt,
								retryAvailableAt: { lte: now },
								retryToken
							})
				},
				data: {
					status: IntegrationDeliveryReceiptStatus.PROCESSING,
					lockedAt: now,
					lockedBy: this.workerId,
					lockToken: token,
					leaseExpiresAt: lease,
					retryAttempt: null,
					retryAvailableAt: null,
					retryToken: null,
					lastError: null
				}
			});
		if (updated.count === 1) return { state: 'claimed', token };
		throw new Error('Integration receipt state changed concurrently');
	}

	private async deferActive(
		kind: WidgetsProviderKind,
		eventId: string,
		payload: ReturnType<WidgetsIntegrationDeliveryService['parse']>,
		attempt: number,
		cycle: number,
		claim: Extract<Claim, { state: 'active' }>,
		message: ConsumeMessage
	): Promise<void> {
		const firstFailedAt = this.firstFailedAtHeader(message);
		try {
			await this.prisma.widgetsOutboxEvent.create({
				data: {
					messageId: eventId,
					deduplicationKey: `integration-active-recovery:${kind}:${eventId}:${cycle}:${claim.availableAt.toISOString()}`,
					exchange: WidgetsOutboxExchange.EVENTS,
					eventType: 'lead.integration.requested.v2',
					routingKey: `lead.integration.${kind}.v2`,
					payload: payload as unknown as Prisma.InputJsonValue,
					headers: {
						'x-correlation-id': this.correlation(message, eventId),
						'x-retry-attempt': attempt,
						'x-manual-retry-cycle': cycle,
						...(claim.retryToken && {
							'x-delivery-token': claim.retryToken
						}),
						...(firstFailedAt && { 'x-first-failed-at': firstFailedAt }),
						'x-lease-recovery': true
					},
					availableAt: new Date(
						Math.max(Date.now() + 250, claim.availableAt.getTime())
					)
				}
			});
		} catch (error) {
			if (!this.unique(error)) throw error;
		}
	}

	private async fail(
		kind: WidgetsProviderKind,
		eventId: string,
		payload: ReturnType<WidgetsIntegrationDeliveryService['parse']>,
		attempt: number,
		cycle: number,
		token: string,
		error: unknown,
		message: ConsumeMessage
	): Promise<void> {
		const now = new Date();
		const next = attempt + 1;
		const firstFailedAt = this.firstFailedAt(message, now);
		let classification = classifyWidgetsIntegrationError(kind, error);
		const retryBudget = classification.recognized
			? WIDGETS_RETRY_DELAYS_MS.length
			: 1;
		const queueDelay = WIDGETS_RETRY_DELAYS_MS[next - 1] || 0;
		const requestedDelay = Math.max(
			queueDelay,
			classification.retryDelayMs || 0
		);
		const budgetAvailable = next <= retryBudget;
		const windowAvailable =
			now.getTime() + requestedDelay <=
			firstFailedAt.getTime() + AUTOMATIC_RETRY_WINDOW_MS;
		if (classification.retryable && !windowAvailable) {
			classification = expiredWidgetsRetryClassification();
		} else if (classification.retryable && !budgetAvailable) {
			classification = exhaustedWidgetsRetryClassification(classification);
		}
		const retry =
			classification.retryable && budgetAvailable && windowAvailable;
		const retryAvailableAt = retry
			? new Date(now.getTime() + requestedDelay)
			: null;
		const outboxAvailableAt = retry
			? new Date(now.getTime() + Math.max(0, requestedDelay - queueDelay))
			: now;
		const scheduledToken = retry ? randomUUID() : null;
		const safeHeaders = this.classificationHeaders(
			classification,
			firstFailedAt
		);
		await this.prisma.$transaction(async transaction => {
			const updated =
				await transaction.integrationDeliveryReceipt.updateMany({
					where: {
						eventId,
						integration: kind,
						status: IntegrationDeliveryReceiptStatus.PROCESSING,
						lockedBy: this.workerId,
						lockToken: token
					},
					data: {
						status: retry
							? IntegrationDeliveryReceiptStatus.RETRY_SCHEDULED
							: IntegrationDeliveryReceiptStatus.DEAD_LETTERED,
						retryAttempt: retry ? next : null,
						retryAvailableAt,
						retryToken: scheduledToken,
						lockedAt: null,
						lockedBy: null,
						lockToken: null,
						leaseExpiresAt: null,
						lastError: classification.safeReason
					}
				});
			if (updated.count !== 1)
				throw new Error(
					'Integration receipt lease was lost during failure'
				);
			await transaction.widgetsOutboxEvent.create({
				data: {
					messageId: eventId,
					deduplicationKey: retry
						? `integration-retry:${kind}:${eventId}:${cycle}:${next}:${scheduledToken}`
						: `integration-dead:${kind}:${eventId}:${cycle}`,
					exchange: retry
						? WidgetsOutboxExchange.RETRY
						: WidgetsOutboxExchange.DEAD_LETTER,
					eventType: 'lead.integration.requested.v2',
					routingKey: retry
						? getWidgetsRetryRoutingKey(kind, next - 1)
						: getWidgetsDeadLetterRoutingKey(kind),
					payload: payload as unknown as Prisma.InputJsonValue,
					headers: {
						'x-correlation-id': this.correlation(message, eventId),
						'x-retry-attempt': retry ? next : attempt,
						'x-manual-retry-cycle': cycle,
						...(scheduledToken && { 'x-delivery-token': scheduledToken }),
						...safeHeaders,
						'x-last-error': classification.safeReason.slice(0, 1000)
					},
					availableAt: outboxAvailableAt,
					status: WidgetsOutboxStatus.PENDING
				}
			});
			if (!retry)
				await transaction.integrationDeliveryFailure.upsert({
					where: { eventId_integration: { eventId, integration: kind } },
					create: {
						eventId,
						integration: kind,
						routingKey: `lead.integration.${kind}.v2`,
						payload: payload as unknown as Prisma.InputJsonValue,
						headers: safeHeaders,
						attempts: next,
						lastError: classification.safeReason,
						category: classification.category,
						normalizedCode: classification.normalizedCode,
						safeReason: classification.safeReason,
						httpStatus: classification.httpStatus,
						providerCode: classification.providerCode,
						retryable: classification.retryable,
						classificationVersion: classification.classificationVersion,
						firstFailedAt,
						failedAt: now
					},
					update: {
						payload: payload as unknown as Prisma.InputJsonValue,
						headers: safeHeaders,
						attempts: next,
						lastError: classification.safeReason,
						category: classification.category,
						normalizedCode: classification.normalizedCode,
						safeReason: classification.safeReason,
						httpStatus: classification.httpStatus,
						providerCode: classification.providerCode,
						retryable: classification.retryable,
						classificationVersion: classification.classificationVersion,
						firstFailedAt,
						failedAt: now,
						retryingAt: null,
						activeRetryToken: null,
						retryLeaseExpiresAt: null,
						manualRetryCount: cycle,
						resolvedAt: null,
						resolution: null,
						resolutionComment: null,
						resolvedById: null,
						detailsPurgedAt: null
					}
				});
		});
	}

	private async poison(
		kind: WidgetsProviderKind,
		message: ConsumeMessage,
		error: unknown
	): Promise<void> {
		const id =
			typeof message.properties.messageId === 'string' &&
			this.uuid(message.properties.messageId)
				? message.properties.messageId
				: randomUUID();
		try {
			await this.rabbit.publish(
				'winwidget.dead-letter',
				getWidgetsDeadLetterRoutingKey(kind),
				{
					schemaVersion: 1,
					eventType: 'widgets.integration.poison.v1',
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
					type: 'widgets.integration.poison.v1',
					correlationId: id
				}
			);
			this.rabbit.ack(message);
		} catch {
			this.rabbit.nack(message, true);
		}
	}

	private classificationHeaders(
		classification: WidgetsIntegrationErrorClassification,
		firstFailedAt: Date
	): Record<string, string | number | boolean> {
		return {
			'x-first-failed-at': firstFailedAt.toISOString(),
			'x-error-category': classification.category,
			'x-error-code': classification.normalizedCode,
			'x-error-retryable': classification.retryable,
			'x-classification-version': classification.classificationVersion,
			'x-safe-reason': classification.safeReason,
			...(classification.httpStatus !== null && {
				'x-http-status': classification.httpStatus
			}),
			...(classification.providerCode && {
				'x-provider-code': classification.providerCode
			})
		};
	}

	private firstFailedAt(message: ConsumeMessage, fallback: Date): Date {
		const value = this.firstFailedAtHeader(message);
		if (!value) return fallback;
		const timestamp = Date.parse(value);
		return timestamp <= fallback.getTime() + 60_000
			? new Date(timestamp)
			: fallback;
	}

	private firstFailedAtHeader(message: ConsumeMessage): string | null {
		const value = this.stringHeader(message, 'x-first-failed-at');
		if (!value || Number.isNaN(Date.parse(value))) return null;
		return new Date(value).toISOString() === value ? value : null;
	}

	private stringHeader(
		message: ConsumeMessage,
		name: string
	): string | null {
		const value = message.properties.headers?.[name];
		if (typeof value === 'string') return value;
		if (Buffer.isBuffer(value)) return value.toString('utf8');
		return null;
	}

	private nonNegativeHeader(
		message: ConsumeMessage,
		name: string
	): number {
		const raw = message.properties.headers?.[name];
		if (raw === undefined || raw === null) return 0;
		const value = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
		const parsed = typeof value === 'number' ? value : Number(value);
		if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000_000) {
			throw new InvalidWidgetsIntegrationMessageError(
				`${name} must be a bounded non-negative integer`
			);
		}
		return parsed;
	}

	private uuidHeader(
		message: ConsumeMessage,
		name: string
	): string | null {
		const raw = message.properties.headers?.[name];
		if (raw === undefined || raw === null) return null;
		const value = Buffer.isBuffer(raw)
			? raw.toString('utf8')
			: typeof raw === 'string'
				? raw
				: '';
		if (!this.uuid(value)) {
			throw new InvalidWidgetsIntegrationMessageError(
				`${name} must be a UUID`
			);
		}
		return value;
	}

	private canonical(value: unknown): string {
		if (value === null || typeof value !== 'object')
			return JSON.stringify(value);
		if (Array.isArray(value))
			return `[${value.map(item => this.canonical(item)).join(',')}]`;
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${this.canonical(record[key])}`)
			.join(',')}}`;
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
	private uuid(value: string): boolean {
		return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value
		);
	}
	private prefetch(): number {
		const value = Number(
			this.config.get<string>('WIDGETS_PROVIDER_PREFETCH') || 10
		);
		if (!Number.isInteger(value) || value < 1 || value > 100)
			throw new Error(
				'WIDGETS_PROVIDER_PREFETCH must be between 1 and 100'
			);
		return value;
	}
	private maxMessageBytes(): number {
		const value = Number(
			this.config.get<string>('RABBITMQ_MAX_MESSAGE_BYTES') || 256 * 1024
		);
		if (
			!Number.isInteger(value) ||
			value < 1024 ||
			value > 10 * 1024 * 1024
		)
			throw new Error(
				'RABBITMQ_MAX_MESSAGE_BYTES must be between 1024 and 10485760'
			);
		return value;
	}
	private error(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
