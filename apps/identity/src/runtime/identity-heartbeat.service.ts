import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { Prisma } from '@prisma/identity-client';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { safeError } from '../common/identity.util';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { IdentityRuntimeService } from './identity-runtime.service';

const HEARTBEAT_INTERVAL_MS = 10_000;

@Injectable()
export class IdentityHeartbeatService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(IdentityHeartbeatService.name);
	private readonly instanceId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private readonly startedAt = new Date();
	private timer: NodeJS.Timeout | null = null;
	private stopping = false;
	private ready = false;

	constructor(
		private readonly prisma: IdentityPrismaService,
		private readonly runtime: IdentityRuntimeService
	) {}

	async onModuleInit(): Promise<void> {
		await this.persist();
		this.timer = setInterval(
			() => void this.persist(),
			HEARTBEAT_INTERVAL_MS
		);
		this.timer.unref();
	}

	isReady(): boolean {
		return this.ready;
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopping = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.persist().catch(() => undefined);
		this.ready = false;
	}

	private async persist(): Promise<void> {
		const metadata = {
			startedAt: this.startedAt.toISOString(),
			status: this.stopping ? 'stopping' : 'running',
			revision: process.env.APP_REVISION || 'unknown'
		} satisfies Prisma.InputJsonObject;
		try {
			await this.prisma.identityHeartbeat.upsert({
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
			this.ready = true;
		} catch (error) {
			this.ready = false;
			this.logger.warn(`Identity heartbeat failed: ${safeError(error)}`);
		}
	}
}
