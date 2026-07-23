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
	IntegrationDeliveryReceiptStatus,
	MailingCampaignStatus,
	MailingDeliveryStatus,
	Prisma
} from '@prisma/client';
import type { ConsumeMessage } from 'amqplib';
import { randomUUID } from 'crypto';

const DELIVERY_RECEIPT_LEASE_MS = 10 * 60 * 1000;

class DeliveryClaimInProgressError extends Error {}

type DeliveryClaim =
	| { state: 'claimed'; lockedAt: Date }
	| { state: 'delivered' }
	| { state: 'processing' };

@Injectable()
export class IntegrationWorkerService implements OnModuleInit {
	private readonly logger = new Logger(IntegrationWorkerService.name);
	private readonly receiptCleanupBatchSize = 1000;
	private readonly receiptCleanupMaxBatches = 20;
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

		let receiptClaim: Date | null = null;
		try {
			const claim = await this.claimDelivery(eventId, kind);
			if (claim.state === 'delivered') {
				await this.resolveFailure(eventId, kind);
				this.rabbitMq.ack(message);
				this.logger.warn(
					`Duplicate integration skipped eventId=${eventId} kind=${kind}`
				);
				return;
			}
			if (claim.state === 'processing') {
				throw new DeliveryClaimInProgressError(
					`Integration delivery is already processing eventId=${eventId} kind=${kind}`
				);
			}
			receiptClaim = claim.lockedAt;

			await this.deliverWithRateLimit(kind, payload, eventId);
			await this.markDeliveryDelivered(eventId, kind, receiptClaim);
			receiptClaim = null;
			await this.resolveFailure(eventId, kind);
			await this.cleanupReceiptsIfDue();
			this.rabbitMq.ack(message);
			this.logger.log(
				`Integration delivered eventId=${eventId} kind=${kind}`
			);
		} catch (error) {
			const lastAttempt = this.getRetryAttempt(message);
			const nextAttempt =
				error instanceof DeliveryClaimInProgressError
					? Math.max(lastAttempt, 1)
					: lastAttempt + 1;
			const errorMessage =
				error instanceof Error ? error.message : String(error);

			if (receiptClaim) {
				await this.releaseDeliveryClaim(eventId, kind, receiptClaim).catch(
					releaseError => {
						this.logger.error(
							`Failed to release delivery claim eventId=${eventId} kind=${kind}: ${
								releaseError instanceof Error
									? releaseError.message
									: String(releaseError)
							}`
						);
					}
				);
			}

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

	private async claimDelivery(
		eventId: string,
		integration: IntegrationKind
	): Promise<DeliveryClaim> {
		const lockedAt = new Date();
		try {
			await this.prisma.integrationDeliveryReceipt.create({
				data: {
					eventId,
					integration,
					status: IntegrationDeliveryReceiptStatus.PROCESSING,
					lockedAt,
					deliveredAt: null
				}
			});
			return { state: 'claimed', lockedAt };
		} catch (error) {
			if (!this.isUniqueConstraintError(error)) throw error;
		}

		const receipt =
			await this.prisma.integrationDeliveryReceipt.findUnique({
				where: {
					eventId_integration: {
						eventId,
						integration
					}
				},
				select: {
					status: true,
					lockedAt: true
				}
			});
		if (!receipt) {
			throw new Error(
				`Integration delivery receipt disappeared eventId=${eventId} kind=${integration}`
			);
		}
		if (receipt.status === IntegrationDeliveryReceiptStatus.DELIVERED) {
			return { state: 'delivered' };
		}
		if (
			receipt.lockedAt.getTime() >
			lockedAt.getTime() - DELIVERY_RECEIPT_LEASE_MS
		) {
			return { state: 'processing' };
		}

		const reclaimed =
			await this.prisma.integrationDeliveryReceipt.updateMany({
				where: {
					eventId,
					integration,
					status: IntegrationDeliveryReceiptStatus.PROCESSING,
					lockedAt: receipt.lockedAt
				},
				data: { lockedAt }
			});
		return reclaimed.count === 1
			? { state: 'claimed', lockedAt }
			: { state: 'processing' };
	}

	private async markDeliveryDelivered(
		eventId: string,
		integration: IntegrationKind,
		lockedAt: Date
	): Promise<void> {
		const delivered =
			await this.prisma.integrationDeliveryReceipt.updateMany({
				where: {
					eventId,
					integration,
					status: IntegrationDeliveryReceiptStatus.PROCESSING,
					lockedAt
				},
				data: {
					status: IntegrationDeliveryReceiptStatus.DELIVERED,
					deliveredAt: new Date()
				}
			});
		if (delivered.count !== 1) {
			throw new Error(
				`Integration delivery claim was lost eventId=${eventId} kind=${integration}`
			);
		}
	}

	private async releaseDeliveryClaim(
		eventId: string,
		integration: IntegrationKind,
		lockedAt: Date
	): Promise<void> {
		await this.prisma.integrationDeliveryReceipt.deleteMany({
			where: {
				eventId,
				integration,
				status: IntegrationDeliveryReceiptStatus.PROCESSING,
				lockedAt
			}
		});
	}

	private isUniqueConstraintError(error: unknown): boolean {
		return (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === 'P2002'
		);
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
		const deliveredBefore = new Date(
			now - retentionDays * 24 * 60 * 60 * 1000
		);
		for (let batch = 0; batch < this.receiptCleanupMaxBatches; batch++) {
			const count = await this.prisma.$executeRaw(
				Prisma.sql`
					WITH expired AS (
						SELECT "id"
						FROM "integration_delivery_receipts"
						WHERE "status" = 'DELIVERED'::"IntegrationDeliveryReceiptStatus"
							AND "delivered_at" < ${deliveredBefore}
						ORDER BY "delivered_at" ASC
						LIMIT ${this.receiptCleanupBatchSize}
					)
					DELETE FROM "integration_delivery_receipts" AS receipt
					USING expired
					WHERE receipt."id" = expired."id"
				`
			);
			if (count < this.receiptCleanupBatchSize) break;
		}
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
		if (
			!intervalMs ||
			(await this.shouldBypassMailingRateLimit(kind, payload))
		) {
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

	private async shouldBypassMailingRateLimit(
		kind: IntegrationKind,
		payload:
			| LeadIntegrationEventPayload
			| PaymentSucceededEventPayload
			| MailingDeliveryEventPayload
			| LimitReachedEventPayload
	): Promise<boolean> {
		if (kind !== 'mailing-email' && kind !== 'mailing-telegram') {
			return false;
		}

		const deliveryId = (payload as MailingDeliveryEventPayload).deliveryId;
		if (!deliveryId) return true;
		const delivery = await this.prisma.mailingDelivery.findUnique({
			where: { id: deliveryId },
			select: {
				status: true,
				updatedAt: true,
				campaign: {
					select: {
						status: true,
						cancelRequestedAt: true
					}
				}
			}
		});
		if (!delivery) return true;
		if (
			delivery.campaign.status === MailingCampaignStatus.CANCELLED ||
			delivery.campaign.cancelRequestedAt
		) {
			return true;
		}
		if (delivery.status === MailingDeliveryStatus.PENDING) return false;
		if (delivery.status === MailingDeliveryStatus.PROCESSING) {
			return (
				delivery.updatedAt.getTime() >
				Date.now() - DELIVERY_RECEIPT_LEASE_MS
			);
		}
		return true;
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
