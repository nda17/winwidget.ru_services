import {
	Injectable,
	Logger,
	OnApplicationShutdown,
	OnModuleInit
} from '@nestjs/common';
import { AvatarMediaObjectStatus } from '@prisma/identity-client';
import { randomUUID } from 'node:crypto';
import { safeError } from '../common/identity.util';
import { IdentityPrismaService } from '../prisma/identity-prisma.service';
import { IdentityOwnershipService } from '../runtime/identity-ownership.service';
import { AvatarStorageService } from './avatar-storage.service';

const LEASE_MS = 30_000;
const IDLE_INTERVAL_MS = 30_000;
const DELETE_CONFIRMATION_DELAY_MS = 60_000;
const BATCH_SIZE = 20;

@Injectable()
export class AvatarCleanupService
	implements OnModuleInit, OnApplicationShutdown
{
	private readonly logger = new Logger(AvatarCleanupService.name);
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private stopping = false;

	constructor(
		private readonly prisma: IdentityPrismaService,
		private readonly ownership: IdentityOwnershipService,
		private readonly storage: AvatarStorageService
	) {}

	onModuleInit(): void {
		this.schedule(0);
	}

	onApplicationShutdown(): void {
		this.stopping = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	kick(): void {
		if (this.stopping || this.running) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.schedule(0);
	}

	async deleteNow(id: string): Promise<void> {
		if (!(await this.ownership.isActive())) return;
		await this.processOne(id);
	}

	async runOnce(): Promise<number> {
		let processed = 0;
		for (; processed < BATCH_SIZE; processed += 1) {
			if (!(await this.processOne())) break;
		}
		return processed;
	}

	private async tick(): Promise<void> {
		if (this.running || this.stopping) return;
		this.running = true;
		try {
			if (await this.ownership.isActive()) await this.runOnce();
		} catch {
			this.logger.warn('Avatar cleanup tick failed');
		} finally {
			this.running = false;
			this.schedule(IDLE_INTERVAL_MS);
		}
	}

	private schedule(delay: number): void {
		if (this.stopping || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.tick();
		}, delay);
		this.timer.unref();
	}

	private async processOne(id?: string): Promise<boolean> {
		const now = new Date();
		const eligible = [
			{
				status: AvatarMediaObjectStatus.PREPARED,
				availableAt: { lte: now }
			},
			{
				status: AvatarMediaObjectStatus.DELETE_PENDING,
				availableAt: { lte: now }
			},
			{
				status: AvatarMediaObjectStatus.DELETING,
				leaseExpiresAt: { lte: now }
			}
		];
		const candidate = await this.prisma.avatarMediaObject.findFirst({
			where: { ...(id ? { id } : {}), OR: eligible },
			orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }]
		});
		if (!candidate) return false;

		const leaseToken = randomUUID();
		const claimed = await this.prisma.avatarMediaObject.updateMany({
			where: { id: candidate.id, OR: eligible },
			data: {
				status: AvatarMediaObjectStatus.DELETING,
				attempts: { increment: 1 },
				leaseToken,
				leaseExpiresAt: new Date(now.getTime() + LEASE_MS)
			}
		});
		if (claimed.count !== 1) return true;

		const object = await this.prisma.avatarMediaObject.findUniqueOrThrow({
			where: { id: candidate.id }
		});
		try {
			const referenced = await this.prisma.user.count({
				where: { id: object.userId, avatarPath: object.publicUrl }
			});
			if (referenced === 1) {
				await this.prisma.avatarMediaObject.updateMany({
					where: {
						id: object.id,
						status: AvatarMediaObjectStatus.DELETING,
						leaseToken
					},
					data: {
						status: AvatarMediaObjectStatus.ACTIVE,
						deletePasses: 0,
						leaseToken: null,
						leaseExpiresAt: null,
						lastError: null
					}
				});
				return true;
			}
			await this.storage.deleteObject(object.objectKey);
			if (object.deletePasses < 1) {
				await this.prisma.avatarMediaObject.updateMany({
					where: {
						id: object.id,
						status: AvatarMediaObjectStatus.DELETING,
						leaseToken
					},
					data: {
						status: AvatarMediaObjectStatus.DELETE_PENDING,
						deletePasses: { increment: 1 },
						availableAt: new Date(
							Date.now() + DELETE_CONFIRMATION_DELAY_MS
						),
						leaseToken: null,
						leaseExpiresAt: null,
						lastError: null
					}
				});
				return true;
			}
			const removed = await this.prisma.avatarMediaObject.deleteMany({
				where: {
					id: object.id,
					status: AvatarMediaObjectStatus.DELETING,
					leaseToken
				}
			});
			if (removed.count !== 1) {
				throw new Error('Avatar cleanup lease was lost');
			}
		} catch (error) {
			const delay = Math.min(
				1_000 * 2 ** Math.min(object.attempts, 10),
				15 * 60_000
			);
			await this.prisma.avatarMediaObject.updateMany({
				where: {
					id: object.id,
					status: AvatarMediaObjectStatus.DELETING,
					leaseToken
				},
				data: {
					status: AvatarMediaObjectStatus.DELETE_PENDING,
					availableAt: new Date(Date.now() + delay),
					leaseToken: null,
					leaseExpiresAt: null,
					lastError: safeError(error)
				}
			});
			this.logger.warn('Avatar cleanup retry scheduled');
		}
		return true;
	}
}
