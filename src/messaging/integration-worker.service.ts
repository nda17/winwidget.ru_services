import {
	INTEGRATION_KINDS,
	INTEGRATION_ROUTING_KEYS,
	IntegrationKind,
	RETRY_DELAYS_MS
} from '@/messaging/messaging.constants';
import { LeadIntegrationEventPayload } from '@/messaging/lead-integration-event';
import { LimitReachedEventPayload } from '@/messaging/limit-reached-event';
import { MailingDeliveryEventPayload } from '@/messaging/mailing-delivery-event';
import { PaymentSucceededEventPayload } from '@/messaging/payment-succeeded-event';
import { IntegrationDeliveryService } from '@/messaging/integration-delivery.service';
import { RabbitMqService } from '@/messaging/rabbitmq.service';
import { PrismaService } from '@/prisma.service';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	MailingCampaignStatus,
	MailingDeliveryStatus,
	Prisma
} from '@prisma/client';
import type { ConsumeMessage } from 'amqplib';
import { randomUUID } from 'crypto';

@Injectable()
export class IntegrationWorkerService implements OnModuleInit {
	private readonly logger = new Logger(IntegrationWorkerService.name);
	private lastReceiptCleanupAt = 0;
	private readonly rateLimitTails = new Map<string, Promise<void>>();

	constructor(
		private readonly rabbitMq: RabbitMqService,
		private readonly delivery: IntegrationDeliveryService,
		private readonly configService: ConfigService,
		private readonly prisma: PrismaService
	) {}

	async onModuleInit(): Promise<void> {
		const prefetch = this.getPrefetch();
		const kinds = this.getEnabledKinds();
		for (const kind of kinds) {
			await this.rabbitMq.consume(
				kind,
				message => this.handle(kind, message),
				prefetch
			);
			await this.rabbitMq.consumeDeadLetter(
				kind,
				message => this.collectDeadLetter(kind, message),
				prefetch
			);
		}
		this.logger.log(
			`Integration consumers started kinds=${kinds.join(',')} prefetch=${prefetch}`
		);
	}

	private async handle(
		kind: IntegrationKind,
		message: ConsumeMessage
	): Promise<void> {
		const eventId = message.properties.messageId;
		if (!eventId) {
			await this.deadLetterMalformed(
				kind,
				message,
				'RabbitMQ messageId is missing'
			);
			return;
		}

		let payload:
			| LeadIntegrationEventPayload
			| PaymentSucceededEventPayload
			| MailingDeliveryEventPayload
			| LimitReachedEventPayload;
		try {
			payload = this.parsePayload(kind, message);
		} catch (error) {
			await this.deadLetterMalformed(
				kind,
				message,
				error instanceof Error ? error.message : String(error)
			);
			return;
		}

		try {
			const receipt =
				await this.prisma.integrationDeliveryReceipt.findUnique({
					where: {
						eventId_integration: {
							eventId,
							integration: kind
						}
					},
					select: { id: true }
				});
			if (receipt) {
				await this.resolveFailure(eventId, kind);
				this.rabbitMq.ack(message);
				this.logger.warn(
					`Duplicate integration skipped eventId=${eventId} kind=${kind}`
				);
				return;
			}

			await this.deliverWithRateLimit(kind, payload, eventId);
			await this.prisma.integrationDeliveryReceipt.create({
				data: {
					eventId,
					integration: kind
				}
			});
			await this.resolveFailure(eventId, kind);
			await this.cleanupReceiptsIfDue();
			this.rabbitMq.ack(message);
			this.logger.log(
				`Integration delivered eventId=${eventId} kind=${kind}`
			);
		} catch (error) {
			const lastAttempt = this.getRetryAttempt(message);
			const nextAttempt = lastAttempt + 1;
			const errorMessage =
				error instanceof Error ? error.message : String(error);

			try {
				if (nextAttempt <= RETRY_DELAYS_MS.length) {
					await this.rabbitMq.publishRetry(
						kind,
						payload,
						nextAttempt,
						eventId,
						this.getEventType(payload)
					);
					this.logger.warn(
						`Integration retry scheduled eventId=${eventId} kind=${kind} attempt=${nextAttempt}: ${errorMessage}`
					);
				} else {
					await this.rabbitMq.publishDeadLetter(
						kind,
						payload,
						nextAttempt,
						eventId,
						errorMessage,
						this.getEventType(payload)
					);
					this.logger.error(
						`Integration moved to dead-letter eventId=${eventId} kind=${kind}: ${errorMessage}`
					);
				}
				this.rabbitMq.ack(message);
			} catch (publishError) {
				this.logger.error(
					`Failed to republish eventId=${eventId} kind=${kind}: ${
						publishError instanceof Error
							? publishError.message
							: String(publishError)
					}`
				);
				this.rabbitMq.nack(message, true);
			}
		}
	}

	private async resolveFailure(
		eventId: string,
		integration: IntegrationKind
	): Promise<void> {
		await this.prisma.integrationDeliveryFailure.updateMany({
			where: { eventId, integration, resolvedAt: null },
			data: {
				resolvedAt: new Date(),
				retryingAt: null
			}
		});
	}

