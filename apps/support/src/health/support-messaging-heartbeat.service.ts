import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { hostname } from 'node:os';
import { safeError } from '../common/support-request-context';
import { SupportPrismaService } from '../prisma/support-prisma.service';
import { SupportRuntimeService } from '../runtime/support-runtime.service';

const HEARTBEAT_INTERVAL_MS = 30_000;

@Injectable()
export class SupportMessagingHeartbeatService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(
		SupportMessagingHeartbeatService.name
	);
	private readonly instanceId = `${hostname()}:${process.pid}`;
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly prisma: SupportPrismaService,
		private readonly runtime: SupportRuntimeService
	) {}

	async onModuleInit(): Promise<void> {
		await this.beat();
		this.timer = setInterval(() => {
			void this.beat().catch(error => {
				this.logger.error(`Support heartbeat failed: ${safeError(error)}`);
			});
		}, HEARTBEAT_INTERVAL_MS);
		this.timer.unref();
	}

	onApplicationShutdown(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	private async beat(): Promise<void> {
		const service = `support-${
			this.runtime.role === 'outbox-publisher'
				? 'outbox-publisher'
				: this.runtime.role
		}`;
		await this.prisma.messagingHeartbeat.upsert({
			where: {
				service_instanceId: { service, instanceId: this.instanceId }
			},
			update: {
				revision: process.env.APP_REVISION || 'unknown',
				lastSeenAt: new Date()
			},
			create: {
				service,
				instanceId: this.instanceId,
				revision: process.env.APP_REVISION || 'unknown'
			}
		});
	}
}
