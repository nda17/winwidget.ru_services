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
	private touchPromise: Promise<void> | null = null;
	private shuttingDown = false;

	constructor(
		private readonly prisma: PrismaService,
		private readonly configService: ConfigService
	) {
		this.serviceName =
			this.configService.get<string>('MESSAGING_SERVICE_NAME')?.trim() ||
			'unknown';
	}

	async onModuleInit(): Promise<void> {
		await this.runTouch();
		this.timer = setInterval(() => void this.runTouch(), 10_000);
		this.timer.unref();
	}

	async onApplicationShutdown(): Promise<void> {
		this.shuttingDown = true;
		if (this.timer) clearInterval(this.timer);
		await this.touchPromise;
		await this.prisma.messagingHeartbeat
			.deleteMany({
				where: {
					service: this.serviceName,
					instanceId: this.instanceId
				}
			})
			.catch(() => undefined);
	}

	private runTouch(): Promise<void> {
		if (this.shuttingDown) return Promise.resolve();
		if (this.touchPromise) return this.touchPromise;

		const promise = this.touch();
		this.touchPromise = promise;
		void promise.then(
			() => {
				if (this.touchPromise === promise) this.touchPromise = null;
			},
			() => {
				if (this.touchPromise === promise) this.touchPromise = null;
			}
		);
		return promise;
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