	private async cleanupReceiptsIfDue(): Promise<void> {
		const now = Date.now();
		if (now - this.lastReceiptCleanupAt < 24 * 60 * 60 * 1000) return;
		this.lastReceiptCleanupAt = now;
		const configured = Number(
			this.configService.get<string>(
				'INTEGRATION_RECEIPT_RETENTION_DAYS'
			) || 90
		);
		const retentionDays =
			Number.isInteger(configured) && configured >= 30 ? configured : 90;
		await this.prisma.integrationDeliveryReceipt.deleteMany({
			where: {
				deliveredAt: {
					lt: new Date(now - retentionDays * 24 * 60 * 60 * 1000)
				}
			}
		});
	}

	private parsePayload(
		kind: IntegrationKind,
		message: ConsumeMessage
	):
		| LeadIntegrationEventPayload
		| PaymentSucceededEventPayload
		| MailingDeliveryEventPayload
		| LimitReachedEventPayload {
		const value = JSON.parse(message.content.toString('utf8')) as
			| LeadIntegrationEventPayload
			| PaymentSucceededEventPayload
			| MailingDeliveryEventPayload
			| LimitReachedEventPayload;

		if (kind === 'payment-email' || kind === 'payment-telegram') {
			const payment = value as PaymentSucceededEventPayload;
			if (
				payment?.schemaVersion !== 1 ||
				payment?.eventType !== 'payment.succeeded.v1' ||
				!payment.payment?.id ||
				!payment.payment?.yookassaId ||
				!payment.user?.id
			) {
				throw new Error('Invalid payment succeeded event payload');
			}
			return payment;
		}
		if (kind === 'mailing-email' || kind === 'mailing-telegram') {
			const mailing = value as MailingDeliveryEventPayload;
			const expectedChannel =
				kind === 'mailing-email' ? 'EMAIL' : 'TELEGRAM';
			if (
				mailing?.schemaVersion !== 1 ||
				mailing?.eventType !== 'mailing.delivery.requested.v1' ||
				!mailing.campaignId ||
				!mailing.deliveryId ||
				mailing.channel !== expectedChannel
			) {
				throw new Error('Invalid mailing delivery event payload');
			}
			return mailing;
		}
		if (kind === 'limit-email' || kind === 'limit-telegram') {
			const limit = value as LimitReachedEventPayload;
			if (
				limit?.schemaVersion !== 1 ||
				limit?.eventType !== 'lead.limit.reached.v1' ||
				!limit.entity?.id ||
				!limit.entity?.name ||
				!Number.isInteger(limit.limit) ||
				!limit.destinations
			) {
				throw new Error('Invalid limit reached event payload');
			}
			return limit;
		}

		const lead = value as LeadIntegrationEventPayload;

		if (
			lead?.schemaVersion !== 1 ||
			!lead.integration ||
			!lead.source ||
			!lead.entity?.id ||
			!lead.entity?.name ||
			!lead.lead?.id ||
			!lead.lead?.createdAt ||
			!lead.destination
		) {
			throw new Error('Invalid lead integration event payload');
		}
		return lead;
	}

	private async deadLetterMalformed(
		kind: IntegrationKind,
		message: ConsumeMessage,
		error: string
	): Promise<void> {
		const eventId = message.properties.messageId || randomUUID();
		let payload: unknown = {
			raw: message.content.toString('utf8').slice(0, 10_000)
		};
		try {
			payload = JSON.parse(message.content.toString('utf8'));
		} catch {}

		try {
			await this.rabbitMq.publishDeadLetter(
				kind,
				payload,
				this.getRetryAttempt(message),
				eventId,
				error,
				message.properties.type || 'unknown'
			);
			this.rabbitMq.ack(message);
		} catch {
			this.rabbitMq.nack(message, true);
		}
	}

	private getEventType(
		payload:
			| LeadIntegrationEventPayload
			| PaymentSucceededEventPayload
			| MailingDeliveryEventPayload
			| LimitReachedEventPayload
	): string {
		return 'eventType' in payload
			? payload.eventType
			: 'lead.integration.requested.v1';
	}

