import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import {
	ConsumerFailureStatus,
	ConsumerReceiptStatus,
	OutboxExchange,
	Prisma
} from '@prisma/identity-client';
import type { ConsumeMessage } from 'amqplib';
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { safeError, sha256 } from '../common/identity.util';
import { IdentityEventsService } from '../events/identity-events.service';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { IdentityRuntimeService } from '../runtime/identity-runtime.service';
import { IdentityOwnershipService } from '../runtime/identity-ownership.service';
import {
	DEAD_ROUTING_KEY,
	DESTINATION_EVENT,
	RETRY_DELAYS_MS,
	retryRoutingKey
} from './messaging.constants';
import { IdentityRabbitMqService } from './rabbitmq.service';

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_KINDS = new Set([
	'telegram',
	'limit-telegram',
	'campaign-telegram',
	'subscription-expiry-telegram'
]);
const CONSUMER = 'telegram-destination-unavailable';
const LEASE_MS = 60_000;

export interface DestinationEvent {
	schemaVersion: 1;
	eventType: typeof DESTINATION_EVENT;
	sourceEventId: string;
	sourceKind: string;
	destination: { telegramChatId: string };
	normalizedCode: string;
	occurredAt: string;
}

@Injectable()
export class DestinationUnavailableWorkerService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(
		DestinationUnavailableWorkerService.name
	);
	private readonly instanceId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private ready = false;
	private starting = false;
	private ownershipTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly prisma: IdentityPrismaService,
		private readonly runtime: IdentityRuntimeService,
		private readonly rabbit: IdentityRabbitMqService,
		private readonly events: IdentityEventsService,
		private readonly ownership: IdentityOwnershipService
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.runtime.workerEnabled) return;
		await this.startWhenOwned();
		if (!this.ready) {
			this.ownershipTimer = setInterval(() => {
				void this.startWhenOwned().catch(error => {
					this.logger.error(
						`Destination consumer start failed: ${safeError(error)}`
					);
				});
			}, 1_000);
			this.ownershipTimer.unref();
		}
	}

	onApplicationShutdown(): void {
		if (this.ownershipTimer) clearInterval(this.ownershipTimer);
		this.ownershipTimer = null;
		this.ready = false;
	}

	isReady(): boolean {
		return (
			!this.runtime.workerEnabled ||
			(this.ready && this.rabbit.isConsumerReady())
		);
	}

	private async startWhenOwned(): Promise<void> {
		if (this.ready || this.starting || !(await this.ownership.isActive()))
			return;
		this.starting = true;
		try {
			await this.rabbit.consume(message => this.handle(message));
			this.ready = true;
			if (this.ownershipTimer) clearInterval(this.ownershipTimer);
			this.ownershipTimer = null;
		} finally {
			this.starting = false;
		}
	}

	private async handle(message: ConsumeMessage): Promise<void> {
		let parsed: {
			event: DestinationEvent;
			eventId: string;
			payloadHash: string;
		};
		try {
			parsed = this.parse(message);
		} catch (error) {
			try {
				await this.parkPoison(message, error);
				this.rabbit.ack(message);
			} catch (stateError) {
				this.logger.error(
					`Poison parking failed: ${safeError(stateError)}`
				);
				this.rabbit.nack(message, true);
			}
			return;
		}
		const headers = this.headers(message);
		const retryAttempt = this.integer(headers['x-retry-attempt'], 0);
		const deliveryToken =
			this.uuid(headers['x-delivery-token']) || randomUUID();
		let claim: 'claimed' | 'delivered' | 'busy';
		try {
			claim = await this.claim(
				parsed.eventId,
				parsed.payloadHash,
				deliveryToken,
				retryAttempt
			);
		} catch (error) {
			try {
				await this.parkPoison(message, error, parsed.eventId);
				this.rabbit.ack(message);
			} catch (stateError) {
				this.logger.error(
					`Receipt poison parking failed: ${safeError(stateError)}`
				);
				this.rabbit.nack(message, true);
			}
			return;
		}
		if (claim === 'delivered') {
			this.rabbit.ack(message);
			return;
		}
		if (claim === 'busy') {
			this.rabbit.nack(message, true);
			return;
		}
		try {
			await this.deliver(parsed.eventId, deliveryToken, parsed.event);
			this.rabbit.ack(message);
		} catch (error) {
			try {
				await this.fail(
					parsed.eventId,
					deliveryToken,
					parsed.payloadHash,
					parsed.event,
					retryAttempt,
					headers,
					error
				);
				this.rabbit.ack(message);
			} catch (stateError) {
				this.logger.error(
					`Destination failure state error: ${safeError(stateError)}`
				);
				this.rabbit.nack(message, true);
			}
		}
	}

	private async claim(
		eventId: string,
		payloadHash: string,
		deliveryToken: string,
		retryAttempt: number
	): Promise<'claimed' | 'delivered' | 'busy'> {
		const now = new Date();
		const expires = new Date(now.getTime() + LEASE_MS);
		return this.prisma.$transaction(
			async transaction => {
				const created = await transaction.consumerReceipt.createMany({
					data: [
						{
							eventId,
							consumer: CONSUMER,
							payloadHash,
							status: ConsumerReceiptStatus.PROCESSING,
							lockedAt: now,
							lockedBy: this.instanceId,
							lockToken: deliveryToken,
							leaseExpiresAt: expires,
							retryAttempt
						}
					],
					skipDuplicates: true
				});
				if (created.count === 1) return 'claimed';
				const current = await transaction.consumerReceipt.findUnique({
					where: { eventId_consumer: { eventId, consumer: CONSUMER } }
				});
				if (!current || current.payloadHash !== payloadHash) {
					throw new Error('Consumer receipt payload mismatch');
				}
				if (
					current.status === ConsumerReceiptStatus.DELIVERED ||
					current.status === ConsumerReceiptStatus.CLOSED_NO_RETRY
				) {
					return 'delivered';
				}
				const changed = await transaction.consumerReceipt.updateMany({
					where: {
						eventId,
						consumer: CONSUMER,
						payloadHash,
						OR: [
							{
								status: ConsumerReceiptStatus.RETRY_SCHEDULED,
								lockToken: deliveryToken
							},
							{
								status: ConsumerReceiptStatus.PROCESSING,
								leaseExpiresAt: { lte: now }
							}
						]
					},
					data: {
						status: ConsumerReceiptStatus.PROCESSING,
						lockedAt: now,
						lockedBy: this.instanceId,
						lockToken: deliveryToken,
						leaseExpiresAt: expires,
						retryAttempt,
						lastError: null
					}
				});
				return changed.count === 1 ? 'claimed' : 'busy';
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	private async deliver(
		eventId: string,
		deliveryToken: string,
		event: DestinationEvent
	): Promise<void> {
		const occurredAt = new Date(event.occurredAt);
		await this.prisma.$transaction(
			async transaction => {
				const channel =
					await transaction.telegramNotificationChannel.findUnique({
						where: { chatId: event.destination.telegramChatId }
					});
				if (channel?.isActive && channel.updatedAt <= occurredAt) {
					const changed =
						await transaction.telegramNotificationChannel.updateMany({
							where: {
								id: channel.id,
								isActive: true,
								updatedAt: { lte: occurredAt }
							},
							data: { isActive: false, disabledAt: occurredAt }
						});
					if (changed.count === 1) {
						await this.events.emitUserChanged(
							transaction,
							channel.userId,
							eventId
						);
					}
				}
				const receipt = await transaction.consumerReceipt.updateMany({
					where: {
						eventId,
						consumer: CONSUMER,
						status: ConsumerReceiptStatus.PROCESSING,
						lockToken: deliveryToken
					},
					data: {
						status: ConsumerReceiptStatus.DELIVERED,
						deliveredAt: new Date(),
						lockedAt: null,
						lockedBy: null,
						lockToken: null,
						leaseExpiresAt: null,
						lastError: null
					}
				});
				if (receipt.count !== 1)
					throw new Error('Consumer delivery lease was lost');
				await transaction.consumerFailure.updateMany({
					where: { eventId, consumer: CONSUMER },
					data: {
						status: ConsumerFailureStatus.RESOLVED,
						resolvedAt: new Date(),
						retryToken: null,
						retryLeaseExpiresAt: null
					}
				});
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	private async fail(
		eventId: string,
		deliveryToken: string,
		payloadHash: string,
		event: DestinationEvent,
		retryAttempt: number,
		headers: Record<string, string | number | boolean>,
		error: unknown
	): Promise<void> {
		const reason = safeError(error);
		const nextAttempt = retryAttempt + 1;
		await this.prisma.$transaction(
			async transaction => {
				const current = await transaction.consumerReceipt.findFirst({
					where: {
						eventId,
						consumer: CONSUMER,
						status: ConsumerReceiptStatus.PROCESSING,
						lockToken: deliveryToken
					}
				});
				if (!current) throw new Error('Consumer failure lease was lost');
				if (nextAttempt <= RETRY_DELAYS_MS.length) {
					const nextToken = randomUUID();
					await transaction.consumerReceipt.update({
						where: { id: current.id },
						data: {
							status: ConsumerReceiptStatus.RETRY_SCHEDULED,
							lockedAt: null,
							lockedBy: null,
							lockToken: nextToken,
							leaseExpiresAt: null,
							retryAttempt: nextAttempt,
							lastError: reason
						}
					});
					await transaction.outboxEvent.create({
						data: {
							messageId: randomUUID(),
							deduplicationKey: `${CONSUMER}:${eventId}:retry:${nextAttempt}:${current.manualRetryCycle}`,
							exchange: OutboxExchange.RETRY,
							eventType: DESTINATION_EVENT,
							routingKey: retryRoutingKey(nextAttempt),
							payload: event as unknown as Prisma.InputJsonValue,
							headers: {
								...headers,
								'x-original-event-id': eventId,
								'x-delivery-token': nextToken,
								'x-retry-attempt': nextAttempt
							}
						}
					});
					return;
				}
				await transaction.consumerReceipt.update({
					where: { id: current.id },
					data: {
						status: ConsumerReceiptStatus.DEAD_LETTERED,
						lockedAt: null,
						lockedBy: null,
						lockToken: null,
						leaseExpiresAt: null,
						lastError: reason
					}
				});
				await transaction.consumerFailure.upsert({
					where: { eventId_consumer: { eventId, consumer: CONSUMER } },
					create: {
						eventId,
						consumer: CONSUMER,
						eventType: DESTINATION_EVENT,
						routingKey: DESTINATION_EVENT,
						payload: event as unknown as Prisma.InputJsonValue,
						headers,
						payloadHash,
						correlationId: eventId,
						status: ConsumerFailureStatus.OPEN,
						attempts: nextAttempt,
						lastError: reason
					},
					update: {
						status: ConsumerFailureStatus.OPEN,
						attempts: nextAttempt,
						lastError: reason,
						lastFailedAt: new Date(),
						resolvedAt: null,
						retryToken: null,
						retryLeaseExpiresAt: null
					}
				});
				await transaction.outboxEvent.create({
					data: {
						messageId: randomUUID(),
						deduplicationKey: `${CONSUMER}:${eventId}:dead-letter:${current.manualRetryCycle}`,
						exchange: OutboxExchange.DEAD_LETTER,
						eventType: DESTINATION_EVENT,
						routingKey: DEAD_ROUTING_KEY,
						payload: event as unknown as Prisma.InputJsonValue,
						headers: {
							...headers,
							'x-original-event-id': eventId,
							'x-retry-attempt': nextAttempt
						}
					}
				});
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	private parse(message: ConsumeMessage) {
		let value: unknown;
		try {
			value = JSON.parse(message.content.toString('utf8'));
		} catch {
			throw new Error('Destination event is not JSON');
		}
		const event = parseDestinationEvent(value);
		const headers = this.headers(message);
		const eventId =
			this.uuid(headers['x-original-event-id']) ||
			this.uuid(message.properties.messageId) ||
			'';
		if (!eventId)
			throw new Error('Destination event messageId is invalid');
		return {
			event,
			eventId,
			payloadHash: semanticJsonHash(event)
		};
	}

	private async parkPoison(
		message: ConsumeMessage,
		error: unknown,
		conflictingEventId?: string
	): Promise<void> {
		const bodyHash = sha256(message.content);
		const poisonId = deterministicUuid(
			`${conflictingEventId || message.properties.messageId || ''}\0${bodyHash}`
		);
		const reason = safeError(error);
		const headers = this.headers(message);
		const payload = {
			schemaVersion: 1,
			eventType: 'identity.consumer.poison.v1',
			poisonEventId: poisonId,
			consumer: CONSUMER,
			sourceEventId: conflictingEventId || null,
			bodySha256: bodyHash,
			contentLength: message.content.length,
			reason,
			occurredAt: new Date().toISOString()
		};
		await this.prisma.$transaction(async transaction => {
			await transaction.consumerReceipt.upsert({
				where: {
					eventId_consumer: { eventId: poisonId, consumer: CONSUMER }
				},
				create: {
					eventId: poisonId,
					consumer: CONSUMER,
					payloadHash: bodyHash,
					status: ConsumerReceiptStatus.DEAD_LETTERED,
					lastError: reason
				},
				update: {
					status: ConsumerReceiptStatus.DEAD_LETTERED,
					lastError: reason
				}
			});
			await transaction.consumerFailure.upsert({
				where: {
					eventId_consumer: { eventId: poisonId, consumer: CONSUMER }
				},
				create: {
					eventId: poisonId,
					consumer: CONSUMER,
					eventType: 'identity.consumer.poison.v1',
					routingKey: DEAD_ROUTING_KEY,
					payload,
					headers,
					payloadHash: bodyHash,
					correlationId: conflictingEventId || poisonId,
					status: ConsumerFailureStatus.OPEN,
					attempts: 1,
					lastError: reason
				},
				update: {
					lastFailedAt: new Date(),
					lastError: reason,
					attempts: { increment: 1 }
				}
			});
			await transaction.outboxEvent.createMany({
				data: [
					{
						messageId: poisonId,
						deduplicationKey: `${CONSUMER}:poison:${poisonId}`,
						exchange: OutboxExchange.DEAD_LETTER,
						eventType: 'identity.consumer.poison.v1',
						routingKey: DEAD_ROUTING_KEY,
						payload,
						headers: {
							...headers,
							...(conflictingEventId
								? { 'x-conflicting-original-event-id': conflictingEventId }
								: {})
						}
					}
				],
				skipDuplicates: true
			});
		});
	}

	private headers(
		message: ConsumeMessage
	): Record<string, string | number | boolean> {
		return Object.fromEntries(
			Object.entries(message.properties.headers || {}).filter(
				(entry): entry is [string, string | number | boolean] =>
					typeof entry[1] === 'string' ||
					typeof entry[1] === 'number' ||
					typeof entry[1] === 'boolean'
			)
		);
	}

	private uuid(value: unknown): string | null {
		return typeof value === 'string' && UUID.test(value) ? value : null;
	}

	private integer(value: unknown, fallback: number): number {
		const number = Number(value);
		return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
	}
}

export function parseDestinationEvent(value: unknown): DestinationEvent {
	if (!jsonRecord(value)) throw new Error('Destination event is invalid');
	exactJsonKeys(value, [
		'schemaVersion',
		'eventType',
		'sourceEventId',
		'sourceKind',
		'destination',
		'normalizedCode',
		'occurredAt'
	]);
	if (!jsonRecord(value.destination)) {
		throw new Error('Destination event destination is invalid');
	}
	const destination = value.destination;
	exactJsonKeys(destination, ['telegramChatId']);
	if (
		value.schemaVersion !== 1 ||
		value.eventType !== DESTINATION_EVENT ||
		typeof value.sourceEventId !== 'string' ||
		!UUID.test(value.sourceEventId) ||
		typeof value.sourceKind !== 'string' ||
		!SOURCE_KINDS.has(value.sourceKind) ||
		typeof destination.telegramChatId !== 'string' ||
		!destination.telegramChatId.trim() ||
		typeof value.normalizedCode !== 'string' ||
		!value.normalizedCode ||
		typeof value.occurredAt !== 'string' ||
		!Number.isFinite(Date.parse(value.occurredAt))
	) {
		throw new Error('Destination event contract is invalid');
	}
	return value as unknown as DestinationEvent;
}

function jsonRecord(value: unknown): value is Record<string, unknown> {
	return (
		Boolean(value) && typeof value === 'object' && !Array.isArray(value)
	);
}

function exactJsonKeys(
	value: Record<string, unknown>,
	keys: string[]
): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new Error('Destination event has unexpected fields');
	}
}

export function semanticJsonHash(value: unknown): string {
	return sha256(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
	if (
		value === null ||
		typeof value === 'boolean' ||
		typeof value === 'string'
	) {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value))
			throw new Error('JSON number is not finite');
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(item => canonicalJson(item)).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(
				([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`
			)
			.join(',')}}`;
	}
	throw new Error('Value is not canonical JSON');
}

function deterministicUuid(value: string): string {
	const bytes = createHash('sha256')
		.update(value)
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
