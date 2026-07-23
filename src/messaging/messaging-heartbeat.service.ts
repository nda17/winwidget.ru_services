import { PrismaService } from '@/prisma.service';
import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

@Injectable()
export class MessagingHeartbeatService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(MessagingHeartbeatService.name);
	private readonly instanceId = `${hostname()}:${process.pid}:${randomUUID()}`;
	private readonly serviceName: string;
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly prisma: PrismaService,
		private readonly configService: ConfigService
	) {
		this.serviceName =
			this.configService.get<string>('MESSAGING_SERVICE_NAME')?.trim() ||
			'unknown';
	}

	async onModuleInit(): Promise<void> {
		await this.touch();
		this.timer = setInterval(() => void this.touch(), 10_000);
		this.timer.unref();
	}

	async onApplicationShutdown(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		await this.prisma.messagingHeartbeat
			.deleteMany({
				where: {
					service: this.serviceName,
					instanceId: this.instanceId
				}
			})
			.catch(() => undefined);
	}

	private async touch(): Promise<void> {
		try {
			await this.prisma.messagingHeartbeat.upsert({
				where: {
					service_instanceId: {
						service: this.serviceName,
						instanceId: this.instanceId
					}
				},
				create: {
					service: this.serviceName,
					instanceId: this.instanceId,
					metadata: {
						hostname: hostname(),
						pid: process.pid
					}
				},
				update: {
					lastSeenAt: new Date(),
					metadata: {
						hostname: hostname(),
						pid: process.pid
					}
				}
			});

			await this.prisma.messagingHeartbeat.deleteMany({
				where: {
					lastSeenAt: {
						lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
					}
				}
			});
		} catch (error) {
			this.logger.warn(
				`Heartbeat update failed service=${this.serviceName}: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}
}
