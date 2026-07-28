import { NotificationDeliveryPrismaService } from './prisma/notification-delivery-prisma.service';
import type { NotificationDeliveryKind } from '../messaging/messaging.constants';
import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { Prisma } from '@prisma/notification-delivery-client';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const HEARTBEAT_INTERVAL_MS = 10_000;
const SERVICE_NAME = 'notification-delivery-worker';

@Injectable()
export class NotificationDeliveryHeartbeatService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(
		NotificationDeliveryHeartbeatService.name
	);
	private readonly instanceId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private readonly startedAt = new Date();
	private timer: NodeJS.Timeout | null = null;
	private lastSuccessfulConsumeAt: Date | null = null;
	private lastSuccessfulPublishAt: Date | null = null;
	private consumerKinds: readonly NotificationDeliveryKind[] = [];
	private stopped = false;

	constructor(
		private readonly prisma: NotificationDeliveryPrismaService
	) {}

	async onModuleInit(): Promise<void> {
		await this.persist();
		this.timer = setInterval(
			() => void this.persist(),
			HEARTBEAT_INTERVAL_MS
		);
		this.timer.unref();
	}

	markSuccessfulConsume(): void {
		this.lastSuccessfulConsumeAt = new Date();
	}

	markSuccessfulPublish(): void {
		this.lastSuccessfulPublishAt = new Date();
	}

	setConsumerKinds(kinds: readonly NotificationDeliveryKind[]): void {
		this.consumerKinds = [...kinds];
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		await this.persist().catch(() => undefined);
	}

	private async persist(): Promise<void> {
		const now = new Date();
		const metadata = {
			startedAt: this.startedAt.toISOString(),
			status: this.stopped ? 'stopping' : 'running',
			lastSuccessfulConsumeAt:
				this.lastSuccessfulConsumeAt?.toISOString() || null,
			lastSuccessfulPublishAt:
				this.lastSuccessfulPublishAt?.toISOString() || null,
			consumerKinds: [...this.consumerKinds]
		} as Prisma.InputJsonObject;

		try {
			await this.prisma.notificationDeliveryHeartbeat.upsert({
				where: {
					service_instanceId: {
						service: SERVICE_NAME,
						instanceId: this.instanceId
					}
				},
				create: {
					service: SERVICE_NAME,
					instanceId: this.instanceId,
					metadata,
					lastSeenAt: now
				},
				update: {
					metadata,
					lastSeenAt: now
				}
			});
		} catch (error) {
			this.logger.warn(
				`Could not persist notification delivery heartbeat: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}
}
