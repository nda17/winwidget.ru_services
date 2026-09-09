import {
	ConflictException,
	Injectable,
	OnApplicationBootstrap
} from '@nestjs/common';
import { Prisma, ConsumerFailure } from '@prisma/support-client';
import type { ConsumeMessage } from 'amqplib';
import type { Request } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import type { SupportActor } from '../auth/support-request';
import { enqueueSupportAdminAudit } from '../domain/support-admin-audit';
import { SupportPrismaService } from '../prisma/support-prisma.service';
import { SupportRuntimeService } from '../runtime/support-runtime.service';
import { SupportRabbitMqService } from '../messaging/support-rabbitmq.service';
import { SUPPORT_RETRY_DELAYS_MS } from '../messaging/support-messaging.constants';
import {
	SUPPORT_NOTIFICATION_KINDS,
	SUPPORT_OUTCOME_CONSUMER,
	SUPPORT_OUTCOME_EVENT,
	SUPPORT_OUTCOME_QUEUE
} from './support-notifications.service';
import { exactObject, supportTransaction } from './support-web.util';

const uuid = (value: unknown): value is string =>
	typeof value === 'string' &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value
	);
export interface SupportOutcome {
	schemaVersion: 1;
	eventId: string;
	eventType: typeof SUPPORT_OUTCOME_EVENT;
	occurredAt: string;
	sourceEventId: string;
	sourceKind: string;
	intentId: string;
	status: 'DELIVERED' | 'FAILED' | 'SKIPPED';
	reason: string | null;
}
export function parseSupportOutcome(value: unknown): SupportOutcome {
	if (
		!exactObject(value, [
			'schemaVersion',
			'eventId',
			'eventType',
			'occurredAt',
			'sourceEventId',
			'sourceKind',
			'intentId',
			'status',
			'reason'
		]) ||
		value.schemaVersion !== 1 ||
		value.eventType !== SUPPORT_OUTCOME_EVENT ||
		!uuid(value.eventId) ||
		!uuid(value.sourceEventId) ||
		!uuid(value.intentId) ||
		!SUPPORT_NOTIFICATION_KINDS.includes(
			value.sourceKind as (typeof SUPPORT_NOTIFICATION_KINDS)[number]
		) ||
		!['DELIVERED', 'FAILED', 'SKIPPED'].includes(String(value.status)) ||
		typeof value.occurredAt !== 'string' ||
		!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.occurredAt) ||
		!Number.isFinite(Date.parse(value.occurredAt)) ||
		!(
			value.reason === null ||
			(typeof value.reason === 'string' &&
				/^[A-Z0-9_]{1,120}$/.test(value.reason))
		)
	)
		throw new Error('SUPPORT_OUTCOME_INVALID');
	if (value.status === 'DELIVERED' && value.reason !== null)
		throw new Error('SUPPORT_OUTCOME_INVALID');
	return value as unknown as SupportOutcome;
}
@Injectable()
export class SupportOutcomeWorkerService implements OnApplicationBootstrap {
	constructor(
		private readonly prisma: SupportPrismaService,
		private readonly runtime: SupportRuntimeService,
		private readonly rabbit: SupportRabbitMqService
	) {}
	async onApplicationBootstrap() {
		if (this.runtime.workerEnabled && this.runtime.webChatEnabled)
			await this.rabbit.consume(
				message => this.handle(message),
				SUPPORT_OUTCOME_QUEUE
			);
	}
	async handle(message: ConsumeMessage): Promise<void> {
		let event: SupportOutcome;
		const hash = createHash('sha256')
			.update(message.content)
			.digest('hex');
		try {
			if (message.content.length > 8192) throw new Error('Oversize');
			event = parseSupportOutcome(
				JSON.parse(message.content.toString('utf8'))
			);
			if (
				message.properties.messageId !== event.eventId ||
				message.properties.type !== SUPPORT_OUTCOME_EVENT ||
				![SUPPORT_OUTCOME_EVENT, SUPPORT_OUTCOME_CONSUMER].includes(
					message.fields.routingKey
				)
			)
				throw new Error('Envelope mismatch');
		} catch {
			try {
				await this.poison(hash);
				this.rabbit.ack(message);
			} catch {
				this.rabbit.nack(message, true);
			}
			return;
		}
		const attempt = Number(
			message.properties.headers?.['x-retry-attempt'] ?? 0
		);
		const retryAttempt =
			Number.isSafeInteger(attempt) && attempt >= 0 && attempt <= 3
				? attempt
				: 0;
		const cycleRaw = Number(
			message.properties.headers?.['x-manual-retry-cycle'] ?? 0
		);
		const cycle =
			Number.isSafeInteger(cycleRaw) && cycleRaw >= 0 ? cycleRaw : 0;
		try {
			await supportTransaction(this.prisma, async tx => {
				const receipt = await tx.consumerReceipt.findUnique({
					where: {
						eventId_consumer: {
							eventId: event.eventId,
							consumer: SUPPORT_OUTCOME_CONSUMER
						}
					}
				});
				if (receipt && receipt.payloadHash !== hash)
					throw new Error('SUPPORT_OUTCOME_HASH_CONFLICT');
				if (
					receipt &&
					['DELIVERED', 'CLOSED_NO_RETRY', 'DEAD_LETTERED'].includes(
						receipt.status
					)
				)
					return;
				if (receipt && receipt.manualRetryCycle !== cycle) return;
				const token = randomUUID();
				await tx.consumerReceipt.upsert({
					where: {
						eventId_consumer: {
							eventId: event.eventId,
							consumer: SUPPORT_OUTCOME_CONSUMER
						}
					},
					create: {
						eventId: event.eventId,
						consumer: SUPPORT_OUTCOME_CONSUMER,
						payloadHash: hash,
						status: 'PROCESSING',
						lockedAt: new Date(),
						lockedBy: SUPPORT_OUTCOME_CONSUMER,
						lockToken: token,
						leaseExpiresAt: new Date(Date.now() + 30000)
					},
					update: {
						status: 'PROCESSING',
						lockedAt: new Date(),
						lockedBy: SUPPORT_OUTCOME_CONSUMER,
						lockToken: token,
						leaseExpiresAt: new Date(Date.now() + 30000)
					}
				});
				const intent = await tx.supportNotificationIntent.findUnique({
					where: { id: event.intentId }
				});
				if (
					!intent ||
					intent.eventId !== event.sourceEventId ||
					intent.kind !== event.sourceKind
				)
					throw new Error('SUPPORT_OUTCOME_INTENT_MISMATCH');
				// A successful manual retry may follow FAILED. A late failure cannot undo success.
				if (intent.status !== 'DELIVERED')
					await tx.supportNotificationIntent.update({
						where: { id: intent.id },
						data: {
							status: event.status,
							reason: event.reason,
							outcomeEventId: event.eventId
						}
					});
				await tx.consumerReceipt.update({
					where: {
						eventId_consumer: {
							eventId: event.eventId,
							consumer: SUPPORT_OUTCOME_CONSUMER
						}
					},
					data: {
						status: 'DELIVERED',
						deliveredAt: new Date(),
						lockedAt: null,
						lockedBy: null,
						lockToken: null,
						leaseExpiresAt: null,
						lastError: null
					}
				});
				await tx.consumerFailure.updateMany({
					where: {
						eventId: event.eventId,
						consumer: SUPPORT_OUTCOME_CONSUMER,
						status: { in: ['OPEN', 'RETRYING'] }
					},
					data: {
						status: 'RESOLVED',
						resolvedAt: new Date(),
						retryToken: null,
						retryLeaseExpiresAt: null
					}
				});
			});
			this.rabbit.ack(message);
		} catch (error) {
			try {
				if (
					error instanceof Error &&
					error.message === 'SUPPORT_OUTCOME_HASH_CONFLICT'
				)
					await this.poison(hash);
				else await this.fail(event, hash, retryAttempt, cycle);
				this.rabbit.ack(message);
			} catch {
				this.rabbit.nack(message, true);
			}
		}
	}
	private async fail(
		event: SupportOutcome,
		payloadHash: string,
		attempt: number,
		cycle: number
	) {
		await supportTransaction(this.prisma, async tx => {
			const previous = await tx.consumerReceipt.findUnique({
				where: {
					eventId_consumer: {
						eventId: event.eventId,
						consumer: SUPPORT_OUTCOME_CONSUMER
					}
				}
			});
			if (
				previous &&
				(['DELIVERED', 'CLOSED_NO_RETRY', 'DEAD_LETTERED'].includes(
					previous.status
				) ||
					previous.manualRetryCycle !== cycle)
			)
				return;
			if (previous && previous.payloadHash !== payloadHash)
				throw new Error('Receipt hash conflict');
			const dead = attempt >= SUPPORT_RETRY_DELAYS_MS.length;
			const reason = 'SUPPORT_OUTCOME_PROCESSING_FAILED';
			await tx.consumerReceipt.upsert({
				where: {
					eventId_consumer: {
						eventId: event.eventId,
						consumer: SUPPORT_OUTCOME_CONSUMER
					}
				},
				create: {
					eventId: event.eventId,
					consumer: SUPPORT_OUTCOME_CONSUMER,
					payloadHash,
					status: dead ? 'DEAD_LETTERED' : 'RETRY_SCHEDULED',
					lockToken: dead ? null : randomUUID(),
					retryAttempt: attempt + 1,
					manualRetryCycle: cycle
				},
				update: {
					status: dead ? 'DEAD_LETTERED' : 'RETRY_SCHEDULED',
					retryAttempt: attempt + 1,
					lastError: reason,
					lockedAt: null,
					lockedBy: null,
					lockToken: dead ? null : randomUUID(),
					leaseExpiresAt: null
				}
			});
			if (dead)
				await tx.consumerFailure.upsert({
					where: {
						eventId_consumer: {
							eventId: event.eventId,
							consumer: SUPPORT_OUTCOME_CONSUMER
						}
					},
					create: {
						eventId: event.eventId,
						consumer: SUPPORT_OUTCOME_CONSUMER,
						eventType: SUPPORT_OUTCOME_EVENT,
						routingKey: SUPPORT_OUTCOME_EVENT,
						payload: event as unknown as Prisma.InputJsonValue,
						payloadHash,
						correlationId: randomUUID(),
						lastError: reason,
						attempts: attempt + 1
					},
					update: {
						status: 'OPEN',
						lastError: reason,
						lastFailedAt: new Date(),
						attempts: { increment: 1 },
						retryToken: null,
						retryLeaseExpiresAt: null
					}
				});
			await tx.outboxEvent.createMany({
				data: [
					{
						messageId: event.eventId,
						deduplicationKey: `support-outcome:${event.eventId}:${cycle}:${attempt + 1}`,
						exchange: dead ? 'DEAD_LETTER' : 'RETRY',
						eventType: SUPPORT_OUTCOME_EVENT,
						routingKey: dead
							? `${SUPPORT_OUTCOME_CONSUMER}.dead-letter`
							: `${SUPPORT_OUTCOME_CONSUMER}.retry.${attempt + 1}`,
						payload: event as unknown as Prisma.InputJsonValue,
						headers: {
							'x-retry-attempt': attempt + 1,
							'x-manual-retry-cycle': cycle
						}
					}
				],
				skipDuplicates: true
			});
		});
	}
	private async poison(payloadHash: string) {
		await supportTransaction(this.prisma, async tx => {
			const existing = await tx.consumerFailure.findFirst({
				where: {
					consumer: SUPPORT_OUTCOME_CONSUMER,
					eventType: 'support.notification.poison.v1',
					payloadHash
				}
			});
			if (existing) return;
			const eventId = randomUUID();
			const safe = {
				schemaVersion: 1,
				eventId,
				eventType: 'support.notification.poison.v1',
				bodyHash: payloadHash
			};
			await tx.consumerFailure.create({
				data: {
					eventId,
					consumer: SUPPORT_OUTCOME_CONSUMER,
					eventType: 'support.notification.poison.v1',
					routingKey: SUPPORT_OUTCOME_EVENT,
					payload: safe,
					payloadHash,
					correlationId: randomUUID(),
					lastError: 'SUPPORT_OUTCOME_INVALID'
				}
			});
			await tx.outboxEvent.create({
				data: {
					messageId: eventId,
					eventType: 'support.notification.poison.v1',
					exchange: 'DEAD_LETTER',
					routingKey: `${SUPPORT_OUTCOME_CONSUMER}.dead-letter`,
					payload: safe
				}
			});
		});
	}
	async retry(
		tx: Prisma.TransactionClient,
		failure: ConsumerFailure,
		actor: SupportActor,
		request: Request
	) {
		if (failure.eventType !== SUPPORT_OUTCOME_EVENT)
			throw new ConflictException('Некорректное событие нельзя повторить');
		parseSupportOutcome(failure.payload);
		const cycle = failure.manualRetryCount + 1;
		const token = randomUUID();
		const changed = await tx.consumerFailure.updateMany({
			where: { id: failure.id, status: 'OPEN' },
			data: {
				status: 'RETRYING',
				manualRetryCount: cycle,
				retryRequestedAt: new Date(),
				retryRequestedById: actor.subject,
				retryToken: token,
				retryLeaseExpiresAt: new Date(Date.now() + 300000)
			}
		});
		const receipt = await tx.consumerReceipt.updateMany({
			where: {
				eventId: failure.eventId,
				consumer: SUPPORT_OUTCOME_CONSUMER,
				status: 'DEAD_LETTERED'
			},
			data: {
				status: 'RETRY_SCHEDULED',
				manualRetryCycle: cycle,
				retryAttempt: 0,
				lockToken: token,
				leaseExpiresAt: null
			}
		});
		if (changed.count !== 1 || receipt.count !== 1)
			throw new ConflictException('Delivery state changed');
		await tx.outboxEvent.create({
			data: {
				messageId: failure.eventId,
				deduplicationKey: `support-outcome:${failure.eventId}:manual:${cycle}`,
				exchange: 'MANUAL_RETRY',
				eventType: SUPPORT_OUTCOME_EVENT,
				routingKey: SUPPORT_OUTCOME_CONSUMER,
				payload: failure.payload as Prisma.InputJsonValue,
				headers: {
					'x-retry-attempt': 0,
					'x-manual-retry-cycle': cycle,
					'x-delivery-token': token
				}
			}
		});
		await enqueueSupportAdminAudit(tx, {
			actor,
			request,
			action: 'SUPPORT_DELIVERY_RETRY',
			description: 'Запрошен повтор результата уведомления поддержки',
			entityType: 'support_delivery_failure',
			entityId: failure.id,
			entityLabel: null,
			metadata: { eventId: failure.eventId, manualRetryCycle: cycle }
		});
		return { accepted: true as const, eventId: failure.eventId };
	}
	async close(
		tx: Prisma.TransactionClient,
		failure: ConsumerFailure,
		comment: string,
		actor: SupportActor,
		request: Request
	) {
		const changed = await tx.consumerFailure.updateMany({
			where: { id: failure.id, status: 'OPEN' },
			data: {
				status: 'CLOSED_NO_RETRY',
				resolvedAt: new Date(),
				resolutionComment: comment.trim(),
				retryToken: null,
				retryLeaseExpiresAt: null
			}
		});
		if (changed.count !== 1)
			throw new ConflictException('Delivery state changed');
		await tx.consumerReceipt.updateMany({
			where: {
				eventId: failure.eventId,
				consumer: SUPPORT_OUTCOME_CONSUMER,
				status: 'DEAD_LETTERED'
			},
			data: { status: 'CLOSED_NO_RETRY' }
		});
		await enqueueSupportAdminAudit(tx, {
			actor,
			request,
			action: 'SUPPORT_DELIVERY_CLOSE',
			description: 'Ошибка результата уведомления поддержки закрыта',
			entityType: 'support_delivery_failure',
			entityId: failure.id,
			entityLabel: null,
			metadata: { eventId: failure.eventId }
		});
		return { closed: true as const };
	}
}
