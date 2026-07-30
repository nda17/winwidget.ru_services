import { CampaignsPrismaService } from '../prisma/campaigns-prisma.service';
import { CampaignsRuntimeService } from '../runtime/campaigns-runtime.service';
import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { Prisma } from '@prisma/campaigns-client';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const HEARTBEAT_INTERVAL_MS = 10_000;

@Injectable()
export class CampaignsHeartbeatService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(CampaignsHeartbeatService.name);
	private readonly instanceId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private readonly startedAt = new Date();
	private timer: NodeJS.Timeout | null = null;
	private stopping = false;

	constructor(
		private readonly prisma: CampaignsPrismaService,
		private readonly runtime: CampaignsRuntimeService
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
		await this.persist().catch(() => undefined);
	}

	private async persist(): Promise<void> {
		const metadata = {
			startedAt: this.startedAt.toISOString(),
			status: this.stopping ? 'stopping' : 'running',
			revision: process.env.APP_REVISION || 'unknown'
		} as Prisma.InputJsonObject;
		try {
			await this.prisma.campaignHeartbeat.upsert({
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
				update: {
					metadata,
					lastSeenAt: new Date()
				}
			});
		} catch (error) {
			this.logger.warn(
				`Could not persist campaigns heartbeat: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}
}
