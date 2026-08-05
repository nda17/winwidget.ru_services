import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
	Prisma,
	WidgetsOutboxEvent,
	WidgetsOutboxExchange,
	WidgetsOutboxStatus
} from '@prisma/widgets-client';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import { WidgetsRuntimeService } from '../runtime/widgets-runtime.service';
import {
	WIDGETS_DEAD_LETTER_EXCHANGE,
	WIDGETS_EVENTS_EXCHANGE,
	WIDGETS_MANUAL_RETRY_EXCHANGE,
	WIDGETS_RETRY_EXCHANGE
} from './widgets-messaging.constants';
import { assertWidgetsOutboxContract } from './widgets-outbox-contract';
import { WidgetsRabbitMqService } from './widgets-rabbitmq.service';

const LEASE_MS = 60_000;
type Claimed = WidgetsOutboxEvent & { lockToken: string };

@Injectable()
export class WidgetsOutboxPublisherService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(WidgetsOutboxPublisherService.name);
	private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;
	private stopping = false;
	private firstPoll = false;

	constructor(
		private readonly prisma: WidgetsPrismaService,
		private readonly rabbit: WidgetsRabbitMqService,
		private readonly runtime: WidgetsRuntimeService,
		private readonly config: ConfigService
	) {}

	onModuleInit(): void {
		if (!this.runtime.publisherEnabled) return;
		void this.schedule();
		this.timer = setInterval(() => void this.schedule(), this.interval());
		this.timer.unref();
	}

	isReady(): boolean {
		return !this.runtime.publisherEnabled || this.firstPoll;
	}

	async beforeApplicationShutdown(): Promise<void> {
		this.stopping = true;
		if (this.timer) clearInterval(this.timer);
		if (this.running)
			await Promise.race([
				this.running.catch(() => undefined),
				new Promise<void>(resolve => setTimeout(resolve, 20_000).unref())
			]);
	}

	private async schedule(): Promise<void> {
		if (this.stopping || this.running) return;
		this.running = this.poll();
		try {
			await this.running;
			this.firstPoll = true;
		} catch (error) {
			this.logger.error(
				`Widgets Outbox poll failed: ${this.error(error)}`
			);
		} finally {
			this.running = null;
		}
	}

	private async poll(): Promise<void> {
		const now = new Date();
		const rows = await this.prisma.widgetsOutboxEvent.findMany({
			where: {
				OR: [
					{
						status: WidgetsOutboxStatus.PENDING,
						availableAt: { lte: now }
					},
					{
						status: WidgetsOutboxStatus.PUBLISHING,
						leaseExpiresAt: { lte: now }
					}
				]
			},
			orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }],
			take: this.batch(),
			select: { id: true }
		});
		for (const row of rows) {
			if (this.stopping) break;
			const event = await this.claim(row.id);
			if (event) await this.publish(event);
		}
	}

	private async claim(id: string): Promise<Claimed | null> {
		const now = new Date();
		const lockToken = randomUUID();
		const result = await this.prisma.widgetsOutboxEvent.updateMany({
			where: {
				id,
				OR: [
					{
						status: WidgetsOutboxStatus.PENDING,
						availableAt: { lte: now }
					},
					{
						status: WidgetsOutboxStatus.PUBLISHING,
						leaseExpiresAt: { lte: now }
					}
				]
			},
			data: {
				status: WidgetsOutboxStatus.PUBLISHING,
				lockedAt: now,
				lockedBy: this.workerId,
				lockToken,
				leaseExpiresAt: new Date(now.getTime() + LEASE_MS)
			}
		});
		if (result.count !== 1) return null;
		const event = await this.prisma.widgetsOutboxEvent.findUnique({
			where: { id }
		});
		return event?.lockToken === lockToken ? { ...event, lockToken } : null;
	}

	private async publish(event: Claimed): Promise<void> {
		try {
			this.assertContract(event);
		} catch (error) {
			await this.quarantine(event, this.error(error));
			return;
		}
		try {
			const headers = this.headers(event.headers);
			await this.rabbit.publish(
				this.exchange(event.exchange),
				event.routingKey,
				event.payload,
				{
					messageId: event.messageId,
					type: event.eventType,
					correlationId:
						typeof headers['x-correlation-id'] === 'string'
							? headers['x-correlation-id']
							: event.messageId,
					headers: {
						...headers,
						'x-outbox-event-id': event.id,
						'x-publish-attempt': event.attempts + 1
					}
				}
			);
			await this.prisma.widgetsOutboxEvent.updateMany({
				where: {
					id: event.id,
					status: WidgetsOutboxStatus.PUBLISHING,
					lockedBy: this.workerId,
					lockToken: event.lockToken
				},
				data: {
					status: WidgetsOutboxStatus.PUBLISHED,
					attempts: { increment: 1 },
					publishedAt: new Date(),
					lockedAt: null,
					lockedBy: null,
					lockToken: null,
					leaseExpiresAt: null,
					lastError: null
				}
			});
		} catch (error) {
			const attempts = event.attempts + 1;
			await this.prisma.widgetsOutboxEvent.updateMany({
				where: {
					id: event.id,
					status: WidgetsOutboxStatus.PUBLISHING,
					lockedBy: this.workerId,
					lockToken: event.lockToken
				},
				data: {
					status: WidgetsOutboxStatus.PENDING,
					attempts,
					availableAt: new Date(
						Date.now() +
							Math.min(300_000, 1000 * 2 ** Math.min(attempts - 1, 8))
					),
					lockedAt: null,
					lockedBy: null,
					lockToken: null,
					leaseExpiresAt: null,
					lastError: this.error(error).slice(0, 4000)
				}
			});
		}
	}

	private assertContract(event: WidgetsOutboxEvent): void {
		assertWidgetsOutboxContract(event);
	}

	private quarantine(
		event: Claimed,
		reason: string
	): Promise<Prisma.BatchPayload> {
		return this.prisma.widgetsOutboxEvent.updateMany({
			where: {
				id: event.id,
				status: WidgetsOutboxStatus.PUBLISHING,
				lockedBy: this.workerId,
				lockToken: event.lockToken
			},
			data: {
				status: WidgetsOutboxStatus.QUARANTINED,
				attempts: { increment: 1 },
				lockedAt: null,
				lockedBy: null,
				lockToken: null,
				leaseExpiresAt: null,
				lastError: `INVALID_OUTBOX_CONTRACT: ${reason}`.slice(0, 4000)
			}
		});
	}

	private exchange(value: WidgetsOutboxExchange) {
		if (value === WidgetsOutboxExchange.EVENTS)
			return WIDGETS_EVENTS_EXCHANGE;
		if (value === WidgetsOutboxExchange.RETRY)
			return WIDGETS_RETRY_EXCHANGE;
		if (value === WidgetsOutboxExchange.MANUAL_RETRY)
			return WIDGETS_MANUAL_RETRY_EXCHANGE;
		return WIDGETS_DEAD_LETTER_EXCHANGE;
	}

	private headers(
		value: Prisma.JsonValue
	): Record<string, string | number | boolean> {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			return {};
		return Object.fromEntries(
			Object.entries(value).filter(
				(entry): entry is [string, string | number | boolean] =>
					['string', 'number', 'boolean'].includes(typeof entry[1])
			)
		);
	}

	private batch(): number {
		const value = Number(
			this.config.get<string>('WIDGETS_OUTBOX_BATCH_SIZE') || 50
		);
		if (!Number.isInteger(value) || value < 1 || value > 500)
			throw new Error(
				'WIDGETS_OUTBOX_BATCH_SIZE must be between 1 and 500'
			);
		return value;
	}

	private interval(): number {
		const value = Number(
			this.config.get<string>('WIDGETS_OUTBOX_POLL_INTERVAL_MS') || 1000
		);
		if (!Number.isInteger(value) || value < 100 || value > 60_000)
			throw new Error(
				'WIDGETS_OUTBOX_POLL_INTERVAL_MS must be between 100 and 60000'
			);
		return value;
	}

	private error(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
