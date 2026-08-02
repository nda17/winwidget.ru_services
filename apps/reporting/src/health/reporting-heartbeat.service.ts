import { ReportingPrismaService } from '../prisma/reporting-prisma.service';
import { ReportingRuntimeService } from '../runtime/reporting-runtime.service';
import { waitForReportingShutdown } from '../common/reporting-shutdown';
import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { Prisma } from '@prisma/reporting-client';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const HEARTBEAT_INTERVAL_MS = 10_000;

@Injectable()
export class ReportingHeartbeatService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(ReportingHeartbeatService.name);
	private readonly instanceId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private readonly startedAt = new Date();
	private timer: NodeJS.Timeout | null = null;
	private stopping = false;

	constructor(
		private readonly prisma: ReportingPrismaService,
		private readonly runtime: ReportingRuntimeService
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
		await waitForReportingShutdown(
			this.persist().catch(() => undefined),
			2_000
		);
	}

	private async persist(): Promise<void> {
		const metadata = {
			startedAt: this.startedAt.toISOString(),
			status: this.stopping ? 'stopping' : 'running',
			revision: process.env.APP_REVISION || 'unknown',
			schedulerEnabled: this.runtime.schedulerEnabled
		} as Prisma.InputJsonObject;
		try {
			await this.prisma.reportingHeartbeat.upsert({
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
				`Could not persist reporting heartbeat: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}
}
