import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/operations-client';
import type { ConsumeMessage } from 'amqplib';
import { AuditReceiptService } from './audit-receipt.service';
import { parseAdminAuditEvent } from './admin-audit-event.contract';
import {
	OperationsConsumeDecision,
	OperationsRabbitMqService
} from './operations-rabbitmq.service';
import {
	OPERATIONS_AUDIT_EVENT_TYPE,
	OperationsAuditSource
} from './operations-messaging.constants';
import { OperationsRuntimeService } from '../runtime/operations-runtime.service';
import { OperationsOwnershipService } from '../ownership/operations-ownership.service';

@Injectable()
export class AdminAuditConsumerService implements OnModuleInit {
	private readonly logger = new Logger(AdminAuditConsumerService.name);
	private ready = false;

	constructor(
		private readonly runtime: OperationsRuntimeService,
		private readonly rabbit: OperationsRabbitMqService,
		private readonly receipts: AuditReceiptService,
		private readonly ownership: OperationsOwnershipService
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.runtime.workerEnabled) return;
		if (!(await this.ownership.isActive())) {
			await this.rabbit.prepareAuditTopology();
			this.ready = true;
			return;
		}
		await this.rabbit.consumeAuditEvents((source, message) =>
			this.handle(source, message)
		);
		this.ready = true;
	}

	isReady(): boolean {
		return !this.runtime.workerEnabled || this.ready;
	}

	async handle(
		source: OperationsAuditSource,
		message: ConsumeMessage
	): Promise<OperationsConsumeDecision> {
		let raw: unknown;
		let normalized: ReturnType<typeof parseAdminAuditEvent>;
		try {
			if (message.content.length > 10 * 1024 * 1024) {
				throw new Error('Admin audit message is too large');
			}
			raw = JSON.parse(message.content.toString('utf8')) as unknown;
			normalized = parseAdminAuditEvent(source, raw);
			if (
				message.properties.type !== OPERATIONS_AUDIT_EVENT_TYPE ||
				message.properties.messageId !== normalized.eventId
			) {
				throw new Error('Admin audit AMQP properties are invalid');
			}
		} catch {
			this.logger.warn(
				`Malformed admin audit rejected source=${source.source}`
			);
			return 'reject';
		}

		const claim = await this.receipts.claim(normalized.eventId);
		if (claim.state === 'delivered' || claim.state === 'dead-lettered') {
			return 'ack';
		}
		if (claim.state === 'busy') return 'requeue';

		try {
			await this.receipts.deliver(
				normalized.eventId,
				claim.leaseToken,
				normalized.record
			);
			this.logger.log(
				`Admin audit delivered eventId=${normalized.eventId} source=${source.source}`
			);
			return 'ack';
		} catch {
			const attempt = this.getRetryAttempt(message) + 1;
			try {
				if (attempt <= this.runtime.auditMaxRetryAttempts) {
					await this.rabbit.publishAuditRetry(
						source,
						raw,
						normalized.eventId,
						attempt,
						this.runtime.auditRetryDelayMs
					);
					await this.receipts.scheduleRetry(
						normalized.eventId,
						claim.leaseToken,
						new Date(Date.now() + this.runtime.auditRetryDelayMs)
					);
					this.logger.warn(
						`Admin audit retry scheduled eventId=${normalized.eventId} source=${source.source} attempt=${attempt}`
					);
				} else {
					await this.rabbit.publishAuditDeadLetter(
						source,
						raw,
						normalized.eventId,
						attempt
					);
					await this.receipts.markDeadLettered(
						normalized.eventId,
						claim.leaseToken,
						source,
						raw as Prisma.InputJsonObject
					);
					this.logger.error(
						`Admin audit moved to DLQ eventId=${normalized.eventId} source=${source.source}`
					);
				}
				return 'ack';
			} catch {
				await this.receipts
					.releaseForRedelivery(normalized.eventId, claim.leaseToken)
					.catch(() => undefined);
				return 'requeue';
			}
		}
	}

	private getRetryAttempt(message: ConsumeMessage): number {
		const raw = message.properties.headers?.['x-retry-attempt'];
		const value = Buffer.isBuffer(raw)
			? Number(raw.toString('utf8'))
			: typeof raw === 'number' || typeof raw === 'string'
				? Number(raw)
				: 0;
		return Number.isSafeInteger(value) && value >= 0 && value <= 100
			? value
			: 0;
	}
}