	private async collectDeadLetter(
		kind: IntegrationKind,
		message: ConsumeMessage
	): Promise<void> {
		const eventId = message.properties.messageId || randomUUID();
		const rawPayload = message.content.toString('utf8');
		let payload: Prisma.InputJsonValue = {
			raw: rawPayload.slice(0, 10_000)
		};
		try {
			payload = JSON.parse(rawPayload) as Prisma.InputJsonValue;
		} catch {}

		const errorHeader = message.properties.headers?.['x-last-error'];
		const lastError =
			typeof errorHeader === 'string'
				? errorHeader
				: Buffer.isBuffer(errorHeader)
					? errorHeader.toString('utf8')
					: 'Integration delivery failed';
		const failedAt = new Date();

		try {
			await this.prisma.integrationDeliveryFailure.upsert({
				where: {
					eventId_integration: {
						eventId,
						integration: kind
					}
				},
				create: {
					eventId,
					integration: kind,
					routingKey: INTEGRATION_ROUTING_KEYS[kind],
					payload,
					attempts: this.getRetryAttempt(message),
					lastError: lastError.slice(0, 10_000),
					failedAt
				},
				update: {
					integration: kind,
					routingKey: INTEGRATION_ROUTING_KEYS[kind],
					payload,
					attempts: this.getRetryAttempt(message),
					lastError: lastError.slice(0, 10_000),
					failedAt,
					retryingAt: null,
					resolvedAt: null
				}
			});
			await this.markMailingDeliveryFailed(kind, payload, lastError);
			this.rabbitMq.ack(message);
			this.logger.error(
				`Dead-letter persisted eventId=${eventId} kind=${kind}`
			);
		} catch (error) {
			this.logger.error(
				`Failed to persist dead-letter eventId=${eventId} kind=${kind}: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
			this.rabbitMq.nack(message, true);
		}
	}

	private async deliverWithRateLimit(
		kind: IntegrationKind,
		payload:
			| LeadIntegrationEventPayload
			| PaymentSucceededEventPayload
			| MailingDeliveryEventPayload
			| LimitReachedEventPayload,
		eventId: string
	): Promise<void> {
		const intervalMs = this.getRateLimitInterval(kind);
		if (!intervalMs) {
			await this.delivery.deliver(kind, payload, eventId);
			return;
		}

		const previous = this.rateLimitTails.get(kind) || Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		this.rateLimitTails.set(
			kind,
			previous.catch(() => undefined).then(() => gate)
		);
		await previous.catch(() => undefined);
		try {
			await this.delivery.deliver(kind, payload, eventId);
		} finally {
			setTimeout(release, intervalMs);
		}
	}

	private getRateLimitInterval(kind: IntegrationKind): number {
		const key =
			kind === 'mailing-email'
				? 'MAILING_EMAIL_RATE_PER_SECOND'
				: kind === 'mailing-telegram'
					? 'MAILING_TELEGRAM_RATE_PER_SECOND'
					: null;
		if (!key) return 0;
		const fallback = kind === 'mailing-email' ? 5 : 10;
		const configured = Number(
			this.configService.get<string>(key) || fallback
		);
		const rate =
			Number.isFinite(configured) && configured > 0
				? Math.min(configured, 50)
				: fallback;
		return Math.ceil(1000 / rate);
	}

	private async markMailingDeliveryFailed(
		kind: IntegrationKind,
		payload: Prisma.InputJsonValue,
		lastError: string
	): Promise<void> {
		if (kind !== 'mailing-email' && kind !== 'mailing-telegram') return;
		const deliveryId = (payload as { deliveryId?: string }).deliveryId;
		const campaignId = (payload as { campaignId?: string }).campaignId;
		if (!deliveryId || !campaignId) return;

		await this.prisma.$transaction(async transaction => {
			const failed = await transaction.mailingDelivery.updateMany({
				where: {
					id: deliveryId,
					campaignId,
					status: {
						in: [
							MailingDeliveryStatus.PENDING,
							MailingDeliveryStatus.PROCESSING
						]
					}
				},
				data: {
					status: MailingDeliveryStatus.FAILED,
					lastError: lastError.slice(0, 10_000)
				}
			});
			if (failed.count !== 1) return;
			await transaction.mailingCampaign.update({
				where: { id: campaignId },
				data: { failedCount: { increment: 1 } }
			});
			const pending = await transaction.mailingDelivery.count({
				where: {
					campaignId,
					status: {
						in: [
							MailingDeliveryStatus.PENDING,
							MailingDeliveryStatus.PROCESSING
						]
					}
				}
			});
			if (pending !== 0) return;
			await transaction.mailingCampaign.updateMany({
				where: {
					id: campaignId,
					status: { not: MailingCampaignStatus.CANCELLED }
				},
				data: {
					status: MailingCampaignStatus.PARTIAL_FAILED,
					completedAt: new Date()
				}
			});
		});
	}

	private getRetryAttempt(message: ConsumeMessage): number {
		const value = Number(message.properties.headers?.['x-retry-attempt']);
		return Number.isInteger(value) && value >= 0 ? value : 0;
	}

	private getPrefetch(): number {
		const value = Number(
			this.configService.get<string>('RABBITMQ_WORKER_PREFETCH') || 10
		);
		return Number.isInteger(value) && value > 0
			? Math.min(value, 100)
			: 10;
	}

	private getEnabledKinds(): IntegrationKind[] {
		const configured = this.configService
			.get<string>('INTEGRATION_WORKER_KINDS')
			?.split(',')
			.map(value => value.trim())
			.filter(Boolean);

		if (!configured?.length) return [...INTEGRATION_KINDS];

		const invalid = configured.filter(
			value => !INTEGRATION_KINDS.includes(value as IntegrationKind)
		);
		if (invalid.length) {
			throw new Error(
				`Invalid INTEGRATION_WORKER_KINDS values: ${invalid.join(', ')}`
			);
		}

		return [...new Set(configured as IntegrationKind[])];
	}
}
