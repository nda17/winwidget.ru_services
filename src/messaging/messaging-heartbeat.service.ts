import { PrismaService } from '@/prisma.service';
import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface MessagingHeartbeatMetadata {
	hostname?: string;
	pid?: number;
	lastSuccessfulPollAt?: string;
	lastSuccessfulPublishAt?: string;
	lastSuccessfulConsumeAt?: string;
	lastSuccessfulConsumeKind?: string;
}

export const parseMessagingHeartbeatMetadata = (
	value: Prisma.JsonValue
): MessagingHeartbeatMetadata => {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return {};
	const metadata = value as Prisma.JsonObject;
	const readString = (key: string): string | undefined =>
		typeof metadata[key] === 'string'
			? (metadata[key] as string)
			: undefined;
	const pid = metadata.pid;
	return {
		hostname: readString('hostname'),
		pid: typeof pid === 'number' ? pid : undefined,
		lastSuccessfulPollAt: readString('lastSuccessfulPollAt'),
		lastSuccessfulPublishAt: readString('lastSuccessfulPublishAt'),
		lastSuccessfulConsumeAt: readString('lastSuccessfulConsumeAt'),
		lastSuccessfulConsumeKind: readString('lastSuccessfulConsumeKind')
	};
};

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
	private lastSuccessfulPollAt: Date | null = null;
	private lastSuccessfulPublishAt: Date | null = null;
	private lastSuccessfulConsumeAt: Date | null = null;
	private lastSuccessfulConsumeKind: string | null = null;

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

	markSuccessfulPoll(at = new Date()): void {
		this.lastSuccessfulPollAt = at;
	}

	markSuccessfulPublish(at = new Date()): void {
		this.lastSuccessfulPublishAt = at;
	}

	markSuccessfulConsume(kind: string, at = new Date()): void {
		this.lastSuccessfulConsumeAt = at;
		this.lastSuccessfulConsumeKind = kind;
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
			const metadata: Prisma.InputJsonObject = {
				hostname: hostname(),
				pid: process.pid,
				...(this.lastSuccessfulPollAt
					? {
							lastSuccessfulPollAt: this.lastSuccessfulPollAt.toISOString()
						}
					: {}),
				...(this.lastSuccessfulPublishAt
					? {
							lastSuccessfulPublishAt:
								this.lastSuccessfulPublishAt.toISOString()
						}
					: {}),
				...(this.lastSuccessfulConsumeAt
					? {
							lastSuccessfulConsumeAt:
								this.lastSuccessfulConsumeAt.toISOString(),
							lastSuccessfulConsumeKind:
								this.lastSuccessfulConsumeKind || undefined
						}
					: {})
			};
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
					metadata
				},
				update: {
					lastSeenAt: new Date(),
					metadata
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
