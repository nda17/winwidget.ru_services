import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { OutboxStatus, Prisma } from '@prisma/identity-client';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { safeError } from '../common/identity.util';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { IdentityRuntimeService } from '../runtime/identity-runtime.service';
import { IdentityOwnershipService } from '../runtime/identity-ownership.service';
import { exchangeName } from './messaging.constants';
import { IdentityRabbitMqService } from './rabbitmq.service';

const LEASE_MS = 30_000;

@Injectable()
export class IdentityOutboxPublisherService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(
		IdentityOutboxPublisherService.name
	);
	private readonly instanceId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private ready = false;

	constructor(
		private readonly prisma: IdentityPrismaService,
		private readonly runtime: IdentityRuntimeService,
		private readonly rabbit: IdentityRabbitMqService,
		private readonly ownership: IdentityOwnershipService
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
		const event = await this.claim();
		if (!event) return false;
		try {
			const storedHeaders = this.scalarHeaders(event.headers);
			await this.rabbit.publish(
				exchangeName(event.exchange),
				event.routingKey,
				event.payload,
				{
					messageId: event.messageId,
					type: event.eventType,
					correlationId:
						typeof storedHeaders['x-correlation-id'] === 'string'
							? storedHeaders['x-correlation-id']
							: event.messageId,
					headers: {
						...storedHeaders,
						...(event.aggregateType
							? { 'x-aggregate-type': event.aggregateType }
							: {}),
						...(event.aggregateId
							? { 'x-aggregate-id': event.aggregateId }
							: {}),
						...(event.aggregateVersion !== null
							? {
									'x-aggregate-version': event.aggregateVersion.toString()
								}
							: {}),
						...(event.sourceSequence !== null
							? { 'x-source-sequence': event.sourceSequence.toString() }
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
					lockedAt: null,
					lockedBy: null,
					leaseToken: null,
					leaseExpiresAt: null,
					lastError: null
				}
			});
			if (published.count !== 1)
				throw new Error('Outbox publish lease was lost');
		} catch (error) {
			const delay = Math.min(
				1_000 * 2 ** Math.min(event.attempts, 10),
				15 * 60_000
			);
			await this.prisma.outboxEvent.updateMany({
				where: { id: event.id, leaseToken: event.leaseToken },
				data: {
					status: OutboxStatus.PENDING,
					availableAt: new Date(Date.now() + delay),
					lockedAt: null,
					lockedBy: null,
					leaseToken: null,
					leaseExpiresAt: null,
					lastError: safeError(error)
				}
			});
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
			if (!(await this.ownership.isActive())) return;
			for (
				let count = 0;
				count < this.runtime.outboxBatchSize;
				count += 1
			) {
				if (!(await this.publishOne())) break;
			}
		} catch (error) {
			this.logger.error(`Outbox tick failed: ${safeError(error)}`);
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
						leaseExpiresAt: { lte: now }
					}
				]
			},
			orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }]
		});
		if (!candidate) return null;
		const leaseToken = randomUUID();
		const claimed = await this.prisma.outboxEvent.updateMany({
			where: {
				id: candidate.id,
				availableAt: { lte: now },
				OR: [
					{ status: OutboxStatus.PENDING },
					{
						status: OutboxStatus.PROCESSING,
						leaseExpiresAt: { lte: now }
					}
				]
			},
			data: {
				status: OutboxStatus.PROCESSING,
				attempts: { increment: 1 },
				lockedAt: now,
				lockedBy: this.instanceId,
				leaseToken,
				leaseExpiresAt: new Date(now.getTime() + LEASE_MS)
			}
		});
		if (claimed.count !== 1) return null;
		return this.prisma.outboxEvent.findUniqueOrThrow({
			where: { id: candidate.id }
		});
	}

	private scalarHeaders(
		value: Prisma.JsonValue
	): Record<string, string | number | boolean> {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			return {};
		return Object.fromEntries(
			Object.entries(value).filter(
				(entry): entry is [string, string | number | boolean] =>
					typeof entry[1] === 'string' ||
					typeof entry[1] === 'number' ||
					typeof entry[1] === 'boolean'
			)
		);
	}
}
