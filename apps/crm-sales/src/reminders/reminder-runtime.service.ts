import {
	BeforeApplicationShutdown,
	Injectable,
	Logger,
	OnModuleInit
} from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { TaskSeriesGenerationService } from '../recurring-tasks/task-series-generation.service';
import { SERIES_SCAN_PREFIX } from '../recurring-tasks/task-series.service';
import { CrmSalesPrismaService } from '../prisma/crm-sales-prisma.service';
import { UUID } from '../sales/sales-access';
import {
	enqueueReminderJob,
	ReminderDeliveryService
} from './reminder-delivery.service';
import { ReminderRabbitService } from './reminder-rabbit.service';
import { ReminderReadinessService } from './reminder-readiness.service';
import { exactReminderObject } from './reminder-recipients.client';
import {
	reminderDeliveryEnabled,
	REMINDER_TICK
} from './reminder-delivery.contract';

const LEASE_MS = 60_000;
@Injectable()
export class ReminderRuntimeService
	implements OnModuleInit, BeforeApplicationShutdown
{
	private readonly logger = new Logger(ReminderRuntimeService.name);
	private timer: NodeJS.Timeout | null = null;
	private tick: Promise<void> | null = null;
	private stopping = false;
	private transportReady = false;
	private checkedAt = 0;
	private lastTick = 0;
	private readonly handlers = new Set<Promise<void>>();
	constructor(
		private readonly prisma: CrmSalesPrismaService,
		private readonly rabbit: ReminderRabbitService,
		private readonly delivery: ReminderDeliveryService,
		private readonly readiness: ReminderReadinessService,
		private readonly series: TaskSeriesGenerationService
	) {}
	async onModuleInit() {
		if (!reminderDeliveryEnabled())
			throw new Error('REMINDER_RUNTIME_NOT_ENABLED');
		let timeout: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				this.rabbit.consume(message => {
					const work = this.handle(message).finally(() =>
						this.handlers.delete(work)
					);
					this.handlers.add(work);
					return work;
				}),
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(
						() => reject(new Error('REMINDER_CONSUMER_START_TIMEOUT')),
						20_000
					);
				})
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		this.timer = setInterval(() => this.startTick(), 1000);
		this.timer.unref();
		this.startTick();
	}
	isReady() {
		return (
			!this.stopping &&
			this.rabbit.isReady() &&
			this.lastTick > Date.now() - 45_000
		);
	}
	private startTick() {
		if (this.stopping || this.tick) return;
		this.tick = this.runTick()
			.catch(() => this.logger.error('CRM reminder runtime tick failed'))
			.finally(() => {
				this.tick = null;
			});
	}
	private async runTick() {
		if (Date.now() - this.checkedAt > 10_000) {
			this.transportReady = await this.readiness.transportReady();
			this.checkedAt = Date.now();
			await this.prisma.reminderRuntime.upsert({
				where: { id: 'reminders' },
				create: {
					id: 'reminders',
					revision: process.env.APP_REVISION || 'unknown',
					ready: this.transportReady && this.rabbit.isReady(),
					lastSeenAt: new Date()
				},
				update: {
					revision: process.env.APP_REVISION || 'unknown',
					ready: this.transportReady && this.rabbit.isReady(),
					lastSeenAt: new Date()
				}
			});
		}
		// Series retain their runtime switch and fresh Access authority, but do
		// not depend on external delivery. Only internal wakes bypass its gate.
		await this.series.schedulePeriod();
		if (this.transportReady) await this.delivery.schedulePeriod();
		for (let n = 0; n < 20 && !this.stopping; n++)
			if (!(await this.publishOne())) break;
		this.lastTick = Date.now();
	}
	async publishOne() {
		const now = new Date();
		const available = {
			...(!this.transportReady ? { eventType: REMINDER_TICK } : {}),
			availableAt: { lte: now },
			OR: [
				{ status: 'PENDING' },
				{ status: 'PROCESSING', leaseExpiresAt: { lte: now } }
			]
		};
		const row = await this.prisma.reminderOutbox.findFirst({
			where: available,
			orderBy: [
				{ availableAt: 'asc' },
				{ createdAt: 'asc' },
				{ id: 'asc' }
			]
		});
		if (!row) return false;
		const leaseToken = randomUUID();
		const changed = await this.prisma.reminderOutbox.updateMany({
			where: { id: row.id, ...available },
			data: {
				status: 'PROCESSING',
				leaseToken,
				leaseExpiresAt: new Date(Date.now() + 30_000),
				attempts: { increment: 1 }
			}
		});
		if (changed.count !== 1) return true;
		try {
			await this.rabbit.publish(row.messageId, row.eventType, row.payload);
			const published = await this.prisma.reminderOutbox.updateMany({
				where: {
					id: row.id,
					status: 'PROCESSING',
					leaseToken,
					leaseExpiresAt: { gt: new Date() }
				},
				data: {
					status: 'PUBLISHED',
					publishedAt: new Date(),
					leaseToken: null,
					leaseExpiresAt: null
				}
			});
			if (published.count !== 1)
				throw new Error('REMINDER_OUTBOX_LEASE_LOST');
		} catch {
			await this.prisma.reminderOutbox.updateMany({
				where: { id: row.id, status: 'PROCESSING', leaseToken },
				data: {
					status: 'PENDING',
					availableAt: new Date(
						Date.now() +
							Math.min(900_000, 1000 * 2 ** Math.min(row.attempts + 1, 10))
					),
					leaseToken: null,
					leaseExpiresAt: null
				}
			});
		}
		return true;
	}
	async handle(message: ConsumeMessage) {
		if (this.stopping) {
			this.rabbit.nack(message);
			return;
		}
		let jobId: string;
		try {
			if (
				message.content.length > 2048 ||
				message.properties.type !== REMINDER_TICK ||
				message.fields.routingKey !== REMINDER_TICK
			)
				throw new Error();
			const value: unknown = JSON.parse(message.content.toString('utf8'));
			if (
				!exactReminderObject(value, [
					'schemaVersion',
					'eventId',
					'eventType',
					'occurredAt',
					'jobId'
				]) ||
				value.schemaVersion !== 1 ||
				value.eventType !== REMINDER_TICK ||
				value.eventId !== message.properties.messageId ||
				typeof value.eventId !== 'string' ||
				!UUID.test(value.eventId) ||
				typeof value.jobId !== 'string' ||
				!UUID.test(value.jobId) ||
				typeof value.occurredAt !== 'string' ||
				new Date(value.occurredAt).toISOString() !== value.occurredAt
			)
				throw new Error();
			jobId = value.jobId;
		} catch {
			this.rabbit.nack(message, false);
			return;
		}
		let job = await this.prisma.reminderJob.findUnique({
			where: { id: jobId }
		});
		if (!job || job.status === 'COMPLETED') {
			this.rabbit.ack(message);
			return;
		}
		const now = new Date(),
			leaseToken = randomUUID();
		const available = {
			id: jobId,
			availableAt: { lte: now },
			OR: [
				{ status: 'PENDING' },
				{ status: 'PROCESSING', leaseExpiresAt: { lte: now } }
			]
		};
		const claim = await this.prisma.reminderJob.updateMany({
			where: available,
			data: {
				status: 'PROCESSING',
				leaseToken,
				leaseExpiresAt: new Date(Date.now() + LEASE_MS),
				attempts: { increment: 1 }
			}
		});
		if (claim.count !== 1) {
			// A delivery after crash-before-lease-expiry must retain a durable wake-up.
			job = await this.prisma.reminderJob.findUnique({
				where: { id: jobId }
			});
			if (job && job.status !== 'COMPLETED')
				await this.prisma.$transaction(tx =>
					enqueueReminderJob(
						tx,
						jobId,
						new Date(
							Math.max(
								Date.now() + 1000,
								job!.availableAt.getTime(),
								job!.leaseExpiresAt?.getTime() ?? 0
							)
						)
					)
				);
			this.rabbit.ack(message);
			return;
		}
		let owned = true,
			renewal: Promise<void> | null = null;
		const timer = setInterval(() => {
			if (renewal || !owned) return;
			renewal = this.prisma.reminderJob
				.updateMany({
					where: {
						id: jobId,
						status: 'PROCESSING',
						leaseToken,
						leaseExpiresAt: { gt: new Date() }
					},
					data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) }
				})
				.then(result => {
					if (result.count !== 1) owned = false;
				})
				.catch(() => {
					owned = false;
				})
				.finally(() => {
					renewal = null;
				});
		}, 15_000);
		timer.unref();
		try {
			await (
				job.periodKey.startsWith(SERIES_SCAN_PREFIX)
					? this.series
					: this.delivery
			).processPage(job, leaseToken, () => owned && !this.stopping);
			this.rabbit.ack(message);
		} catch {
			await this.prisma.$transaction(async tx => {
				const retry = await tx.reminderJob.updateMany({
					where: {
						id: jobId,
						status: 'PROCESSING',
						leaseToken,
						leaseExpiresAt: { gt: new Date() }
					},
					data: {
						status: 'PENDING',
						leaseToken: null,
						leaseExpiresAt: null,
						availableAt: new Date(
							Date.now() +
								Math.min(300_000, 5000 * 2 ** Math.min(job!.attempts, 6))
						)
					}
				});
				if (retry.count !== 1) throw new Error('REMINDER_JOB_LEASE_LOST');
				const current = await tx.reminderJob.findUniqueOrThrow({
					where: { id: jobId }
				});
				await enqueueReminderJob(tx, jobId, current.availableAt);
			});
			this.rabbit.ack(message);
		} finally {
			clearInterval(timer);
			if (renewal) await renewal;
		}
	}
	async beforeApplicationShutdown() {
		this.stopping = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.rabbit.stopConsumers().catch(() => undefined);
		await this.tick;
		await this.prisma.reminderRuntime
			.updateMany({
				where: { id: 'reminders' },
				data: { ready: false, lastSeenAt: new Date() }
			})
			.catch(() => undefined);
		let timeout: NodeJS.Timeout | undefined;
		await Promise.race([
			Promise.allSettled([...this.handlers]),
			new Promise<void>(resolve => {
				timeout = setTimeout(resolve, 15_000);
			})
		]);
		if (timeout) clearTimeout(timeout);
	}
}
