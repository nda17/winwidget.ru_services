import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OperationsPrismaService } from '../prisma/operations-prisma.service';
import { OperationsRuntimeService } from '../runtime/operations-runtime.service';

@Injectable()
export class OperationsHeartbeatService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(OperationsHeartbeatService.name);
	private readonly instanceId = randomUUID();
	private timer: NodeJS.Timeout | null = null;
	private lastSuccessAt: Date | null = null;

	constructor(
		private readonly prisma: OperationsPrismaService,
		private readonly runtime: OperationsRuntimeService
	) {}

	async onModuleInit(): Promise<void> {
		await this.beat().catch(() => undefined);
		this.timer = setInterval(() => void this.beat(), 10_000);
		this.timer.unref();
	}

	onApplicationShutdown(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	isReady(now = Date.now()): boolean {
		return Boolean(
			this.lastSuccessAt && now - this.lastSuccessAt.getTime() <= 30_000
		);
	}

	private async beat(): Promise<void> {
		const now = new Date();
		try {
			await this.prisma.messagingHeartbeat.upsert({
				where: {
					service_instanceId: {
						service: `operations-${this.runtime.role}`,
						instanceId: this.instanceId
					}
				},
				create: {
					service: `operations-${this.runtime.role}`,
					instanceId: this.instanceId,
					lastSeenAt: now,
					metadata: {
						revision: process.env.APP_REVISION || 'unknown',
						role: this.runtime.role
					}
				},
				update: {
					lastSeenAt: now,
					metadata: {
						revision: process.env.APP_REVISION || 'unknown',
						role: this.runtime.role
					}
				}
			});
			this.lastSuccessAt = now;
		} catch {
			this.logger.warn('Operations heartbeat update failed');
		}
	}
}
