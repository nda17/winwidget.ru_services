import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { Prisma } from '@prisma/widgets-client';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { waitForWidgetsShutdown } from '../common/widgets-shutdown';
import { WidgetsPrismaService } from '../prisma/widgets-prisma.service';
import { WidgetsRuntimeService } from '../runtime/widgets-runtime.service';

const HEARTBEAT_INTERVAL_MS = 10_000;

@Injectable()
export class WidgetsHeartbeatService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(WidgetsHeartbeatService.name);
	private readonly instanceId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private readonly startedAt = new Date();
	private timer: NodeJS.Timeout | null = null;
	private stopping = false;

	constructor(
		private readonly prisma: WidgetsPrismaService,
		private readonly runtime: WidgetsRuntimeService
	) {}

	async onModuleInit(): Promise<void> {
		await this.persist();
		this.timer = setInterval(
			() => void this.persist(),
			HEARTBEAT_INTERVAL_MS
		);
		this.timer.unref();
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopping = true;
		if (this.timer) clearInterval(this.timer);
		await waitForWidgetsShutdown(
			this.persist().catch(() => undefined),
			2_000
		);
	}

	private async persist(): Promise<void> {
		const metadata = {
			startedAt: this.startedAt.toISOString(),
			status: this.stopping ? 'stopping' : 'running',
			revision: process.env.APP_REVISION || 'unknown'
		} satisfies Prisma.InputJsonObject;
		try {
			await this.prisma.widgetsHeartbeat.upsert({
				where: {
					role_instanceId: {
						role: this.runtime.role,
						instanceId: this.instanceId
					}
				},
				create: {
					role: this.runtime.role,
					instanceId: this.instanceId,
					metadata,
					lastSeenAt: new Date()
				},
				update: { metadata, lastSeenAt: new Date() }
			});
		} catch (error) {
			this.logger.warn(
				`Could not persist Widgets heartbeat: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}
}
