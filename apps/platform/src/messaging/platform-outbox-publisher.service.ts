import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { OutboxStatus } from '@prisma/platform-client';
import { randomUUID } from 'node:crypto';
import { PlatformPrismaService } from '../prisma/platform-prisma.service';
import { PlatformOwnershipService } from '../ownership/platform-ownership.service';
import { PlatformRuntimeService } from '../runtime/platform-runtime.service';
import { PlatformRabbitMqService } from './platform-rabbitmq.service';

const LEASE_MS = 30_000;

@Injectable()
export class PlatformOutboxPublisherService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(
		PlatformOutboxPublisherService.name
	);
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private ready = false;

	constructor(
		private readonly prisma: PlatformPrismaService,
		private readonly runtime: PlatformRuntimeService,
		private readonly rabbit: PlatformRabbitMqService,
		private readonly ownership: PlatformOwnershipService
	) {}

	onModuleInit(): void {
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
		if (!(await this.ownership.isActive())) return false;
		const event = await this.claim();
		if (!event) return false;
		try {
			await this.rabbit.publish(
				event.exchange,
				event.routingKey,
				event.payload,
				{
					messageId: event.messageId || event.eventId,
					type: event.eventType,
					headers: {
						'x-retry-attempt': event.deliveryAttempt,
						'x-aggregate-type': event.aggregateType,
						'x-aggregate-id': event.aggregateId,
						...(event.correlationId
							? { 'x-correlation-id': event.correlationId }
							: {}),
						...(event.aggregateVersion
							? {
									'x-aggregate-version': event.aggregateVersion.toString()
								}
							: {}),
						...(event.sourceSequence
							? {
									'x-source-sequence': event.sourceSequence.toString()
								}
							: {})
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
					leaseUntil: null,
					lastError: null
				}
			});
			if (published.count !== 1) {
				throw new Error('PLATFORM_OUTBOX_PUBLISH_LEASE_LOST');
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
					leaseUntil: null,
					lastError: this.safeError(error)
				}
			});
			if (released.count !== 1) {
				throw new Error('PLATFORM_OUTBOX_RESCHEDULE_LEASE_LOST');
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
		} catch (error) {
			this.logger.error(
				`Outbox publisher tick failed: ${this.safeError(error)}`
			);
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
						leaseUntil: { lt: now }
					}
				]
			},
			orderBy: { createdAt: 'asc' }
		});
		if (!candidate) return null;
		const token = randomUUID();
		const changed = await this.prisma.outboxEvent.updateMany({
			where: {
				id: candidate.id,
				availableAt: { lte: now },
				OR: [
					{ status: OutboxStatus.PENDING },
					{
						status: OutboxStatus.PROCESSING,
						leaseUntil: { lt: now }
					}
				]
			},
			data: {
				status: OutboxStatus.PROCESSING,
				leaseToken: token,
				leaseUntil: new Date(now.getTime() + LEASE_MS),
				attempt: { increment: 1 }
			}
		});
		if (changed.count !== 1) return null;
		return this.prisma.outboxEvent.findUniqueOrThrow({
			where: { id: candidate.id }
		});
	}

	private safeError(error: unknown): string {
		return error instanceof Error
			? error.message.slice(0, 2_000)
			: 'Unknown publisher failure';
	}
}
