import {
	Injectable,
	BeforeApplicationShutdown,
	OnApplicationBootstrap
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import { parseAcceptanceEvent } from './acceptance.contract';
import { AcceptanceRabbit } from './acceptance.messaging';

@Injectable()
export class AcceptancePublisher
	implements OnApplicationBootstrap, BeforeApplicationShutdown
{
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;
	private stopping = false;
	constructor(
		private readonly prisma: CrmIntakePrismaService,
		private readonly rabbit: AcceptanceRabbit
	) {}
	onApplicationBootstrap() {
		this.schedule();
	}
	private schedule() {
		if (this.stopping) return;
		this.timer = setTimeout(() => {
			this.running = this.tick()
				.catch(() => undefined)
				.finally(() => {
					this.running = null;
					this.schedule();
				});
		}, 1000);
		this.timer.unref();
	}
	async tick() {
		const now = new Date();
		await this.prisma.acceptanceOutbox.updateMany({
			where: { status: 'PUBLISHING', leaseUntil: { lte: now } },
			data: { status: 'PENDING', leaseToken: null, leaseUntil: null }
		});
		const candidates = await this.prisma.acceptanceOutbox.findMany({
			where: { status: 'PENDING', availableAt: { lte: now } },
			orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
			take: 20,
			select: { id: true }
		});
		for (const candidate of candidates) {
			if (this.stopping) break;
			const token = randomUUID();
			const leaseUntil = new Date(Date.now() + 30000);
			const claim = await this.prisma.acceptanceOutbox.updateMany({
				where: {
					id: candidate.id,
					status: 'PENDING',
					availableAt: { lte: now }
				},
				data: { status: 'PUBLISHING', leaseToken: token, leaseUntil }
			});
			if (claim.count !== 1) continue;
			const row = await this.prisma.acceptanceOutbox.findUnique({
				where: { id: candidate.id }
			});
			if (!row || row.leaseToken !== token) continue;
			try {
				const event = parseAcceptanceEvent(row.payload);
				if (event.eventId !== row.eventId)
					throw new Error('INVALID_OUTBOX_BINDING');
				await this.rabbit.publish(event, row.route, row.retryAttempt);
				await this.prisma.acceptanceOutbox.updateMany({
					where: {
						id: row.id,
						status: 'PUBLISHING',
						leaseToken: token,
						leaseUntil: { gt: new Date() }
					},
					data: {
						status: 'PUBLISHED',
						publishedAt: new Date(),
						attempts: { increment: 1 },
						leaseToken: null,
						leaseUntil: null,
						lastErrorCode: null
					}
				});
			} catch {
				await this.prisma.acceptanceOutbox.updateMany({
					where: { id: row.id, status: 'PUBLISHING', leaseToken: token },
					data: {
						status: 'PENDING',
						attempts: { increment: 1 },
						leaseToken: null,
						leaseUntil: null,
						lastErrorCode: 'PUBLICATION_UNCONFIRMED',
						availableAt: new Date(
							Date.now() +
								Math.min(60000, 1000 * 2 ** Math.min(row.attempts, 6))
						)
					}
				});
			}
		}
	}
	async beforeApplicationShutdown() {
		this.stopping = true;
		if (this.timer) clearTimeout(this.timer);
		if (this.running) await this.running;
	}
}
