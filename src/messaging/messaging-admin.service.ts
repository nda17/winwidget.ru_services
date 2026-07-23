import { LeadIntegrationEventPayload } from '@/messaging/lead-integration-event';
import {
	getManualRetryRoutingKey,
	INTEGRATION_KINDS,
	IntegrationKind,
	OUTBOX_EVENT_TYPE
} from '@/messaging/messaging.constants';
import { RabbitMqManagementService } from '@/messaging/rabbitmq-management.service';
import { PrismaService } from '@/prisma.service';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException
} from '@nestjs/common';
import {
	IntegrationDeliveryFailure,
	IntegrationDeliveryReceiptStatus,
	MailingCampaignStatus,
	OutboxEventStatus,
	Prisma
} from '@prisma/client';

interface FailureFilters {
	integration?: string;
	status?: string;
}

@Injectable()
export class MessagingAdminService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly rabbitManagement: RabbitMqManagementService
	) {}

	async getOverview() {
		const staleBefore = new Date(Date.now() - 30_000);
		const [
			outboxGroups,
			oldestPending,
			unresolvedFailures,
			retryingFailures,
			deliveredLast24Hours,
			heartbeats,
			queues
		] = await Promise.all([
			this.prisma.outboxEvent.groupBy({
				by: ['status'],
				_count: { _all: true }
			}),
			this.prisma.outboxEvent.findFirst({
				where: {
					status: {
						in: [OutboxEventStatus.PENDING, OutboxEventStatus.PUBLISHING]
					}
				},
				orderBy: { createdAt: 'asc' },
				select: { createdAt: true }
			}),
			this.prisma.integrationDeliveryFailure.count({
				where: { resolvedAt: null }
			}),
			this.prisma.integrationDeliveryFailure.count({
				where: {
					resolvedAt: null,
					retryingAt: { not: null }
				}
			}),
			this.prisma.integrationDeliveryReceipt.count({
				where: {
					status: IntegrationDeliveryReceiptStatus.DELIVERED,
					deliveredAt: {
						gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
					}
				}
			}),
			this.prisma.messagingHeartbeat.findMany({
				orderBy: { lastSeenAt: 'desc' }
			}),
			this.rabbitManagement
				.getMessagingQueues()
				.then(queues => ({ queues, error: null }))
				.catch(error => ({
					queues: [],
					error:
						error instanceof Error ? error.message : 'RabbitMQ недоступен'
				}))
		]);

		const outbox = Object.fromEntries(
			Object.values(OutboxEventStatus).map(status => [status, 0])
		) as Record<OutboxEventStatus, number>;
		for (const group of outboxGroups) {
			outbox[group.status] = group._count._all;
		}

		const serviceHeartbeats = [
			'outbox-publisher',
			'integration-worker'
		].map(service => {
			const instances = heartbeats.filter(
				item => item.service === service
			);
			const latest = instances[0]?.lastSeenAt || null;
			return {
				service,
				status: latest && latest >= staleBefore ? 'ok' : 'down',
				activeInstances: instances.filter(
					item => item.lastSeenAt >= staleBefore
				).length,
				lastSeenAt: latest?.toISOString() || null
			};
		});

		return {
			generatedAt: new Date().toISOString(),
			outbox,
			oldestPendingAt: oldestPending?.createdAt.toISOString() || null,
			unresolvedFailures,
			retryingFailures,
			deliveredLast24Hours,
			rabbitMqError: queues.error,
			heartbeats: serviceHeartbeats,
			queues: queues.queues.map(queue => ({
				name: queue.name,
				messages: queue.messages,
				ready: queue.messages_ready,
				unacknowledged: queue.messages_unacknowledged,
				consumers: queue.consumers,
				state: queue.state || null
			}))
		};
	}

	async getFailures(page = 1, limit = 20, filters: FailureFilters = {}) {
		const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
		const normalizedLimit =
			Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
		const where = this.getFailureWhere(filters);
		const [items, total] = await this.prisma.$transaction([
			this.prisma.integrationDeliveryFailure.findMany({
				where,
				orderBy: { failedAt: 'desc' },
				skip: (normalizedPage - 1) * normalizedLimit,
				take: normalizedLimit
			}),
			this.prisma.integrationDeliveryFailure.count({ where })
		]);

		return {
			items: items.map(item => this.serializeFailure(item)),
			total,
			page: normalizedPage,
			limit: normalizedLimit,
			totalPages: Math.max(1, Math.ceil(total / normalizedLimit))
		};
	}

	async retryFailure(id: string) {
		const staleRetryBefore = new Date(Date.now() - 5 * 60 * 1000);
		const retryingAt = new Date();
		const result = await this.prisma.$transaction(async transaction => {
			const failure =
				await transaction.integrationDeliveryFailure.findUnique({
					where: { id }
				});
			if (!failure) {
				throw new NotFoundException('Ошибка доставки не найдена');
			}
			if (failure.resolvedAt) {
				throw new ConflictException('Ошибка уже обработана');
			}

			const kind = this.normalizeIntegration(failure.integration);
			const mailingDelivery =
				kind === 'mailing-email' || kind === 'mailing-telegram'
					? this.getMailingDeliveryReference(failure.payload)
					: null;
			const claimed =
				await transaction.integrationDeliveryFailure.updateMany({
					where: {
						id,
						resolvedAt: null,
						OR: [
							{ retryingAt: null },
							{ retryingAt: { lt: staleRetryBefore } }
						]
					},
					data: { retryingAt }
				});

			if (claimed.count !== 1) {
				throw new ConflictException('Повторная отправка уже выполняется');
			}

			if (mailingDelivery) {
				await this.reopenMailingDelivery(
					transaction,
					mailingDelivery.deliveryId,
					mailingDelivery.campaignId
				);
			}

			await transaction.outboxEvent.create({
				data: {
					messageId: failure.eventId,
					eventType: this.getFailureEventType(failure.payload),
					routingKey: getManualRetryRoutingKey(kind),
					payload: failure.payload as Prisma.InputJsonValue
				}
			});

			return { failure, kind };
		});

		return {
			id: result.failure.id,
			eventId: result.failure.eventId,
			integration: result.kind,
			retryingAt: retryingAt.toISOString()
		};
	}

	private getFailureEventType(payload: Prisma.JsonValue): string {
		if (
			payload &&
			typeof payload === 'object' &&
			!Array.isArray(payload) &&
			typeof payload.eventType === 'string'
		) {
			return payload.eventType;
		}
		return OUTBOX_EVENT_TYPE;
	}

	private getMailingDeliveryReference(payload: Prisma.JsonValue) {
		if (
			!payload ||
			typeof payload !== 'object' ||
			Array.isArray(payload)
		) {
			throw new BadRequestException('Некорректное событие рассылки');
		}
		const deliveryId = payload.deliveryId;
		const campaignId = payload.campaignId;
		if (typeof deliveryId !== 'string' || typeof campaignId !== 'string') {
			throw new BadRequestException('Некорректное событие рассылки');
		}
		return { deliveryId, campaignId };
	}

	private async reopenMailingDelivery(
		transaction: Prisma.TransactionClient,
		deliveryId: string,
		campaignId: string
	): Promise<void> {
		const campaign = await transaction.mailingCampaign.findUnique({
			where: { id: campaignId },
			select: {
				status: true,
				cancelRequestedAt: true,
				failedCount: true
			}
		});
		if (
			!campaign ||
			campaign.status === MailingCampaignStatus.CANCELLED ||
			campaign.cancelRequestedAt ||
			campaign.failedCount < 1
		) {
			throw new ConflictException('Рассылка уже обработана или отменена');
		}

		const reopened = await transaction.mailingDelivery.updateMany({
			where: {
				id: deliveryId,
				campaignId,
				status: 'FAILED'
			},
			data: {
				status: 'PENDING',
				lastError: null
			}
		});
		if (reopened.count !== 1) {
			throw new ConflictException(
				'Доставка рассылки уже обработана или отменена'
			);
		}
		await transaction.mailingCampaign.update({
			where: { id: campaignId },
			data: {
				failedCount: { decrement: 1 },
				status: MailingCampaignStatus.RUNNING,
				completedAt: null
			}
		});
	}

	private getFailureWhere(
		filters: FailureFilters
	): Prisma.IntegrationDeliveryFailureWhereInput {
		const integration = filters.integration?.trim();
		const status = filters.status?.trim().toUpperCase();
		const where: Prisma.IntegrationDeliveryFailureWhereInput = {};

		if (integration) {
			where.integration = this.normalizeIntegration(integration);
		}
		if (status === 'FAILED') {
			where.resolvedAt = null;
			where.retryingAt = null;
		} else if (status === 'RETRYING') {
			where.resolvedAt = null;
			where.retryingAt = { not: null };
		} else if (status === 'RESOLVED') {
			where.resolvedAt = { not: null };
		} else if (status && status !== 'ALL') {
			throw new BadRequestException('Некорректный статус ошибки доставки');
		}
		return where;
	}

	private normalizeIntegration(value: string): IntegrationKind {
		if (!INTEGRATION_KINDS.includes(value as IntegrationKind)) {
			throw new BadRequestException('Некорректный тип интеграции');
		}
		return value as IntegrationKind;
	}

	private serializeFailure(item: IntegrationDeliveryFailure) {
		const payload = item.payload as unknown as LeadIntegrationEventPayload;
		return {
			id: item.id,
			eventId: item.eventId,
			integration: item.integration,
			attempts: item.attempts,
			lastError: item.lastError,
			failedAt: item.failedAt.toISOString(),
			retryingAt: item.retryingAt?.toISOString() || null,
			resolvedAt: item.resolvedAt?.toISOString() || null,
			source: payload.source,
			entity: payload.entity,
			lead: {
				id: payload.lead?.id || null,
				contact: payload.lead?.contact || null,
				phone: payload.lead?.phone || null,
				email: payload.lead?.email || null,
				url: payload.lead?.url || null,
				createdAt: payload.lead?.createdAt || null
			}
		};
	}
}
