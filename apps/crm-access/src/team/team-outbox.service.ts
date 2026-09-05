import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CrmAccessPrismaService } from '../prisma/crm-access-prisma.service';
import { CrmAccessRuntimeService } from '../runtime/crm-access-runtime.service';
import { CrmTeamRabbitService } from './team-rabbit.service';

@Injectable()
export class CrmTeamOutboxService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(CrmTeamOutboxService.name);
	private timer: NodeJS.Timeout | null = null;
	private currentTick: Promise<void> | null = null;
	private stopping = false;
	private lastTick = 0;
	constructor(
		private readonly prisma: CrmAccessPrismaService,
		private readonly runtime: CrmAccessRuntimeService,
		private readonly rabbit: CrmTeamRabbitService
	) {}
	onModuleInit() {
		if (!this.runtime.publisherEnabled) return;
		this.timer = setInterval(() => void this.tick(), 1000);
		this.timer.unref();
		void this.tick();
	}
	isReady() {
		return (
			!this.runtime.publisherEnabled || Date.now() - this.lastTick < 90_000
		);
	}
	async beforeApplicationShutdown() {
		this.stopping = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.currentTick;
		this.lastTick = 0;
	}
	async publishOne(): Promise<boolean> {
		const now = new Date();
		const where = {
			availableAt: { lte: now },
			OR: [
				{ status: 'PENDING' },
				{ status: 'PROCESSING', leaseExpiresAt: { lte: now } }
			]
		};
		const candidate = await this.prisma.crmTeamOutbox.findFirst({
			where,
			orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }]
		});
		if (!candidate) return false;
		const leaseToken = randomUUID();
		const claimed = await this.prisma.crmTeamOutbox.updateMany({
			where: { ...where, id: candidate.id },
			data: {
				status: 'PROCESSING',
				leaseToken,
				leaseExpiresAt: new Date(Date.now() + 30_000),
				attempts: { increment: 1 }
			}
		});
		if (claimed.count !== 1) return true;
		try {
			const headers =
				candidate.headers &&
				typeof candidate.headers === 'object' &&
				!Array.isArray(candidate.headers)
					? Object.fromEntries(
							Object.entries(candidate.headers).filter(([, value]) =>
								['string', 'number', 'boolean'].includes(typeof value)
							)
						)
					: {};
			await this.rabbit.publish(
				candidate.exchange,
				candidate.routingKey,
				candidate.payload,
				{
					messageId: candidate.messageId,
					type: candidate.eventType,
					headers
				}
			);
			const changed = await this.prisma.crmTeamOutbox.updateMany({
				where: { id: candidate.id, status: 'PROCESSING', leaseToken },
				data: {
					status: 'PUBLISHED',
					publishedAt: new Date(),
					leaseToken: null,
					leaseExpiresAt: null,
					lastError: null
				}
			});
			if (changed.count !== 1) throw new Error('OUTBOX_LEASE_LOST');
		} catch {
			await this.prisma.crmTeamOutbox.updateMany({
				where: { id: candidate.id, status: 'PROCESSING', leaseToken },
				data: {
					status: 'PENDING',
					availableAt: new Date(
						Date.now() +
							Math.min(
								1000 * 2 ** Math.min(candidate.attempts + 1, 10),
								900_000
							)
					),
					leaseToken: null,
					leaseExpiresAt: null,
					lastError: 'PUBLISH_UNCONFIRMED'
				}
			});
		}
		return true;
	}
	private tick() {
		if (this.currentTick || this.stopping) return;
		this.currentTick = this.runTick().finally(() => {
			this.currentTick = null;
		});
	}
	private async runTick() {
		try {
			for (let count = 0; count < 20 && !this.stopping; count++) {
				if (!(await this.publishOne())) break;
				this.lastTick = Date.now();
			}
			this.lastTick = Date.now();
		} catch {
			this.logger.error('CRM team outbox transaction failed');
		}
	}
}
