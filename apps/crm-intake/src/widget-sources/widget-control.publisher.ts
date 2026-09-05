import {
	Injectable,
	BeforeApplicationShutdown,
	OnApplicationBootstrap
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/crm-intake-client';
import { CONTROL_RETRY_MS } from './widget-control.contract';
import { CrmIntakePrismaService } from '../prisma/crm-intake-prisma.service';
import { parseControlEvent } from './widget-control.contract';
import { WidgetControlRabbit } from './widget-control.messaging';

@Injectable()
export class WidgetControlPublisher
	implements OnApplicationBootstrap, BeforeApplicationShutdown
{
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;
	private stopping = false;
	constructor(
		private readonly prisma: CrmIntakePrismaService,
		private readonly rabbit: WidgetControlRabbit
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
		const now = await this.databaseNow();
		await this.prisma.widgetControlOutbox.updateMany({
			where: { status: 'PUBLISHING', leaseUntil: { lte: now } },
			data: { status: 'PENDING', leaseToken: null, leaseUntil: null }
		});
		const candidates = await this.prisma.widgetControlOutbox.findMany({
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
			const claim = await this.prisma.widgetControlOutbox.updateMany({
				where: {
					id: candidate.id,
					status: 'PENDING',
					...this.due(claimNow)
				},
				data: { status: 'PUBLISHING', leaseToken: token, leaseUntil }
			});
			if (claim.count !== 1) continue;
			const row = await this.prisma.widgetControlOutbox.findUnique({
				where: { id: candidate.id }
			});
			if (!row || row.leaseToken !== token) continue;
			try {
				const event = parseControlEvent(row.payload);
				if (event.eventId !== row.eventId)
					throw new Error('INVALID_OUTBOX_BINDING');
				// Legacy immutable RETRY_N rows are delivered directly, only after their
				// original delay; no new publications use the classic TTL/DLX relay.
				const legacy = /^RETRY_([123])$/.exec(row.route);
				if (legacy && row.retryAttempt !== Number(legacy[1]))
					throw new Error('INVALID_LEGACY_RETRY_BINDING');
				await this.rabbit.publish(
					event,
					legacy ? 'MAIN' : row.route,
					row.retryAttempt
				);
				const confirmedAt = await this.databaseNow();
				await this.prisma.widgetControlOutbox.updateMany({
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
				await this.prisma.widgetControlOutbox.updateMany({
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
	private due(now: Date): Prisma.WidgetControlOutboxWhereInput {
		// Filter before LIMIT so future legacy rows cannot starve ready MAIN work.
		return {
			OR: [
				{ route: { in: ['MAIN', 'DLQ'] }, availableAt: { lte: now } },
				...CONTROL_RETRY_MS.map((delay, index) => ({
					route: `RETRY_${index + 1}`,
					availableAt: { lte: new Date(now.getTime() - delay) }
				}))
			]
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
