import {
	Injectable,
	BeforeApplicationShutdown,
	OnApplicationBootstrap
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/crm-intake-client';
import { SlaService } from './sla.service';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import { parseSlaEvent, parseSlaNotificationEvent } from './sla.contract';
import { SlaRabbit } from './sla.messaging';
import { SlaReadinessService } from './sla-readiness.service';

@Injectable()
export class SlaPublisher
	implements OnApplicationBootstrap, BeforeApplicationShutdown
{
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;
	private stopping = false;
	constructor(
		private readonly prisma: CrmIntakePrismaService,
		private readonly rabbit: SlaRabbit,
		private readonly service: SlaService,
		private readonly readiness: SlaReadinessService
	) {}
	async onApplicationBootstrap() {
		if (!(await this.readiness.ready()))
			throw new Error('SLA_DELIVERY_NOT_READY');
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
		// A temporarily locked rule must not block already committed publications.
		await this.service.schedule().catch(() => undefined);
		const now = await this.databaseNow();
		await this.prisma.slaOutbox.updateMany({
			where: { status: 'PUBLISHING', leaseUntil: { lte: now } },
			data: { status: 'PENDING', leaseToken: null, leaseUntil: null }
		});
		const candidates = await this.prisma.slaOutbox.findMany({
			where: { status: 'PENDING', ...this.due(now) },
			orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
			take: 20,
			select: { id: true }
		});
		for (const candidate of candidates) {
			if (this.stopping) break;
			const token = randomUUID();
			const claimNow = await this.databaseNow();
			const leaseUntil = new Date(claimNow.getTime() + 30000);
			const claim = await this.prisma.slaOutbox.updateMany({
				where: {
					id: candidate.id,
					status: 'PENDING',
					...this.due(claimNow)
				},
				data: { status: 'PUBLISHING', leaseToken: token, leaseUntil }
			});
			if (claim.count !== 1) continue;
			const row = await this.prisma.slaOutbox.findUnique({
				where: { id: candidate.id }
			});
			if (!row || row.leaseToken !== token) continue;
			try {
				const notification =
					row.route === 'ND_EMAIL' || row.route === 'ND_TELEGRAM';
				const event = notification
					? parseSlaNotificationEvent(row.payload)
					: parseSlaEvent(row.payload);
				if (event.eventId !== row.eventId)
					throw new Error('INVALID_OUTBOX_BINDING');
				if (notification)
					await this.rabbit.publishNotification(
						parseSlaNotificationEvent(event),
						row.route,
						row.retryAttempt
					);
				else
					await this.rabbit.publish(
						parseSlaEvent(event),
						row.route,
						row.retryAttempt
					);
				const confirmedAt = await this.databaseNow();
				await this.prisma.slaOutbox.updateMany({
					where: {
						id: row.id,
						status: 'PUBLISHING',
						leaseToken: token,
						leaseUntil: { gt: confirmedAt }
					},
					data: {
						status: 'PUBLISHED',
						publishedAt: confirmedAt,
						attempts: { increment: 1 },
						leaseToken: null,
						leaseUntil: null,
						lastErrorCode: null
					}
				});
			} catch {
				const failedAt = await this.databaseNow();
				await this.prisma.slaOutbox.updateMany({
					where: { id: row.id, status: 'PUBLISHING', leaseToken: token },
					data: {
						status: 'PENDING',
						attempts: { increment: 1 },
						leaseToken: null,
						leaseUntil: null,
						lastErrorCode: 'PUBLICATION_UNCONFIRMED',
						availableAt: new Date(
							failedAt.getTime() +
								Math.min(60000, 1000 * 2 ** Math.min(row.attempts, 6))
						)
					}
				});
			}
		}
	}
	private due(now: Date): Prisma.SlaOutboxWhereInput {
		return {
			route: { in: ['MAIN', 'DLQ', 'ND_EMAIL', 'ND_TELEGRAM'] },
			availableAt: { lte: now }
		};
	}
	private async databaseNow(): Promise<Date> {
		const [clock] = await this.prisma.$queryRaw<
			Array<{ now: Date }>
		>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
		if (!clock || !Number.isFinite(clock.now.getTime()))
			throw new Error('PUBLISHER_CLOCK_UNAVAILABLE');
		return clock.now;
	}
	async beforeApplicationShutdown() {
		this.stopping = true;
		if (this.timer) clearTimeout(this.timer);
		if (this.running) await this.running;
	}
}
