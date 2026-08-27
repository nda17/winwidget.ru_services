import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { OutboxStatus, Prisma } from '@prisma/operations-client';
import { randomUUID } from 'node:crypto';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { OperationsRuntimeService } from '../runtime/operations-runtime.service';
import { OperationsRabbitMqService } from './operations-rabbitmq.service';

const LEASE_MS = 30_000;

@Injectable()
export class OperationsOutboxPublisherService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(
		OperationsOutboxPublisherService.name
	);
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private ready = false;

	constructor(
		private readonly prisma: OperationsPrismaService,
		private readonly runtime: OperationsRuntimeService,
		private readonly rabbit: OperationsRabbitMqService
	) {}

	async onModuleInit(): Promise<void> {
		if (!this.runtime.outboxPublisherEnabled) return;
		this.ready = true;
		this.timer = setInterval(
			() => void this.tick(),
			this.runtime.outboxPollIntervalMs
		);
		this.timer.unref();
		void this.tick();
	}

	isReady(): boolean {
		return !this.runtime.outboxPublisherEnabled || this.ready;
	}

	async publishOne(): Promise<boolean> {
		const event = await this.claim();
		if (!event) return false;
		try {
			const headers = this.toHeaders(event.headers);
			await this.rabbit.publish(
				event.exchange,
				event.routingKey,
				event.payload,
				{
					messageId: event.messageId || event.eventId,
					type: event.eventType,
					headers: {
						...headers,
						...(event.correlationId
							? { 'x-correlation-id': event.correlationId }
							: {}),
						'x-aggregate-type': event.aggregateType,
						'x-aggregate-id': event.aggregateId
					}
				}
			);
			const published = await this.prisma.outboxEvent.updateMany({
				where: {
					id: event.id,
					status: OutboxStatus.PROCESSING,
					leaseToken: event.leaseToken
				},
				data: {
					status: OutboxStatus.PUBLISHED,
					publishedAt: new Date(),
					leaseToken: null,
					leaseExpiresAt: null,
					lastError: null
				}
			});
			if (published.count !== 1) {
				throw new Error('OPERATIONS_OUTBOX_PUBLISH_LEASE_LOST');
			}
		} catch (error) {
			const delay = Math.min(
				1_000 * 2 ** Math.min(event.attempt, 10),
				15 * 60_000
			);
			const released = await this.prisma.outboxEvent.updateMany({
				where: {
					id: event.id,
					status: OutboxStatus.PROCESSING,
					leaseToken: event.leaseToken
				},
				data: {
					status: OutboxStatus.PENDING,
					availableAt: new Date(Date.now() + delay),
					leaseToken: null,
					leaseExpiresAt: null,
					lastError: this.safeError(error)
				}
			});
			if (released.count !== 1) {
				throw new Error('OPERATIONS_OUTBOX_RESCHEDULE_LEASE_LOST');
			}
		}
		return true;
	}

	onApplicationShutdown(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.ready = false;
	}

	private async tick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			for (
				let count = 0;
				count < this.runtime.outboxBatchSize;
				count += 1
			) {
				if (!(await this.publishOne())) break;
			}
		} catch {
			this.logger.error('Operations Outbox publisher tick failed');
		} finally {
			this.running = false;
		}
	}

	private async claim() {
		const now = new Date();
		const candidate = await this.prisma.outboxEvent.findFirst({
			where: {
				availableAt: { lte: now },
				OR: [
					{ status: OutboxStatus.PENDING },
					{
						status: OutboxStatus.PROCESSING,
						leaseExpiresAt: { lt: now }
					}
				]
			},
			orderBy: { createdAt: 'asc' }
		});
		if (!candidate) return null;
		const leaseToken = randomUUID();
		const changed = await this.prisma.outboxEvent.updateMany({
			where: {
				id: candidate.id,
				availableAt: { lte: now },
				OR: [
					{ status: OutboxStatus.PENDING },
					{
						status: OutboxStatus.PROCESSING,
						leaseExpiresAt: { lt: now }
					}
				]
			},
			data: {
				status: OutboxStatus.PROCESSING,
				leaseToken,
				leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
				attempt: { increment: 1 }
			}
		});
		if (changed.count !== 1) return null;
		return this.prisma.outboxEvent.findUniqueOrThrow({
			where: { id: candidate.id }
		});
	}

	private toHeaders(value: Prisma.JsonValue): Record<string, unknown> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Outbox headers must be an object');
		}
		return value as Record<string, unknown>;
	}

	private safeError(error: unknown): string {
		return error instanceof Error
			? error.name.slice(0, 160)
			: 'UnknownPublisherFailure';
	}
}
