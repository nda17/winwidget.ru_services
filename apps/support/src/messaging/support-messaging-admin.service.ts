import {
	ConflictException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import {
	ConsumerFailureStatus,
	ConsumerReceiptStatus,
	OutboxExchange,
	OutboxStatus,
	Prisma,
	SupportInboxStatus
} from '@prisma/support-client';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import type { SupportActor } from '../auth/support-request';
import { enqueueSupportAdminAudit } from '../domain/support-admin-audit';
import { SupportPrismaService } from '../prisma/support-prisma.service';
import {
	MANUAL_RETRY_EXCHANGE,
	SUPPORT_WEBHOOK_CONSUMER,
	SUPPORT_WEBHOOK_EVENT
} from './support-messaging.constants';

@Injectable()
export class SupportMessagingAdminService {
	constructor(private readonly prisma: SupportPrismaService) {}

	async list(page: number, limit: number) {
		const skip = (page - 1) * limit;
		const [items, total] = await this.prisma.$transaction([
			this.prisma.consumerFailure.findMany({
				orderBy: [{ lastFailedAt: 'desc' }, { id: 'desc' }],
				skip,
				take: limit,
				select: {
					id: true,
					eventId: true,
					consumer: true,
					status: true,
					attempts: true,
					manualRetryCount: true,
					lastError: true,
					lastFailedAt: true,
					resolvedAt: true,
					resolutionComment: true
				}
			}),
			this.prisma.consumerFailure.count()
		]);
		return {
			schemaVersion: 1,
			items: items.map(item => ({
				...item,
				lastFailedAt: item.lastFailedAt.toISOString(),
				resolvedAt: item.resolvedAt?.toISOString() || null
			})),
			pagination: { page, limit, total, pages: Math.ceil(total / limit) }
		};
	}

	async retry(
		id: string,
		actor: SupportActor,
		request: Request
	): Promise<{ accepted: true; eventId: string }> {
		return this.prisma.$transaction(
			async transaction => {
				const failure = await transaction.consumerFailure.findUnique({
					where: { id }
				});
				if (!failure)
					throw new NotFoundException('Support failure not found');
				if (failure.status !== ConsumerFailureStatus.OPEN) {
					throw new ConflictException('Support failure is not open');
				}
				if (failure.eventType === 'support.poison.v1') {
					throw new ConflictException(
						'Support poison message cannot be retried; close it after investigation'
					);
				}
				const inboxId = this.inboxId(failure.payload);
				const token = randomUUID();
				const now = new Date();
				const retryLeaseExpiresAt = new Date(now.getTime() + 5 * 60_000);
				const changedFailure =
					await transaction.consumerFailure.updateMany({
						where: { id, status: ConsumerFailureStatus.OPEN },
						data: {
							status: ConsumerFailureStatus.RETRYING,
							manualRetryCount: { increment: 1 },
							retryRequestedAt: now,
							retryRequestedById: actor.subject,
							retryToken: token,
							retryLeaseExpiresAt,
							resolvedAt: null,
							resolutionComment: null
						}
					});
				const receipt = await transaction.consumerReceipt.updateMany({
					where: {
						eventId: failure.eventId,
						consumer: SUPPORT_WEBHOOK_CONSUMER,
						status: ConsumerReceiptStatus.DEAD_LETTERED
					},
					data: {
						status: ConsumerReceiptStatus.RETRY_SCHEDULED,
						manualRetryCycle: { increment: 1 },
						retryAttempt: 0,
						lockToken: token,
						lastError: null
					}
				});
				const inbox = await transaction.telegramWebhookInbox.updateMany({
					where: {
						id: inboxId,
						status: SupportInboxStatus.DEAD_LETTERED
					},
					data: {
						status: SupportInboxStatus.RETRY_SCHEDULED,
						lastError: null
					}
				});
				if (
					changedFailure.count !== 1 ||
					receipt.count !== 1 ||
					inbox.count !== 1
				) {
					throw new ConflictException('Support retry state changed');
				}
				await transaction.outboxEvent.create({
					data: {
						messageId: failure.eventId,
						deduplicationKey: `${failure.eventId}:manual:${failure.manualRetryCount + 1}`,
						exchange: OutboxExchange.MANUAL_RETRY,
						eventType: SUPPORT_WEBHOOK_EVENT,
						routingKey: SUPPORT_WEBHOOK_CONSUMER,
						aggregateType: 'support.telegram-webhook',
						aggregateId: inboxId,
						headers: {
							'x-correlation-id': failure.correlationId,
							'x-retry-attempt': 0,
							'x-delivery-token': token,
							'x-source-exchange': MANUAL_RETRY_EXCHANGE
						},
						payload: failure.payload as Prisma.InputJsonValue
					}
				});
				await enqueueSupportAdminAudit(transaction, {
					actor,
					action: 'SUPPORT_DELIVERY_RETRY',
					description: 'Запрошен ручной retry сообщения Support_bot',
					entityType: 'support_delivery_failure',
					entityId: failure.id,
					entityLabel: 'Support_bot delivery',
					metadata: {
						eventId: failure.eventId,
						manualRetryCycle: failure.manualRetryCount + 1
					},
					request
				});
				return { accepted: true as const, eventId: failure.eventId };
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	async close(
		id: string,
		comment: string,
		actor: SupportActor,
		request: Request
	): Promise<{ closed: true }> {
		return this.prisma.$transaction(
			async transaction => {
				const failure = await transaction.consumerFailure.findUnique({
					where: { id }
				});
				if (!failure)
					throw new NotFoundException('Support failure not found');
				if (failure.status !== ConsumerFailureStatus.OPEN) {
					throw new ConflictException('Support failure is not open');
				}
				const poison = failure.eventType === 'support.poison.v1';
				const inboxId = poison ? null : this.inboxId(failure.payload);
				const now = new Date();
				const changed = await transaction.consumerFailure.updateMany({
					where: { id, status: ConsumerFailureStatus.OPEN },
					data: {
						status: ConsumerFailureStatus.CLOSED_NO_RETRY,
						resolvedAt: now,
						resolutionComment: comment.trim(),
						retryToken: null,
						retryLeaseExpiresAt: null
					}
				});
				const receipt = poison
					? { count: 1 }
					: await transaction.consumerReceipt.updateMany({
							where: {
								eventId: failure.eventId,
								consumer: SUPPORT_WEBHOOK_CONSUMER,
								status: ConsumerReceiptStatus.DEAD_LETTERED
							},
							data: { status: ConsumerReceiptStatus.CLOSED_NO_RETRY }
						});
				const inbox = poison
					? { count: 1 }
					: await transaction.telegramWebhookInbox.updateMany({
							where: {
								id: inboxId!,
								status: SupportInboxStatus.DEAD_LETTERED
							},
							data: {
								status: SupportInboxStatus.CLOSED_NO_RETRY,
								processedAt: now
							}
						});
				if (
					changed.count !== 1 ||
					receipt.count !== 1 ||
					inbox.count !== 1
				) {
					throw new ConflictException('Support close state changed');
				}
				await enqueueSupportAdminAudit(transaction, {
					actor,
					action: 'SUPPORT_DELIVERY_CLOSE',
					description: 'Support delivery закрыта без повторной отправки',
					entityType: 'support_delivery_failure',
					entityId: failure.id,
					entityLabel: 'Support_bot delivery',
					metadata: { eventId: failure.eventId },
					request
				});
				return { closed: true as const };
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
		);
	}

	async overview() {
		const now = new Date();
		const staleBefore = new Date(now.getTime() - 2 * 60_000);
		const lastDay = new Date(now.getTime() - 24 * 60 * 60_000);
		const [
			outbox,
			oldestPending,
			oldestExpiredProcessing,
			unresolvedFailures,
			retryingFailures,
			processedLast24Hours,
			heartbeats
		] = await Promise.all([
			this.prisma.outboxEvent.groupBy({
				by: ['status'],
				_count: { _all: true }
			}),
			this.prisma.outboxEvent.findFirst({
				where: { status: OutboxStatus.PENDING, availableAt: { lte: now } },
				orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
				select: { availableAt: true }
			}),
			this.prisma.outboxEvent.findFirst({
				where: {
					status: OutboxStatus.PROCESSING,
					leaseExpiresAt: { lte: now }
				},
				orderBy: { leaseExpiresAt: 'asc' },
				select: { leaseExpiresAt: true }
			}),
			this.prisma.consumerFailure.count({
				where: {
					status: {
						in: [
							ConsumerFailureStatus.OPEN,
							ConsumerFailureStatus.RETRYING
						]
					}
				}
			}),
			this.prisma.consumerFailure.count({
				where: { status: ConsumerFailureStatus.RETRYING }
			}),
			this.prisma.consumerReceipt.count({
				where: {
					status: ConsumerReceiptStatus.DELIVERED,
					deliveredAt: { gte: lastDay }
				}
			}),
			this.prisma.messagingHeartbeat.findMany({
				where: { lastSeenAt: { gte: staleBefore } },
				orderBy: { lastSeenAt: 'desc' },
				select: { service: true, lastSeenAt: true }
			})
		]);
		const groupedOutbox = Object.fromEntries(
			outbox.map(item => [item.status, item._count._all])
		) as Partial<Record<OutboxStatus, number>>;
		const oldestPendingAt =
			[
				oldestPending?.availableAt.toISOString() || null,
				oldestExpiredProcessing?.leaseExpiresAt?.toISOString() || null
			]
				.filter((value): value is string => Boolean(value))
				.sort()[0] || null;
		const services = [
			'support-api',
			'support-worker',
			'support-outbox-publisher'
		] as const;
		return {
			schemaVersion: 1,
			generatedAt: now.toISOString(),
			outbox: {
				PENDING: groupedOutbox.PENDING || 0,
				PUBLISHING: groupedOutbox.PROCESSING || 0,
				PUBLISHED: groupedOutbox.PUBLISHED || 0,
				FAILED: 0
			},
			oldestPendingAt,
			unresolvedFailures,
			retryingFailures,
			processedLast24Hours,
			heartbeats: services.map(service => {
				const instances = heartbeats.filter(
					item => item.service === service
				);
				return {
					service,
					status: instances.length ? ('ok' as const) : ('down' as const),
					activeInstances: instances.length,
					lastSeenAt: instances[0]?.lastSeenAt.toISOString() || null
				};
			})
		};
	}

	private inboxId(value: Prisma.JsonValue): string {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new ConflictException('Support failure payload is invalid');
		}
		const inboxId = (value as Record<string, unknown>).inboxId;
		if (
			typeof inboxId !== 'string' ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				inboxId
			)
		) {
			throw new ConflictException('Support failure payload is invalid');
		}
		return inboxId;
	}
}
