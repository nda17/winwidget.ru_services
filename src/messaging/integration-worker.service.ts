import {
	INTEGRATION_KINDS,
	INTEGRATION_ROUTING_KEYS,
	IntegrationKind,
	RETRY_DELAYS_MS
} from '@/messaging/messaging.constants';
import { LeadIntegrationEventPayload } from '@/messaging/lead-integration-event';
import { IntegrationDeliveryService } from '@/messaging/integration-delivery.service';
import { RabbitMqService } from '@/messaging/rabbitmq.service';
import { PrismaService } from '@/prisma.service';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { ConsumeMessage } from 'amqplib';
import { randomUUID } from 'crypto';

@Injectable()
export class IntegrationWorkerService implements OnModuleInit {
	private readonly logger = new Logger(IntegrationWorkerService.name);
	private lastReceiptCleanupAt = 0;

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

		let payload: LeadIntegrationEventPayload;
		try {
			payload = this.parsePayload(message);
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
					where: { eventId },
					select: { id: true }
				});
			if (receipt) {
				await this.resolveFailure(eventId);
				this.rabbitMq.ack(message);
				this.logger.warn(
					`Duplicate integration skipped eventId=${eventId} kind=${kind}`
				);
				return;
			}

			await this.delivery.deliver(kind, payload, eventId);
			await this.prisma.integrationDeliveryReceipt.create({
				data: {
					eventId,
					integration: kind
				}
			});
			await this.resolveFailure(eventId);
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
						eventId
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
						errorMessage
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

	private async resolveFailure(eventId: string): Promise<void> {
		await this.prisma.integrationDeliveryFailure.updateMany({
			where: { eventId, resolvedAt: null },
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
		message: ConsumeMessage
	): LeadIntegrationEventPayload {
		const value = JSON.parse(
			message.content.toString('utf8')
		) as LeadIntegrationEventPayload;

		if (
			value?.schemaVersion !== 1 ||
			!value.integration ||
			!value.source ||
			!value.entity?.id ||
			!value.entity?.name ||
			!value.lead?.id ||
			!value.lead?.createdAt ||
			!value.destination
		) {
			throw new Error('Invalid lead integration event payload');
		}
		return value;
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
				error
			);
			this.rabbitMq.ack(message);
		} catch {
			this.rabbitMq.nack(message, true);
		}
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
				where: { eventId },
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
